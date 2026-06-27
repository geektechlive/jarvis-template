#!/usr/bin/env python3
# SCRIPT: health-probe.py
# PURPOSE: Two passes, written every 60s into ~/.jarvis/conversations.db:
#   1. Service health — launchd service status, disk space, orphan ion processes;
#      one row per check into host_health.
#   2. Host metrics — M2 Mini CPU/load/memory/swap gauges, memory-pressure level
#      and compressor size, plus disk/network/swap I/O rates, one row per metric
#      into host_metrics, for bottleneck hunting.
#   3. Process metrics — the top processes by resident memory each probe (RSS
#      attribution: "what is actually holding RAM"), into host_process_metrics.
# DB TABLES:
#   host_health  (ts TEXT, service TEXT, status TEXT, detail TEXT)
#       Created here with CREATE TABLE IF NOT EXISTS; do not alter the schema.
#   host_metrics (ts TEXT, metric TEXT, value REAL, unit TEXT)
#       Long/narrow time-series; one row per metric per probe.
#   host_process_metrics (ts TEXT, pid INTEGER, name TEXT, rss_mb REAL)
#       Top-N processes by RSS per probe. Grafana reads all three via the
#       frser-sqlite datasource (dashboard: jarvis-host-metrics).
# DEPS: psutil, from the dedicated venv the LaunchAgent's interpreter points at
#       (~/Jarvis/.venvs/probe). If psutil is missing the metrics pass is skipped
#       with a warning — the service-health pass never depends on it.
# RUNS: every 60s via com.example.jarvis.health-probe LaunchAgent

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time as _time
from datetime import UTC, datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_PATH = Path.home() / ".jarvis" / "conversations.db"

# vec-server base URL for the memory-integrity probe (jarvis#811a).
VEC_SERVER_URL = os.environ.get("VEC_SERVER", "http://127.0.0.1:9876")

# Service descriptors for launchctl probing.
# type is one of: "daemon" (KeepAlive, expected to always have a PID) or
#                 "periodic" (StartInterval/WatchPaths, PID absent between runs is normal).
# Daemon health rule:  numeric PID -> ok; PID "-" or absent -> down.
# Periodic health rule: PID "-" + exit_status 0 -> ok; nonzero status -> warn; absent -> down.
SERVICES: list[dict] = [
    # --- always-on daemons ---
    {"label": "com.dsswift.ion",                   "short": "ion",              "type": "daemon"},
    {"label": "com.example.tools-py-vector",       "short": "vector",           "type": "daemon"},
    {"label": "com.example.jarvis.discord-bot",    "short": "discord-bot",      "type": "daemon"},
    # NOTE: the scheduler/routines runner lives INSIDE the ion daemon (com.dsswift.ion);
    # there is no standalone com.example.jarvis.routines LaunchAgent, so it is NOT probed
    # via launchctl here (that produced a false "down"). It IS monitored — see
    # _check_routines(), which reports on scheduler activity recency instead.
    {"label": "com.example.cloudflared",           "short": "cloudflared",      "type": "daemon"},
    {"label": "com.example.ion-relay",             "short": "ion-relay",        "type": "daemon"},
    {"label": "homebrew.mxcl.ollama",              "short": "ollama",           "type": "daemon"},
    {"label": "com.example.tools-py-apple-foundation", "short": "apple-foundation", "type": "daemon"},  # noqa: E501
    # --- periodic / event-driven ---
    {"label": "com.example.jarvis.imessage",       "short": "imessage",         "type": "periodic"},
    {"label": "com.example.jarvis.nas-mount",      "short": "nas-mount",        "type": "periodic"},
    {"label": "com.example.jarvis.log-patrol",     "short": "log-patrol",       "type": "periodic"},
    {"label": "com.example.jarvis.deploy-watchdog","short": "deploy-watchdog",  "type": "periodic"},
]

# Disk thresholds (percent free; note: shutil returns bytes, we convert)
DISK_WARN_PCT  = 10.0
DISK_DOWN_PCT  =  5.0
DISK_PATH      = "/"

# Routines health: the scheduler runs inside the ion daemon, so it is probed by
# activity recency (minutes since the last routine_started/routine_delivered event)
# rather than a LaunchAgent. Healthy routines fire every few minutes.
ROUTINES_WARN_MIN = 20.0
ROUTINES_DOWN_MIN = 60.0

# /usr/sbin is required for sysctl (memory pressure level); /usr/bin for vm_stat.
_PATH_ENV = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"

# ---------------------------------------------------------------------------
# launchctl helpers
# ---------------------------------------------------------------------------

def _launchctl_list() -> dict[str, tuple[str, str]]:
    """
    Run `launchctl list` and parse into {label: (pid, last_exit_status)}.
    `launchctl list` columns: PID <tab> Status <tab> Label.
    PID is "-" when the process is not currently running.
    """
    try:
        result = subprocess.run(
            ["launchctl", "list"],
            capture_output=True,
            text=True,
            timeout=15,
            env={"PATH": _PATH_ENV},
        )
        if result.returncode != 0:
            print(
                f"[health-probe] WARN: launchctl list failed"
                f" rc={result.returncode}: {result.stderr.strip()}",
                file=sys.stderr,
            )
            return {}
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"[health-probe] WARN: launchctl list error: {exc}", file=sys.stderr)
        return {}

    entries: dict[str, tuple[str, str]] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split("\t")
        if len(parts) != 3:
            continue
        pid, status, label = parts
        entries[label] = (pid.strip(), status.strip())
    return entries


def _check_service(svc: dict, launchctl_map: dict[str, tuple[str, str]]) -> tuple[str, str]:
    """
    Return (status, detail) for a single service.
    status is one of: ok | warn | down
    """
    label = svc["label"]
    kind  = svc["type"]

    if label not in launchctl_map:
        return "down", "label not found in launchctl list"

    pid, exit_status = launchctl_map[label]

    if kind == "daemon":
        if pid == "-":
            return "down", f"not running (last exit: {exit_status})"
        return "ok", f"pid={pid}"

    # periodic: absence between runs is normal; check last exit status
    if pid != "-":
        # Currently executing — that's fine
        return "ok", f"running pid={pid}"
    # Idle between runs; status 0 = clean last exit
    if exit_status in ("-", "0"):
        return "ok", "idle (last exit: 0)"
    return "warn", f"idle (last exit: {exit_status})"


# ---------------------------------------------------------------------------
# Disk check
# ---------------------------------------------------------------------------

def _check_disk(path: str) -> tuple[str, str]:
    """Return (status, detail) for disk free space at path."""
    try:
        usage = shutil.disk_usage(path)
    except OSError as exc:
        return "warn", f"disk_usage error: {exc}"

    total_gb   = usage.total / (1024 ** 3)
    free_gb    = usage.free  / (1024 ** 3)
    free_pct   = (usage.free / usage.total) * 100.0 if usage.total else 0.0
    detail     = f"free={free_gb:.1f}GB of {total_gb:.1f}GB ({free_pct:.1f}%)"

    if free_pct <= DISK_DOWN_PCT:
        return "down", detail
    if free_pct <= DISK_WARN_PCT:
        return "warn", detail
    return "ok", detail


# ---------------------------------------------------------------------------
# Runaway ion-serve process check
# ---------------------------------------------------------------------------

def _check_runaway() -> tuple[str, str]:
    """
    Detect orphaned 'ion serve' processes.
    When launchctl stop orphans a child, 'ion serve' stays alive.
    More than one such process indicates a stale orphan (see docs/troubleshooting.md).
    """
    try:
        result = subprocess.run(
            ["pgrep", "-f", "ion serve"],
            capture_output=True,
            text=True,
            timeout=5,
            env={"PATH": _PATH_ENV},
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return "warn", f"pgrep error: {exc}"

    pids = [p.strip() for p in result.stdout.splitlines() if p.strip()]
    count = len(pids)

    if count == 0:
        # ion serve not running (ion daemon may be idle or down — that's the daemon check's job)
        return "ok", "no ion serve processes"
    if count == 1:
        return "ok", f"ion serve pid={pids[0]}"
    # > 1 means at least one orphan
    return "warn", f"orphan detected: {count} ion serve processes ({', '.join(pids)})"


# ---------------------------------------------------------------------------
# Routines (scheduler) check — by activity recency, not launchctl
# ---------------------------------------------------------------------------

def _check_routines() -> tuple[str, str]:
    """
    The scheduler/routines runner lives inside the ion daemon (no LaunchAgent),
    so probe it by activity recency: the most recent routine_started /
    routine_delivered event in agent_events. Healthy routines fire every few
    minutes (meeting_prep every 5m, autonomy poller every 60s, etc.).
    """
    try:
        con = sqlite3.connect(str(DB_PATH), timeout=5)
        try:
            con.execute("PRAGMA busy_timeout=5000")
            row = con.execute(
                "SELECT MAX(ts) FROM agent_events "
                "WHERE event IN ('routine_started', 'routine_delivered')"
            ).fetchone()
        finally:
            con.close()
    except Exception as exc:
        return "warn", f"query error: {exc}"

    last = row[0] if row else None
    if not last:
        return "down", "no routine events on record"
    try:
        last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=UTC)
    except ValueError:
        return "warn", f"unparseable ts: {last}"

    age_min = (datetime.now(UTC) - last_dt).total_seconds() / 60.0
    detail = f"last routine {age_min:.0f}m ago"
    if age_min >= ROUTINES_DOWN_MIN:
        return "down", detail
    if age_min >= ROUTINES_WARN_MIN:
        return "warn", detail
    return "ok", detail


# ---------------------------------------------------------------------------
# Host metrics (CPU / load / memory / swap gauges + disk / net I/O rates)
# ---------------------------------------------------------------------------
#
# Gauges are instantaneous (psutil reads them directly). I/O metrics come from
# cumulative byte counters, so we convert them to per-second rates by diffing
# against the previous probe's counters, persisted in COUNTER_STATE_PATH. The
# probe is a fresh process each run (launchd StartInterval), so in-memory state
# does not survive — the JSON state file is how one run sees the last.
#
# Reboot / counter-reset guard: if no prior sample exists, or any counter went
# backwards (reboot, interface reset, wrap), we emit NO rate this cycle and just
# rewrite the baseline. That avoids the huge false spike a naive (cur-0) or
# (cur-bigger_prev) delta would draw on the dashboard.

COUNTER_STATE_PATH = DB_PATH.parent / "probe-counters.json"

# CPU sampling window. psutil.cpu_percent(interval=N) blocks N seconds and
# returns true utilization over that window; without an interval it reports a
# meaningless since-boot (or since-last-call) average. One second inside a 60s
# job is negligible.
CPU_SAMPLE_SECONDS = 1.0


def _read_counter_state() -> dict | None:
    """Return the previous I/O counter snapshot, or None if absent/unreadable."""
    try:
        with COUNTER_STATE_PATH.open() as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_counter_state(state: dict) -> None:
    """Persist the current I/O counter snapshot for the next run's delta."""
    try:
        COUNTER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with COUNTER_STATE_PATH.open("w") as fh:
            json.dump(state, fh)
    except OSError as exc:
        print(f"[health-probe] WARN: counter state write failed: {exc}", file=sys.stderr)


def _sysctl_int(name: str) -> int | None:
    """Return an integer sysctl value, or None if unavailable/unparseable."""
    try:
        result = subprocess.run(
            ["sysctl", "-n", name],
            capture_output=True, text=True, timeout=5, env={"PATH": _PATH_ENV},
        )
        if result.returncode != 0:
            return None
        return int(result.stdout.strip())
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None


# vm_stat counter lines we care about, mapped to the names we use internally.
# These are macOS-specific signals psutil does not expose: the compressor pool
# size and TRUE anonymous-swap activity (Swapins/Swapouts) — distinct from
# psutil's swap sin/sout, which on macOS actually report all pageins/pageouts
# (file-backed paging included) and so massively overstate swap churn.
_VM_STAT_KEYS = {
    "Pages occupied by compressor": "compressor",
    "Swapins": "swapins",
    "Swapouts": "swapouts",
}


def _vm_stat_counters() -> dict[str, int]:
    """
    Parse `vm_stat` into {compressor, swapins, swapouts} as page counts.
    Returns {} on any failure (the metrics that depend on it are then skipped).
    """
    try:
        result = subprocess.run(
            ["vm_stat"],
            capture_output=True, text=True, timeout=5, env={"PATH": _PATH_ENV},
        )
        if result.returncode != 0:
            return {}
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"[health-probe] WARN: vm_stat error: {exc}", file=sys.stderr)
        return {}

    out: dict[str, int] = {}
    for line in result.stdout.splitlines():
        if ":" not in line:
            continue
        label, _, value = line.partition(":")
        key = _VM_STAT_KEYS.get(label.strip())
        if key is None:
            continue
        try:
            out[key] = int(value.strip().rstrip("."))
        except ValueError:
            continue
    return out


def _collect_host_metrics(ts: str) -> list[tuple[str, str, float, str]]:
    """
    Return host metric rows (ts, metric, value, unit). Returns [] if psutil is
    unavailable so the service-health pass is never blocked by a missing dep.
    """
    try:
        import psutil
    except ImportError:
        print(
            "[health-probe] WARN: psutil unavailable; skipping host metrics pass",
            file=sys.stderr,
        )
        return []

    rows: list[tuple[str, str, float, str]] = []

    # --- CPU + load (gauges) ---
    try:
        cpu = float(psutil.cpu_percent(interval=CPU_SAMPLE_SECONDS))
        rows.append((ts, "cpu_percent", cpu, "%"))
    except Exception as exc:
        print(f"[health-probe] WARN: cpu_percent error: {exc}", file=sys.stderr)
    try:
        l1, l5, l15 = os.getloadavg()
        rows.append((ts, "load_1m", float(l1), "procs"))
        rows.append((ts, "load_5m", float(l5), "procs"))
        rows.append((ts, "load_15m", float(l15), "procs"))
    except (OSError, ValueError) as exc:
        print(f"[health-probe] WARN: getloadavg error: {exc}", file=sys.stderr)

    # --- memory + swap (gauges) ---
    # On macOS free RAM sits near zero by design, so "free" is not a pressure
    # signal. The signals that matter on an always-on box are used%, wired, and
    # above all swap — capture those, not free.
    try:
        vm = psutil.virtual_memory()
        rows.append((ts, "mem_used_percent", float(vm.percent), "%"))
        wired = getattr(vm, "wired", None)
        if wired is not None:
            rows.append((ts, "mem_wired_mb", float(wired) / 1_000_000.0, "MB"))
    except Exception as exc:
        print(f"[health-probe] WARN: virtual_memory error: {exc}", file=sys.stderr)
    try:
        sm = psutil.swap_memory()
        rows.append((ts, "swap_used_mb", float(sm.used) / 1_000_000.0, "MB"))
        rows.append((ts, "swap_used_percent", float(sm.percent), "%"))
    except Exception as exc:
        print(f"[health-probe] WARN: swap_memory error: {exc}", file=sys.stderr)

    # --- memory pressure + compressor (the bottleneck verdict signals) ---
    # swap_used alone is misleading: macOS leaves cold pages in swap even under
    # no pressure. The kernel's own pressure level (1 normal / 2 warn / 4 critical)
    # is the verdict, and compressor size is the earlier-warning pool that fills
    # before anything reaches the swap file.
    pagesize = os.sysconf("SC_PAGE_SIZE")
    level = _sysctl_int("kern.memorystatus_vm_pressure_level")
    if level is not None:
        rows.append((ts, "mem_pressure_level", float(level), "level"))
    vmstat = _vm_stat_counters()
    if "compressor" in vmstat:
        rows.append((ts, "mem_compressed_mb", vmstat["compressor"] * pagesize / 1_000_000.0, "MB"))

    # --- disk + network I/O + swap activity (rates from cumulative counters) ---
    # TRUE anonymous-swap churn comes from vm_stat Swapins/Swapouts (pages),
    # converted to bytes here, NOT from psutil swap sin/sout (see _VM_STAT_KEYS).
    extra: dict[str, tuple[str, int]] = {}
    if "swapins" in vmstat:
        extra["swap_in"] = ("swap_in_bps", vmstat["swapins"] * pagesize)
    if "swapouts" in vmstat:
        extra["swap_out"] = ("swap_out_bps", vmstat["swapouts"] * pagesize)
    rows.extend(_collect_io_rates(ts, psutil, extra))
    return rows


def _collect_memory_integrity(ts: str) -> list[tuple[str, str, float, str]]:
    """Fetch the vec-server /integrity snapshot and return host_metric rows
    (jarvis#811a). The vec-server computes this in-process where the chroma client
    is already loaded, so this 60s probe never imports chromadb. Returns [] on any
    failure so the metrics pass is never blocked.

    Surfaces the invariant the supersede/TTL fix (#803/#822) guards:
    memory_dangling_active should sit at 0; memory_fts_coverage_pct should track 100.
    """
    import urllib.request

    try:
        with urllib.request.urlopen(f"{VEC_SERVER_URL}/integrity", timeout=5) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        print(f"[health-probe] WARN: integrity probe failed: {exc}", file=sys.stderr)
        return []

    rows: list[tuple[str, str, float, str]] = []
    for metric, unit in (
        ("active_meta", "rows"),
        ("live_vectors", "rows"),
        ("dangling_active", "rows"),
        ("superseded", "rows"),
        ("fts_rows", "rows"),
        ("fts_coverage_pct", "%"),
    ):
        val = data.get(metric)
        if isinstance(val, (int, float)):
            rows.append((ts, f"memory_{metric}", float(val), unit))
    return rows


def _collect_dependency_probes(
    ts: str,
) -> tuple[list[tuple[str, str, float, str]], list[tuple[str, str, str, str]]]:
    """Fetch the vec-server /probe snapshot: per-dependency latency for ChromaDB,
    the Ollama embedding endpoint, and Neo4j/Graphiti. The vec-server times each
    component in-process where the clients are already loaded, so this 60s probe
    never imports chromadb or neo4j.

    Returns (metric_rows, health_rows):
      metric_rows  -> host_metrics  (chroma_latency_ms / embed_latency_ms / graph_latency_ms)
      health_rows  -> host_health   (chroma / embed / graph: ok | down)

    A None ok flag means 'not applicable' (graph disabled) and yields no rows.
    Returns ([], []) on any transport failure so neither pass is blocked.
    """
    import urllib.request

    try:
        with urllib.request.urlopen(f"{VEC_SERVER_URL}/probe", timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as exc:
        print(f"[health-probe] WARN: dependency probe failed: {exc}", file=sys.stderr)
        # vec-server itself is unreachable: its own launchd 'vector' health row
        # already covers that, so do not invent down rows for chroma/embed/graph.
        return [], []

    metric_rows: list[tuple[str, str, float, str]] = []
    health_rows: list[tuple[str, str, str, str]] = []
    for short, ms_key, ok_key in (
        ("chroma", "chroma_ms", "chroma_ok"),
        ("embed", "embed_ms", "embed_ok"),
        ("graph", "graph_ms", "graph_ok"),
    ):
        ok = data.get(ok_key)
        if ok is None:
            continue  # not applicable (e.g. graph disabled)
        ms = data.get(ms_key)
        if isinstance(ms, (int, float)):
            metric_rows.append((ts, f"{short}_latency_ms", float(ms), "ms"))
        status = "ok" if ok else "down"
        detail = f"{ms}ms" if isinstance(ms, (int, float)) else str(
            data.get(f"{short}_error", "unreachable")
        )
        health_rows.append((ts, short, status, detail))
    return metric_rows, health_rows


def _collect_io_rates(
    ts: str,
    psutil,  # noqa: ANN001
    extra: dict[str, tuple[str, int]] | None = None,
) -> list[tuple[str, str, float, str]]:
    """
    Convert cumulative byte counters into per-second rates using the persisted
    previous snapshot. Covers disk/net (from psutil) plus any `extra` counters
    supplied as {state_key: (metric_name, cumulative_bytes)} — used for swap
    activity. Emits nothing on the first run or after a counter reset (reboot
    guard); always rewrites the baseline.
    """
    now = _time.time()
    try:
        dio = psutil.disk_io_counters()
        nio = psutil.net_io_counters()
    except Exception as exc:
        print(f"[health-probe] WARN: io_counters error: {exc}", file=sys.stderr)
        return []

    cur = {"t": now}
    rate_specs = [
        ("disk_read_bps", "disk_read"),
        ("disk_write_bps", "disk_write"),
        ("net_in_bps", "net_recv"),
        ("net_out_bps", "net_sent"),
    ]
    if dio is not None:
        cur["disk_read"] = int(dio.read_bytes)
        cur["disk_write"] = int(dio.write_bytes)
    if nio is not None:
        cur["net_recv"] = int(nio.bytes_recv)
        cur["net_sent"] = int(nio.bytes_sent)
    for state_key, (metric_name, value) in (extra or {}).items():
        cur[state_key] = int(value)
        rate_specs.append((metric_name, state_key))

    prev = _read_counter_state()
    _write_counter_state(cur)  # baseline for the next run, regardless of outcome

    if not prev:
        return []  # first run — no delta to draw yet
    dt = now - float(prev.get("t", 0))
    if dt <= 0:
        return []

    rows: list[tuple[str, str, float, str]] = []
    for metric, key in rate_specs:
        if key not in cur or key not in prev:
            continue
        delta = cur[key] - int(prev[key])
        if delta < 0:
            continue  # counter reset (reboot / interface reset) — skip, no false spike
        rows.append((ts, metric, delta / dt, "B/s"))
    return rows


# How many processes (by resident memory) to attribute each tick. The point is
# "what is holding RAM right now" — on this box the answer is usually macOS
# indexing/media daemons and desktop apps, not the Jarvis services, so we rank
# all processes rather than a fixed allowlist.
TOP_PROCESS_COUNT = 10


def _collect_process_metrics(ts: str) -> list[tuple[str, int, str, float]]:
    """
    Return the top processes by resident memory as (ts, pid, name, rss_mb).
    Returns [] if psutil is unavailable.
    """
    try:
        import psutil
    except ImportError:
        return []

    procs: list[tuple[int, int, str]] = []  # (rss, pid, name)
    for proc in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            mem = proc.info["memory_info"]
            if mem is None:
                continue
            procs.append((int(mem.rss), int(proc.info["pid"]), proc.info["name"] or "?"))
        except (psutil.NoSuchProcess, psutil.AccessDenied, KeyError, TypeError):
            continue

    procs.sort(reverse=True)  # largest RSS first
    return [
        (ts, pid, name, rss / 1_000_000.0)
        for rss, pid, name in procs[:TOP_PROCESS_COUNT]
    ]


# ---------------------------------------------------------------------------
# SQLite write
# ---------------------------------------------------------------------------

HOST_HEALTH_RETENTION_DAYS = 14
HOST_METRICS_RETENTION_DAYS = 14
HOST_PROCESS_RETENTION_DAYS = 14


def _retention_cutoff(days: int = HOST_HEALTH_RETENTION_DAYS) -> str:
    """ISO-8601 UTC timestamp `days` in the past."""
    cutoff = datetime.now(UTC) - timedelta(days=days)
    return cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_rows(rows: list[tuple[str, str, str, str]]) -> None:
    """
    Write probe results into host_health.
    rows: list of (ts, service, status, detail).
    Uses busy_timeout to survive WAL contention with the TS harness.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS host_health (
                ts     TEXT,
                service TEXT,
                status  TEXT,
                detail  TEXT
            )
            """
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_host_health_ts ON host_health (ts)"
        )
        con.executemany(
            "INSERT INTO host_health (ts, service, status, detail) VALUES (?, ?, ?, ?)",
            rows,
        )
        # Retention: this table is append-only (~14 rows/min). Prune to a 14-day
        # window so it stays bounded. ts is ISO-8601 UTC, so string compare is sound.
        con.execute(
            "DELETE FROM host_health WHERE ts < ?",
            (_retention_cutoff(),),
        )
        con.commit()
    finally:
        con.close()


def _write_metrics(rows: list[tuple[str, str, float, str]]) -> None:
    """
    Write host-metric rows into host_metrics (ts, metric, value, unit).
    Same WAL/busy_timeout and 14-day retention discipline as host_health.
    """
    if not rows:
        return
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS host_metrics (
                ts     TEXT,
                metric TEXT,
                value  REAL,
                unit   TEXT
            )
            """
        )
        # Index on (metric, ts): every dashboard panel filters by metric and
        # orders/ranges by ts, so this is the access path Grafana uses.
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_host_metrics_metric_ts "
            "ON host_metrics (metric, ts)"
        )
        con.executemany(
            "INSERT INTO host_metrics (ts, metric, value, unit) VALUES (?, ?, ?, ?)",
            rows,
        )
        con.execute(
            "DELETE FROM host_metrics WHERE ts < ?",
            (_retention_cutoff(HOST_METRICS_RETENTION_DAYS),),
        )
        con.commit()
    finally:
        con.close()


def _write_process_metrics(rows: list[tuple[str, int, str, float]]) -> None:
    """
    Write top-process rows into host_process_metrics (ts, pid, name, rss_mb).
    Same WAL/busy_timeout and 14-day retention discipline as host_metrics.
    """
    if not rows:
        return
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH), timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS host_process_metrics (
                ts     TEXT,
                pid    INTEGER,
                name   TEXT,
                rss_mb REAL
            )
            """
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_host_process_metrics_ts "
            "ON host_process_metrics (ts)"
        )
        con.executemany(
            "INSERT INTO host_process_metrics (ts, pid, name, rss_mb) "
            "VALUES (?, ?, ?, ?)",
            rows,
        )
        con.execute(
            "DELETE FROM host_process_metrics WHERE ts < ?",
            (_retention_cutoff(HOST_PROCESS_RETENTION_DAYS),),
        )
        con.commit()
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def probe() -> None:
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows: list[tuple[str, str, str, str]] = []

    # --- launchd service checks ---
    launchctl_map = _launchctl_list()
    for svc in SERVICES:
        try:
            status, detail = _check_service(svc, launchctl_map)
        except Exception as exc:
            status, detail = "warn", f"probe error: {exc}"
        short = svc["short"]
        rows.append((ts, short, status, detail))
        if status != "ok":
            print(f"[health-probe] {status.upper()} {short}: {detail}", file=sys.stderr)

    # --- disk ---
    try:
        disk_status, disk_detail = _check_disk(DISK_PATH)
    except Exception as exc:
        disk_status, disk_detail = "warn", f"probe error: {exc}"
    rows.append((ts, "disk", disk_status, disk_detail))
    if disk_status != "ok":
        print(f"[health-probe] {disk_status.upper()} disk: {disk_detail}", file=sys.stderr)

    # --- runaway ion serve ---
    try:
        runaway_status, runaway_detail = _check_runaway()
    except Exception as exc:
        runaway_status, runaway_detail = "warn", f"probe error: {exc}"
    rows.append((ts, "runaway", runaway_status, runaway_detail))
    if runaway_status != "ok":
        print(f"[health-probe] {runaway_status.upper()} runaway: {runaway_detail}", file=sys.stderr)

    # --- routines (scheduler activity recency; runs inside ion, no LaunchAgent) ---
    try:
        routines_status, routines_detail = _check_routines()
    except Exception as exc:
        routines_status, routines_detail = "warn", f"probe error: {exc}"
    rows.append((ts, "routines", routines_status, routines_detail))
    if routines_status != "ok":
        print(
            f"[health-probe] {routines_status.upper()} routines: {routines_detail}",
            file=sys.stderr,
        )

    # --- write all health rows atomically ---
    try:
        _write_rows(rows)
    except Exception as exc:
        print(f"[health-probe] ERROR: DB write failed: {exc}", file=sys.stderr)
        sys.exit(1)

    ok_count   = sum(1 for r in rows if r[2] == "ok")
    warn_count = sum(1 for r in rows if r[2] == "warn")
    down_count = sum(1 for r in rows if r[2] == "down")
    print(
        f"[health-probe] wrote {len(rows)} rows:"
        f" {ok_count} ok / {warn_count} warn / {down_count} down"
    )

    # --- host metrics pass (independent of health; never blocks it) ---
    try:
        metric_rows = _collect_host_metrics(ts)
        _write_metrics(metric_rows)
        if metric_rows:
            print(f"[health-probe] wrote {len(metric_rows)} host_metrics rows")
    except Exception as exc:
        print(f"[health-probe] ERROR: host metrics pass failed: {exc}", file=sys.stderr)

    # --- memory integrity pass (jarvis#811a; independent, never blocks health) ---
    try:
        integrity_rows = _collect_memory_integrity(ts)
        if integrity_rows:
            _write_metrics(integrity_rows)
            print(f"[health-probe] wrote {len(integrity_rows)} memory-integrity rows")
    except Exception as exc:
        print(f"[health-probe] ERROR: memory integrity pass failed: {exc}", file=sys.stderr)

    # --- per-process RSS attribution pass (independent; never blocks health) ---
    try:
        proc_rows = _collect_process_metrics(ts)
        _write_process_metrics(proc_rows)
        if proc_rows:
            print(f"[health-probe] wrote {len(proc_rows)} host_process_metrics rows")
    except Exception as exc:
        print(f"[health-probe] ERROR: process metrics pass failed: {exc}", file=sys.stderr)

    # --- external dependency latency pass (chroma/embed/graph via vec-server
    #     /probe; runs after the core health write so a slow probe never delays it) ---
    try:
        dep_metrics, dep_health = _collect_dependency_probes(ts)
        if dep_health:
            _write_rows(dep_health)
        if dep_metrics:
            _write_metrics(dep_metrics)
        for r in dep_health:
            if r[2] != "ok":
                print(f"[health-probe] {r[2].upper()} {r[1]}: {r[3]}", file=sys.stderr)
        if dep_metrics or dep_health:
            print(
                f"[health-probe] wrote {len(dep_health)} dependency health "
                f"+ {len(dep_metrics)} latency rows"
            )
    except Exception as exc:
        print(f"[health-probe] ERROR: dependency probe pass failed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    probe()

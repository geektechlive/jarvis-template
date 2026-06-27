"""Regression tests for the host-metrics I/O rate logic in scripts/health-probe.py.

The rate path is the part most likely to silently break: it diffs cumulative
disk/network byte counters across probe runs (persisted in a JSON state file)
and must (a) emit nothing on the first run, (b) compute correct per-second rates
on the second, and (c) suppress output after a counter reset (reboot) instead of
drawing a huge false spike. These pin that behavior without needing psutil — a
fake counter source is injected.
"""

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "health-probe.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("health_probe", _SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Counter:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _FakePsutil:
    """Stand-in exposing only disk_io_counters / net_io_counters."""

    def __init__(self, disk, net):
        self._disk = disk
        self._net = net

    def disk_io_counters(self):
        return self._disk

    def net_io_counters(self):
        return self._net


@pytest.fixture
def hp(tmp_path, monkeypatch):
    mod = _load_module()
    monkeypatch.setattr(mod, "COUNTER_STATE_PATH", tmp_path / "probe-counters.json")
    return mod


def _set_clock(hp, monkeypatch, value):
    monkeypatch.setattr(hp._time, "time", lambda: value)


def _rates(rows):
    return {metric: value for (_, metric, value, _) in rows}


def test_first_run_emits_no_rates_but_writes_baseline(hp, monkeypatch):
    _set_clock(hp, monkeypatch, 1000.0)
    psutil = _FakePsutil(
        disk=_Counter(read_bytes=1000, write_bytes=2000),
        net=_Counter(bytes_recv=500, bytes_sent=300),
    )
    rows = hp._collect_io_rates("2026-06-16T13:00:00Z", psutil)
    assert rows == []  # no prior sample -> no delta to draw
    assert hp.COUNTER_STATE_PATH.exists()  # baseline persisted for next run


def test_second_run_computes_correct_per_second_rates(hp, monkeypatch):
    _set_clock(hp, monkeypatch, 1000.0)
    hp._collect_io_rates(
        "2026-06-16T13:00:00Z",
        _FakePsutil(
            disk=_Counter(read_bytes=1000, write_bytes=2000),
            net=_Counter(bytes_recv=500, bytes_sent=300),
        ),
    )
    # 60s later, counters advance by known deltas.
    _set_clock(hp, monkeypatch, 1060.0)
    rows = hp._collect_io_rates(
        "2026-06-16T13:01:00Z",
        _FakePsutil(
            disk=_Counter(read_bytes=1000 + 6000, write_bytes=2000 + 1200),
            net=_Counter(bytes_recv=500 + 3000, bytes_sent=300 + 600),
        ),
    )
    rates = _rates(rows)
    assert rates == {
        "disk_read_bps": pytest.approx(100.0),   # 6000 / 60
        "disk_write_bps": pytest.approx(20.0),   # 1200 / 60
        "net_in_bps": pytest.approx(50.0),       # 3000 / 60
        "net_out_bps": pytest.approx(10.0),      # 600 / 60
    }
    assert all(unit == "B/s" for (_, _, _, unit) in rows)


def test_counter_reset_suppresses_rates(hp, monkeypatch):
    _set_clock(hp, monkeypatch, 1000.0)
    hp._collect_io_rates(
        "2026-06-16T13:00:00Z",
        _FakePsutil(
            disk=_Counter(read_bytes=9_000_000, write_bytes=9_000_000),
            net=_Counter(bytes_recv=9_000_000, bytes_sent=9_000_000),
        ),
    )
    # Reboot: counters drop below the previous sample.
    _set_clock(hp, monkeypatch, 1060.0)
    rows = hp._collect_io_rates(
        "2026-06-16T13:01:00Z",
        _FakePsutil(
            disk=_Counter(read_bytes=100, write_bytes=100),
            net=_Counter(bytes_recv=100, bytes_sent=100),
        ),
    )
    assert rows == []  # negative delta -> no false spike, just rebaseline


def test_write_metrics_creates_table_and_index(hp, tmp_path, monkeypatch):
    monkeypatch.setattr(hp, "DB_PATH", tmp_path / "conversations.db")
    rows = [
        ("2026-06-16T13:00:00Z", "cpu_percent", 12.5, "%"),
        ("2026-06-16T13:00:00Z", "swap_used_mb", 799.25, "MB"),
    ]
    hp._write_metrics(rows)
    import sqlite3

    con = sqlite3.connect(str(hp.DB_PATH))
    try:
        count = con.execute("SELECT COUNT(*) FROM host_metrics").fetchone()[0]
        idx = [r[1] for r in con.execute("PRAGMA index_list('host_metrics')")]
    finally:
        con.close()
    assert count == 2
    assert any("metric_ts" in name for name in idx)


def test_write_metrics_noop_on_empty(hp, tmp_path, monkeypatch):
    monkeypatch.setattr(hp, "DB_PATH", tmp_path / "conversations.db")
    hp._write_metrics([])
    # No rows means we never touch the DB file.
    assert not hp.DB_PATH.exists()


# --- vm_stat parsing -------------------------------------------------------

_VM_STAT_SAMPLE = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    49281.
Pages active:                                 630992.
Pages occupied by compressor:                  89695.
Pageins:                                   968166689.
Swapins:                                       55394.
Swapouts:                                      105940.
"""


class _FakeProc:
    def __init__(self, returncode, stdout):
        self.returncode = returncode
        self.stdout = stdout


def test_vm_stat_counters_parses_named_lines(hp, monkeypatch):
    monkeypatch.setattr(
        hp.subprocess, "run", lambda *a, **k: _FakeProc(0, _VM_STAT_SAMPLE)
    )
    counters = hp._vm_stat_counters()
    # Only the three lines we map are extracted; the trailing '.' is stripped.
    assert counters == {"compressor": 89695, "swapins": 55394, "swapouts": 105940}


def test_vm_stat_counters_empty_on_failure(hp, monkeypatch):
    monkeypatch.setattr(hp.subprocess, "run", lambda *a, **k: _FakeProc(1, ""))
    assert hp._vm_stat_counters() == {}


# --- swap activity rate (extra counters threaded through _collect_io_rates) -


def test_swap_rate_from_extra_counters(hp, monkeypatch):
    disk = _Counter(read_bytes=0, write_bytes=0)
    net = _Counter(bytes_recv=0, bytes_sent=0)
    psutil = _FakePsutil(disk=disk, net=net)

    _set_clock(hp, monkeypatch, 1000.0)
    hp._collect_io_rates("t0", psutil, {"swap_out": ("swap_out_bps", 1_000_000)})
    # 60s later swapouts advanced by 6_000_000 bytes -> 100_000 B/s.
    _set_clock(hp, monkeypatch, 1060.0)
    rows = hp._collect_io_rates(
        "t1", psutil, {"swap_out": ("swap_out_bps", 7_000_000)}
    )
    rates = _rates(rows)
    assert rates["swap_out_bps"] == pytest.approx(100_000.0)


# --- per-process RSS attribution -------------------------------------------


class _FakeMem:
    def __init__(self, rss):
        self.rss = rss


class _FakeProcess:
    def __init__(self, pid, name, rss):
        self.info = {"pid": pid, "name": name, "memory_info": _FakeMem(rss)}


class _FakePsutilProcs:
    """Fake psutil module exposing process_iter + the exception classes."""

    NoSuchProcess = type("NoSuchProcess", (Exception,), {})
    AccessDenied = type("AccessDenied", (Exception,), {})

    def __init__(self, procs):
        self._procs = procs

    def process_iter(self, _attrs):
        return iter(self._procs)


def test_collect_process_metrics_returns_top_n_by_rss(hp, monkeypatch):
    procs = [
        _FakeProcess(1, "small", 10_000_000),
        _FakeProcess(2, "huge", 900_000_000),
        _FakeProcess(3, "medium", 400_000_000),
    ]
    monkeypatch.setitem(
        __import__("sys").modules, "psutil", _FakePsutilProcs(procs)
    )
    monkeypatch.setattr(hp, "TOP_PROCESS_COUNT", 2)
    rows = hp._collect_process_metrics("t0")
    # Sorted largest-first, capped at TOP_PROCESS_COUNT, RSS converted to MB.
    assert [(name, round(rss)) for (_, _, name, rss) in rows] == [
        ("huge", 900),
        ("medium", 400),
    ]


def test_write_process_metrics_creates_table(hp, tmp_path, monkeypatch):
    monkeypatch.setattr(hp, "DB_PATH", tmp_path / "conversations.db")
    hp._write_process_metrics(
        [("t0", 1, "ion", 123.4), ("t0", 2, "ollama", 56.7)]
    )
    import sqlite3

    con = sqlite3.connect(str(hp.DB_PATH))
    try:
        rows = con.execute(
            "SELECT name, rss_mb FROM host_process_metrics ORDER BY rss_mb DESC"
        ).fetchall()
    finally:
        con.close()
    assert rows == [("ion", 123.4), ("ollama", 56.7)]

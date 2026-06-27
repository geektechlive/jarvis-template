#!/usr/bin/env python3
# SCRIPT: error-rate.py
# STATUS: DRAFT — not yet deployed to Mini
# PURPOSE: Query Loki for error count in a time window and print a JSON result.
# CONTRACT:
#   Usage:  error-rate <service> <window>
#           e.g.  error-rate vec-server 5m
#   Output: {"service":"vec-server","window":"5m","count":N,"rate_per_min":R} (exit 0)
#           {"error":"<message>"}                                            (exit 1)
#   <service> maps to the Loki `service` label set by Alloy.
#             Use "all" to aggregate across all services.
#   <window> is a Loki range duration: integer + unit (s / m / h / d).
#            Examples: 5m  1h  30s  2d
# NOTE: Zero errors is a valid successful result (exit 0, count=0, rate_per_min=0.0).
#       Only Loki unreachable / HTTP error / unparseable response → exit 1.
#
# ERROR DETECTION: All services emit a bracketed level token — [ERROR], [CRITICAL],
# [FATAL], etc. — which Alloy extracts into a `level` stream label (lowercased).
# The LogQL filter `| level=~"error|critical|fatal"` is therefore uniform across
# every service; no format-specific heuristics are required.

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

LOKI_BASE  = "http://127.0.0.1:3100"
LOKI_QUERY = f"{LOKI_BASE}/loki/api/v1/query_range"

# Services aggregated when querying "all". ion-telemetry is excluded (it is the metadata
# telemetry stream, not an error source). Kept in sync with the Alloy `service` labels.
ALL_SERVICES = (
    "ion-engine",
    "ion-harness",
    "vec-server",
    "voice-tts",
    "agent",
    "imessage",
    "discord-bot",
)

REQUEST_TIMEOUT_SEC = 10

# ---------------------------------------------------------------------------
# Window parsing
# ---------------------------------------------------------------------------

_WINDOW_RE = re.compile(r"^(\d+)([smhd])$", re.IGNORECASE)
_UNIT_TO_MINUTES: dict[str, float] = {
    "s": 1 / 60,
    "m": 1.0,
    "h": 60.0,
    "d": 1440.0,
}


def _parse_window(window: str) -> float:
    """
    Parse a Loki duration string (e.g. "5m", "1h", "30s") and return minutes.
    Raises ValueError on invalid format.
    """
    m = _WINDOW_RE.match(window)
    if not m:
        raise ValueError(
            f"Invalid window '{window}'. Use integer + unit (s/m/h/d), e.g. 5m or 1h."
        )
    amount = int(m.group(1))
    unit   = m.group(2).lower()
    return amount * _UNIT_TO_MINUTES[unit]


def _window_to_seconds(window: str) -> int:
    """Return window duration in whole seconds."""
    return round(_parse_window(window) * 60)


# ---------------------------------------------------------------------------
# LogQL expression
# ---------------------------------------------------------------------------

def _build_logql(service: str, window: str) -> str:
    """
    Build a LogQL count_over_time expression for ONE service.

    The `level` label is set by Alloy for every service from its bracketed level token.
    A single uniform filter covers all services — no format-specific branches needed.

    count_over_time (not rate()) returns an integer count for the whole window;
    rate_per_min is computed locally with known units. sum() collapses to one series.
    "all" is handled by summing per-service counts in Python (see main), which avoids
    LogQL vector-match pitfalls when one service has zero matches.
    """
    return (
        f'sum(count_over_time({{service="{service}"}} | level=~"error|critical|fatal" [{window}]))'
    )


# ---------------------------------------------------------------------------
# Loki HTTP query
# ---------------------------------------------------------------------------

def _query_loki(logql: str, window_sec: int) -> dict:
    """
    Send query_range to Loki.
    step=window_sec with start=now-window, end=now gives a single trailing bucket.
    Returns the parsed Loki JSON response.
    Raises urllib.error.URLError or OSError on network failure.
    """
    now_ns = int(time.time() * 1e9)
    start_ns = now_ns - window_sec * 1_000_000_000

    params = urllib.parse.urlencode({
        "query": logql,
        "start": str(start_ns),
        "end":   str(now_ns),
        "step":  str(window_sec),
    })
    url = f"{LOKI_QUERY}?{params}"

    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
        raw = resp.read()
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Result extraction
# ---------------------------------------------------------------------------

def _extract_count(loki_response: dict) -> int:
    """
    Extract the error count from a Loki query_range matrix response.
    Empty result = 0 (no errors is a valid success).
    Raises ValueError if the response shape is unexpected.
    """
    data = loki_response.get("data", {})
    result_type = data.get("resultType")
    if result_type != "matrix":
        raise ValueError(f"Unexpected Loki resultType: {result_type!r} (expected 'matrix')")

    results = data.get("result", [])
    if not results:
        # No matching log lines in window — count is zero
        return 0

    # sum() collapses to a single series; grab its latest value
    series = results[0]
    values = series.get("values", [])
    if not values:
        return 0

    # Each value is [epoch_float_or_str, count_string]
    latest_value = values[-1][1]
    return int(float(latest_value))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="error-rate",
        description=(
            "Query Loki for the error count across a time window for a Jarvis service.\n\n"
            "Prints JSON to stdout:"
            " {\"service\":\"...\",\"window\":\"...\",\"count\":N,\"rate_per_min\":R}\n"
            "Exit 0 on success (including zero errors). Exit 1 on query failure."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  error-rate vec-server 5m\n"
            "  error-rate ion-engine 1h\n"
            "  error-rate all 30m\n"
            "  error-rate discord-bot 2h\n\n"
            "Service names match the Loki 'service' label set by Grafana Alloy\n"
            "(infra/observability/alloy-config.alloy):\n"
            "  ion-engine, ion-harness, vec-server, voice-tts, discord-bot,\n"
            "  agent, imessage, ion-telemetry, all\n\n"
            "Window units: s (seconds), m (minutes), h (hours), d (days)"
        ),
    )
    parser.add_argument("service", help="Loki service label (or 'all')")
    parser.add_argument("window",  help="Time window, e.g. 5m, 1h, 30s")
    args = parser.parse_args()

    service = args.service
    window  = args.window

    # Validate window format before touching the network
    try:
        window_min = _parse_window(window)
    except ValueError as exc:
        out = {"error": str(exc)}
        print(json.dumps(out))
        sys.exit(1)

    window_sec = _window_to_seconds(window)
    services = list(ALL_SERVICES) if service == "all" else [service]

    try:
        count = sum(
            _extract_count(_query_loki(_build_logql(svc, window), window_sec))
            for svc in services
        )
    except urllib.error.URLError as exc:
        print(json.dumps({"error": f"Loki unreachable: {exc.reason}"}))
        sys.exit(1)
    except OSError as exc:
        print(json.dumps({"error": f"Network error: {exc}"}))
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Loki response not valid JSON: {exc}"}))
        sys.exit(1)
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        print(json.dumps({"error": f"Unexpected Loki response shape: {exc}"}))
        sys.exit(1)

    rate_per_min = round(count / window_min, 4) if window_min > 0 else 0.0

    result = {
        "service":     service,
        "window":      window,
        "count":       count,
        "rate_per_min": rate_per_min,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

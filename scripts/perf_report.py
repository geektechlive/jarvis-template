#!/usr/bin/env python
"""Performance report: P50/P95/P99 latency by phase, compared against perf.yaml budgets.

Usage:
    uv run python scripts/perf_report.py [--hours N]

Reads from the perf_metrics table (populated by record_perf() in episodic.py).
Prints a formatted table and exits 1 if any phase exceeds its P95 budget.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml


def _load_budgets() -> dict[str, float]:
    perf_yaml = Path(__file__).parent.parent / "harness" / "config" / "perf.yaml"
    try:
        with open(perf_yaml) as f:
            cfg = yaml.safe_load(f) or {}
        return {phase: float(ms) for phase, ms in (cfg.get("budgets") or {}).items()}
    except Exception:
        return {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Jarvis perf report")
    parser.add_argument(
        "--hours", type=int, default=24, help="Lookback window in hours (default 24)"
    )
    args = parser.parse_args()

    # Import after arg parse so --help works without a full harness init
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from harness.memory import episodic
    episodic.init_db()

    budgets = _load_budgets()
    stats = episodic.perf_summary(since_hours=args.hours)

    if not stats:
        print(f"No perf_metrics rows in the last {args.hours}h.")
        return 0

    col_w = max(len(s["phase"]) for s in stats) + 2
    header = f"{'Phase':<{col_w}} {'Count':>6} {'P50 ms':>9} {'P95 ms':>9} {'P99 ms':>9} {'Budget':>9} {'OK?':>5}"  # noqa: E501
    print(header)
    print("-" * len(header))

    over_budget = False
    for s in stats:
        phase = s["phase"]
        budget = budgets.get(phase)
        p95 = s["p95_ms"]
        if budget is not None:
            ok = "OK" if p95 <= budget else "OVER"
            budget_str = f"{budget:.0f}"
            if ok == "OVER":
                over_budget = True
        else:
            ok = "n/a"
            budget_str = "n/a"
        print(
            f"{phase:<{col_w}} {s['count']:>6} {s['p50_ms']:>9.1f} {p95:>9.1f} "
            f"{s['p99_ms']:>9.1f} {budget_str:>9} {ok:>5}"
        )

    if over_budget:
        print("\nWARN: one or more phases exceeded P95 budget.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

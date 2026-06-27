#!/usr/bin/env python3
"""Stub/incomplete-code audit sweep.

Scans harness/ for patterns that indicate incomplete or placeholder code and
writes findings to audit_findings.json (append-only, keyed by id).

Run from repo root:  python scripts/audit_stubs.py
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
HARNESS_DIR = REPO_ROOT / "harness"
FINDINGS_PATH = REPO_ROOT / "audit_findings.json"

FINDING_TYPE = "stub"

# Patterns targeting stub code (regex applied per-line)
_LINE_PATTERNS: list[tuple[str, str, str]] = [
    # (pattern, severity, recommendation)
    (r"#\s*(TODO|FIXME|XXX|HACK)\b", "MEDIUM", "Resolve or file against a workstream"),
    (r"\braise NotImplementedError\b", "HIGH", "Implement or explicitly defer to named WS"),
    (r"\breturn None\s*#\s*\w", "LOW", "Verify this intentional stub return is documented"),
]

# AST-based: functions whose entire body is a single `pass` (not protocol stubs)
_STUB_RETURN_RE = re.compile(
    r"^\s*return\s+[\"'][A-Za-z ]{5,50}[\"']\s*$"
)


def _load_existing() -> dict[str, dict]:
    if FINDINGS_PATH.exists():
        with open(FINDINGS_PATH) as f:
            rows: list[dict] = json.load(f)
        return {r["id"]: r for r in rows}
    return {}


def _finding_id(ftype: str, filepath: str, lineno: int) -> str:
    p = Path(filepath)
    rel = p.relative_to(REPO_ROOT) if p.is_absolute() else p
    return f"{ftype}:{rel}:{lineno}"


def _scan_line_patterns(py_path: Path) -> list[dict]:
    findings: list[dict] = []
    try:
        lines = py_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return findings
    rel = str(py_path.relative_to(REPO_ROOT))
    for lineno, raw in enumerate(lines, 1):
        for pattern, severity, rec in _LINE_PATTERNS:
            if re.search(pattern, raw):
                fid = _finding_id("stub", rel, lineno)
                findings.append({
                    "id": fid,
                    "type": FINDING_TYPE,
                    "file": rel,
                    "line": lineno,
                    "severity": severity,
                    "recommendation": rec,
                    "snippet": raw.strip()[:120],
                    "status": "open",
                })
                break
    return findings


def _scan_pass_bodies(py_path: Path) -> list[dict]:
    """Flag non-trivial functions whose entire body is `pass`."""
    findings: list[dict] = []
    try:
        tree = ast.parse(py_path.read_text(encoding="utf-8"))
    except SyntaxError:
        return findings
    rel = str(py_path.relative_to(REPO_ROOT))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = node.body
        # Skip: single-statement docstring, then pass is common in protocols
        stmts = [
            s for s in body
            if not isinstance(s, ast.Expr) or not isinstance(s.value, ast.Constant)
        ]
        if len(stmts) == 1 and isinstance(stmts[0], ast.Pass):
            # Skip very short function names (likely __init__, setUp, etc.)
            if len(node.name) <= 4:
                continue
            fid = _finding_id("stub-pass", rel, node.lineno)
            findings.append({
                "id": fid,
                "type": "stub-pass",
                "file": rel,
                "line": node.lineno,
                "severity": "MEDIUM",
                "recommendation": (
                    f"Function `{node.name}` body is only `pass` — implement or remove"
                ),
                "snippet": f"def {node.name}(...): pass",
                "status": "open",
            })
    return findings


def main() -> None:
    existing = _load_existing()
    new_findings: list[dict] = []

    for py_path in sorted(HARNESS_DIR.rglob("*.py")):
        new_findings.extend(_scan_line_patterns(py_path))
        new_findings.extend(_scan_pass_bodies(py_path))

    # Merge: preserve existing status/notes, add new findings
    merged = dict(existing)
    added = 0
    for f in new_findings:
        if f["id"] not in merged:
            merged[f["id"]] = f
            added += 1
        # Don't overwrite status of existing findings

    rows = sorted(merged.values(), key=lambda r: (r["severity"], r["file"], r["line"]))
    with open(FINDINGS_PATH, "w") as out:
        json.dump(rows, out, indent=2)
        out.write("\n")

    open_count = sum(1 for r in rows if r.get("status") == "open")
    high_count = sum(1 for r in rows if r.get("status") == "open" and r.get("severity") == "HIGH")
    print(
        f"audit_stubs: {len(rows)} total findings, {open_count} open, {high_count} HIGH. "
        f"{added} new findings added."
    )
    if high_count:
        print("HIGH findings:")
        for r in rows:
            if r.get("status") == "open" and r.get("severity") == "HIGH":
                print(f"  [{r['id']}] {r['file']}:{r['line']}  {r['recommendation']}")
    sys.exit(0)


if __name__ == "__main__":
    main()

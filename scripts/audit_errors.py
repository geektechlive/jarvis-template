#!/usr/bin/env python3
"""Silent-error audit sweep.

Scans harness/ for exception-swallowing patterns and writes findings to
audit_findings.json (append-only, keyed by id).

Run from repo root:  python scripts/audit_errors.py
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


def _scan_except_pass(py_path: Path) -> list[dict]:
    """Flag bare `except: pass` and `except Exception: pass` blocks."""
    findings: list[dict] = []
    try:
        source = py_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (SyntaxError, Exception):
        return findings

    rel = str(py_path.relative_to(REPO_ROOT))
    lines = source.splitlines()

    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        # Check if entire handler body is just `pass` or a single log call
        handler_stmts = node.body
        if len(handler_stmts) == 1 and isinstance(handler_stmts[0], ast.Pass):
            lineno = node.lineno
            snippet = lines[lineno - 1].strip() if lineno <= len(lines) else ""
            fid = _finding_id("silent-except", rel, lineno)
            # Determine severity: bare except or Exception catch is HIGH; typed is MEDIUM
            exc_name = ""
            if node.type is not None:
                if isinstance(node.type, ast.Attribute):
                    exc_name = node.type.attr
                elif isinstance(node.type, ast.Name):
                    exc_name = node.type.id
            if exc_name in ("", "Exception", "BaseException"):
                severity = "HIGH"
                rec = "Surface or log the error; bare pass swallows all exceptions"
            else:
                severity = "MEDIUM"
                rec = f"Consider logging or re-raising {exc_name} rather than silently passing"
            findings.append({
                "id": fid,
                "type": "silent-except",
                "file": rel,
                "line": lineno,
                "severity": severity,
                "recommendation": rec,
                "snippet": snippet[:120],
                "status": "open",
            })

    return findings


def _scan_log_only_except(py_path: Path) -> list[dict]:
    """Flag except blocks that only log without surfacing to caller."""
    findings: list[dict] = []
    try:
        source = py_path.read_text(encoding="utf-8")
    except Exception:
        return findings

    rel = str(py_path.relative_to(REPO_ROOT))
    lines = source.splitlines()

    # Simple line-level heuristic: `except Exception as` or bare `except:` followed
    # by a single log call and nothing else (no raise, no return with error)
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        m = re.match(r"(\s*)except\s*(Exception|BaseException)?\s*(as\s+\w+)?:", line)
        if m:
            indent = len(m.group(1))
            body_lines: list[str] = []
            j = i + 1
            while j < len(lines):
                bl = lines[j]
                stripped = bl.strip()
                if not stripped:
                    j += 1
                    continue
                bl_indent = len(bl) - len(bl.lstrip())
                if bl_indent <= indent:
                    break
                body_lines.append(stripped)
                j += 1
            # log-only: exactly one statement that calls log.*/logger.*
            if (
                len(body_lines) == 1
                and re.search(r"\b(log|logger)\.\w+\(", body_lines[0])
                and not re.search(r"\braise\b", body_lines[0])
            ):
                fid = _finding_id("log-only-except", rel, i + 1)
                findings.append({
                    "id": fid,
                    "type": "log-only-except",
                    "file": rel,
                    "line": i + 1,
                    "severity": "LOW",
                    "recommendation": (
                        "Log-only except hides errors from caller;"
                        " consider returning an error indicator"
                    ),
                    "snippet": (line + " | " + body_lines[0])[:120],
                    "status": "open",
                })
        i += 1
    return findings


def main() -> None:
    existing = _load_existing()
    new_findings: list[dict] = []

    for py_path in sorted(HARNESS_DIR.rglob("*.py")):
        new_findings.extend(_scan_except_pass(py_path))
        new_findings.extend(_scan_log_only_except(py_path))

    merged = dict(existing)
    added = 0
    for f in new_findings:
        if f["id"] not in merged:
            merged[f["id"]] = f
            added += 1

    rows = sorted(merged.values(), key=lambda r: (r["severity"], r["file"], r["line"]))
    with open(FINDINGS_PATH, "w") as out:
        json.dump(rows, out, indent=2)
        out.write("\n")

    open_count = sum(1 for r in rows if r.get("status") == "open")
    high_count = sum(1 for r in rows if r.get("status") == "open" and r.get("severity") == "HIGH")
    print(
        f"audit_errors: {len(rows)} total findings, {open_count} open, {high_count} HIGH. "
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

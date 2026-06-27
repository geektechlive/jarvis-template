#!/usr/bin/env python3
"""
scripts/improve-review.py <branch>

Reviews a self-improvement branch using the Claude CLI (same invocation pattern
as harness-ts/src/llm/claude.ts). Three outcomes:

  approve          -- change is safe; exit 0
  fix_and_approve  -- minor fix applied, amended, force-pushed; exit 0
  reject           -- branch deleted by caller; inbox item written; exit 1

Exit 0 = approved (with or without a fix).
Exit 1 = rejected.
Stdout line 1: "approve" or "reject".  Line 2: reason.
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO_DIR = Path(__file__).parent.parent
DB_PATH = Path.home() / '.jarvis' / 'conversations.db'

# Must match IMPROVABLE_PATHS + isImprovable() in harness-ts/src/improve/index.ts
IMPROVABLE_PATHS = {
    'harness/config/models.yaml',
    'harness/config/staff.yaml',
    'harness/config/routines.yaml',
    'harness/identity/BEHAVIOR.md',
    'harness/identity/MISSION.md',
    'harness/identity/GOALS.md',
    'harness/identity/PROJECTS.md',
}

def is_improvable(filepath: str) -> bool:
    if filepath in IMPROVABLE_PATHS:
        return True
    import re
    return bool(re.match(r'^harness/agents/[^/]+\.md$', filepath))

CANDIDATE_CLAUDE_PATHS = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    str(Path.home() / '.local/bin/claude'),
    str(Path.home() / '.npm-global/bin/claude'),
]

SYSTEM = """\
You review self-improvement patches to an AI agent's config and identity files.
Output valid JSON only. No prose outside the JSON object.

Allowed files: harness/config/models.yaml, harness/config/staff.yaml,
harness/config/routines.yaml, harness/identity/BEHAVIOR.md,
harness/identity/MISSION.md, harness/identity/GOALS.md,
harness/identity/PROJECTS.md, harness/agents/*.md (any agent spec)

Respond with exactly one JSON object:
{
  "decision": "approve"|"fix_and_approve"|"reject",
  "reason": "one sentence",
  "needs_human": false|true,
  "fix": {"filepath": "...", "old": "exact text from current file", "new": "replacement"}
}

The "fix" field is required only when decision is "fix_and_approve"; omit it otherwise.

approve: change is safe and moves the agent in the right direction.
  Good: clearer prompt text, concrete examples added to vague rules,
  AI filler removed, config values tuned sensibly.

fix_and_approve: change direction is right but has a minor correctable issue.
  Correct it yourself and include the fix dict. fix.old MUST be exact text
  that appears in the current file (after the patch is applied -- use the
  post-patch content shown below). Never invent text that is not there.

reject + needs_human=false: clearly wrong, redundant, or regressive. Discard.

reject + needs_human=true: ambiguous or involves a tradeoff the user must decide.

Never approve or fix-approve changes that:
- Remove safety constraints or persona rules
- Add banned tokens: certainly, of course, great question, happy to help,
  let's dive in, as an AI, absolutely
- Make text more formal or corporate-sounding
- Add AI filler phrases
- Touch file paths or infrastructure\
"""

MAX_DIFF_CHARS = 8_000
MAX_FILE_CHARS = 3_000  # per file, for fix reference


def resolve_claude() -> str:
    for p in CANDIDATE_CLAUDE_PATHS:
        if Path(p).exists():
            return p
    return shutil.which('claude') or 'claude'


def normalize_quotes(s: str) -> str:
    return (s
            .replace('‘', "'").replace('’', "'")
            .replace('“', '"').replace('”', '"'))


def write_inbox_rejection(branch: str, reason: str, needs_human: bool) -> None:
    if not DB_PATH.exists():
        return
    content = f"Self-improvement branch {branch} was rejected: {reason}"
    if needs_human:
        content += " -- requires your input to proceed."
    detail = json.dumps({
        'source': 'improve',
        'content': content[:500],
        'score': 0.7,
        'reason': reason[:200],
    })
    try:
        db = sqlite3.connect(str(DB_PATH))
        db.execute(
            "INSERT INTO agent_events (session, event, detail, ts) VALUES (?, ?, ?, ?)",
            ('inbox', 'inbox_batch', detail, int(time.time())),
        )
        db.commit()
        db.close()
    except Exception as e:
        print(f"[improve-review] warn: could not write inbox item: {e}", file=sys.stderr)


def reject(branch: str, reason: str, needs_human: bool = False) -> None:
    print("reject")
    print(reason)
    write_inbox_rejection(branch, reason, needs_human)
    sys.exit(1)


def apply_fix(branch: str, filepath: str, old: str, new: str) -> bool:
    """Apply a Claude-suggested fix to the branch, amend the commit, force-push."""
    if not is_improvable(filepath):
        print(f"[improve-review] fix targets non-improvable file: {filepath}", file=sys.stderr)
        return False

    abs_path = REPO_DIR / filepath
    if not abs_path.exists():
        print(f"[improve-review] fix target not found: {filepath}", file=sys.stderr)
        return False

    content = abs_path.read_text(encoding='utf-8')
    content_norm = normalize_quotes(content)
    old_norm = normalize_quotes(old)

    if old_norm not in content_norm:
        print(f"[improve-review] fix old text not found in {filepath}", file=sys.stderr)
        return False

    updated = content_norm.replace(old_norm, new, 1)
    abs_path.write_text(updated, encoding='utf-8')

    r = subprocess.run(
        ['git', '-C', str(REPO_DIR), 'add', filepath],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"[improve-review] git add failed: {r.stderr}", file=sys.stderr)
        return False

    r = subprocess.run(
        ['git', '-C', str(REPO_DIR), 'commit', '--amend', '--no-edit'],
        capture_output=True, text=True,
        env={
            **os.environ,
            'GIT_AUTHOR_NAME': 'Jarvis', 'GIT_AUTHOR_EMAIL': 'jarvis@agentharness.local',
            'GIT_COMMITTER_NAME': 'Jarvis', 'GIT_COMMITTER_EMAIL': 'jarvis@agentharness.local',
        },
    )
    if r.returncode != 0:
        print(f"[improve-review] amend failed: {r.stderr}", file=sys.stderr)
        return False

    r = subprocess.run(
        ['git', '-C', str(REPO_DIR), 'push', '--force-with-lease', 'origin', branch],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"[improve-review] force push failed: {r.stderr}", file=sys.stderr)
        return False

    return True


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: improve-review.py <branch>", file=sys.stderr)
        sys.exit(2)

    branch = sys.argv[1]

    # Validate branch exists
    r = subprocess.run(
        ['git', '-C', str(REPO_DIR), 'rev-parse', '--verify', branch],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        reject(branch, f"Branch {branch} not found in repo")

    # Get changed files
    r = subprocess.run(
        ['git', '-C', str(REPO_DIR), 'diff', '--name-only', f'main...{branch}'],
        capture_output=True, text=True,
    )
    changed = [f.strip() for f in r.stdout.splitlines() if f.strip()]

    if not changed:
        print("approve")
        print("No changes detected")
        sys.exit(0)

    for f in changed:
        if not is_improvable(f):
            reject(branch, f"Change to non-improvable file: {f}", needs_human=False)

    # Get the diff (pre-validated: only touches config/identity files)
    r = subprocess.run(
        ['git', '-C', str(REPO_DIR), 'diff', f'main...{branch}'],
        capture_output=True, text=True,
    )
    diff = r.stdout

    if len(diff) > MAX_DIFF_CHARS:
        reject(
            branch,
            f"Diff too large ({len(diff)} chars) -- manual review required",
            needs_human=True,
        )

    # Include current file content so Claude can form accurate fix.old references
    file_sections = []
    for f in changed:
        abs_path = REPO_DIR / f
        if abs_path.exists():
            content = abs_path.read_text(encoding='utf-8')[:MAX_FILE_CHARS]
            file_sections.append(f"=== {f} (current, post-patch) ===\n{content}")
    file_context = "\n\n".join(file_sections)

    user_msg = (
        f"Branch: {branch}\n\n"
        f"Diff:\n{diff}\n\n"
        f"{file_context}"
    )

    claude = resolve_claude()
    try:
        proc = subprocess.run(
            [
                claude, '-p',
                '--output-format', 'json',
                '--model', 'claude-haiku-4-5-20251001',
                '--system-prompt', SYSTEM,
                '--permission-mode', 'bypassPermissions',
                '--no-session-persistence',
                user_msg,
            ],
            capture_output=True, text=True,
            timeout=90,
            cwd=str(REPO_DIR),
        )
    except subprocess.TimeoutExpired:
        reject(branch, "Claude CLI timed out -- manual review required", needs_human=True)
        return
    except Exception as e:
        reject(branch, f"Claude CLI error: {e}", needs_human=True)
        return

    if proc.returncode != 0 or not proc.stdout.strip():
        reject(branch, "Claude CLI returned non-zero or empty output", needs_human=True)

    try:
        envelope = json.loads(proc.stdout.strip())
        result_text = (envelope.get('result') or '').strip()
        result = json.loads(result_text)
        decision = result.get('decision', 'reject')
        reason = result.get('reason', 'no reason given')
        needs_human = bool(result.get('needs_human', False))
    except Exception as e:
        reject(branch, f"Could not parse Claude response: {e}", needs_human=True)
        return

    if decision == 'approve':
        print("approve")
        print(reason)
        sys.exit(0)

    elif decision == 'fix_and_approve':
        fix = result.get('fix')
        if (isinstance(fix, dict)
                and fix.get('filepath')
                and fix.get('old') is not None
                and fix.get('new') is not None):
            success = apply_fix(branch, fix['filepath'], fix['old'], fix['new'])
            if success:
                print("approve")
                print(f"[fixed and approved] {reason}")
                sys.exit(0)
        # Fix failed or malformed -- fall back to reject
        reject(
            branch,
            f"fix_and_approve: could not apply suggested fix -- {reason}",
            needs_human=True,
        )

    else:
        reject(branch, reason, needs_human)


if __name__ == '__main__':
    main()

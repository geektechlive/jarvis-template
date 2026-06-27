#!/usr/bin/env python3
"""
notes-create -- create a note in Notes.app via AppleScript.

Requires GUI session context (runs correctly via the ion LaunchAgent;
not usable via plain SSH which lacks keychain/window-server access).

Usage:
  notes-create.py --title TEXT --body TEXT [--folder FOLDER]

Output: JSON {id, title, folder}
"""

import argparse
import json
import subprocess
import sys


def escape_applescript(s: str) -> str:
    """Escape backslash and double-quote for AppleScript string literals."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def create_note(title: str, body: str, folder: str) -> dict:  # type: ignore[type-arg]
    safe_title = escape_applescript(title)
    safe_body = escape_applescript(body)

    note_props = f'{{name:"{safe_title}", body:"{safe_title}\\n{safe_body}"}}'
    if folder:
        safe_folder = escape_applescript(folder)
        script = f"""
tell application "Notes"
    set targetFolder to missing value
    repeat with f in folders
        if name of f is "{safe_folder}" then
            set targetFolder to f
            exit repeat
        end if
    end repeat
    if targetFolder is missing value then
        set targetFolder to make new folder with properties {{name:"{safe_folder}"}}
    end if
    set newNote to make new note at targetFolder with properties {note_props}
    set noteId to id of newNote as text
    set noteFolder to name of container of newNote as text
    return noteId & "|" & noteFolder
end tell
"""
    else:
        script = f"""
tell application "Notes"
    set newNote to make new note with properties {note_props}
    set noteId to id of newNote as text
    set noteFolder to name of container of newNote as text
    return noteId & "|" & noteFolder
end tell
"""

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=15,
    )

    if result.returncode != 0:
        err = (result.stderr or "").strip() or f"exit {result.returncode}"
        return {"error": f"AppleScript failed: {err}"}

    output = result.stdout.strip()
    parts = output.split("|", 1)
    note_id = parts[0].strip() if parts else ""
    note_folder = parts[1].strip() if len(parts) > 1 else folder

    return {"id": note_id, "title": title, "folder": note_folder}


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a note in Notes.app via AppleScript")
    parser.add_argument("--title", required=True, help="Note title")
    parser.add_argument("--body", required=True, help="Note body text")
    parser.add_argument("--folder", default="", help="Folder name (created if absent)")

    args = parser.parse_args()

    if not args.title.strip():
        print(json.dumps({"error": "title cannot be empty"}))
        sys.exit(1)

    result = create_note(args.title, args.body, args.folder)

    if "error" in result:
        print(json.dumps(result))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

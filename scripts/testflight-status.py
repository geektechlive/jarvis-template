#!/usr/bin/env python3
"""
testflight-status -- query App Store Connect for TestFlight build processing state.

Credentials: ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
             ASC_KEY_ID and ASC_ISSUER_ID env vars (or ~/.asc-credentials).

Usage:
  testflight-status                  # show last 5 builds
  testflight-status --watch          # poll until VALID or INVALID, then exit 0/1
  testflight-status --watch --timeout 1200  # max wait in seconds (default 900)
  testflight-status --build N        # check specific build number
  testflight-status --json           # machine-readable output

Requires: pip3 install pyjwt cryptography
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import urllib.error
    import urllib.request

    import jwt
except ImportError:
    print("ERROR: pyjwt not installed. Run: pip3 install pyjwt cryptography", file=sys.stderr)
    sys.exit(1)

ASC_API_BASE = "https://api.appstoreconnect.apple.com/v1"
DEFAULT_TIMEOUT = 900  # 15 minutes
POLL_INTERVAL = 30


def load_credentials():
    key_id = os.environ.get("ASC_KEY_ID")
    issuer_id = os.environ.get("ASC_ISSUER_ID")

    if not key_id or not issuer_id:
        creds_file = Path("~/.asc-credentials").expanduser()
        if creds_file.exists():
            for line in creds_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("ASC_KEY_ID="):
                    key_id = line.split("=", 1)[1]
                elif line.startswith("ASC_ISSUER_ID="):
                    issuer_id = line.split("=", 1)[1]

    if not key_id or not issuer_id:
        print(
            "ERROR: ASC_KEY_ID and ASC_ISSUER_ID must be set (env vars or ~/.asc-credentials)",
            file=sys.stderr,
        )
        sys.exit(1)

    key_path = Path(f"~/.appstoreconnect/private_keys/AuthKey_{key_id}.p8").expanduser()
    if not key_path.exists():
        print(f"ERROR: ASC private key not found: {key_path}", file=sys.stderr)
        sys.exit(1)

    return key_id, issuer_id, key_path.read_text()


def make_jwt(key_id: str, issuer_id: str, private_key: str) -> str:
    now = int(time.time())
    payload = {
        "iss": issuer_id,
        "iat": now,
        "exp": now + 240,
        "aud": "appstoreconnect-v1",
    }
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": key_id})


def api_get(path: str, token: str) -> dict:
    url = f"{ASC_API_BASE}{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"ERROR: ASC API {e.code}: {body[:200]}", file=sys.stderr)
        sys.exit(1)


def fetch_builds(
    key_id: str, issuer_id: str, private_key: str,
    build_number: str | None = None, limit: int = 5,
) -> list[dict]:
    token = make_jwt(key_id, issuer_id, private_key)
    params = f"?sort=-uploadedDate&limit={limit}"
    if build_number:
        params += f"&filter[version]={build_number}"
    data = api_get(f"/builds{params}", token)
    return data.get("data", [])


def format_build(build: dict) -> str:
    attrs = build.get("attributes", {})
    version = attrs.get("version", "?")
    uploaded = attrs.get("uploadedDate", "?")
    state = attrs.get("processingState", "?")
    expired = attrs.get("expired", False)

    if uploaded != "?":
        try:
            dt = datetime.fromisoformat(uploaded.replace("Z", "+00:00"))
            uploaded = dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
        except ValueError:
            pass

    expired_note = " [EXPIRED]" if expired else ""
    return f"Build {version}: {state}{expired_note} (uploaded {uploaded})"


def main():
    parser = argparse.ArgumentParser(description="Query TestFlight build processing state")
    parser.add_argument("--watch", action="store_true", help="Poll until VALID or INVALID")
    parser.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT, help="Max seconds to poll (default 900)"
    )
    parser.add_argument("--build", help="Filter by specific build number")
    parser.add_argument("--limit", type=int, default=5, help="Number of builds to show (default 5)")
    parser.add_argument("--json", action="store_true", dest="json_out", help="JSON output")
    args = parser.parse_args()

    key_id, issuer_id, private_key = load_credentials()

    if args.watch:
        deadline = time.time() + args.timeout
        print(f"Polling ASC API every {POLL_INTERVAL}s (timeout {args.timeout}s)...")
        while time.time() < deadline:
            builds = fetch_builds(key_id, issuer_id, private_key, args.build, limit=3)
            if not builds:
                print("No builds found yet, retrying...")
                time.sleep(POLL_INTERVAL)
                continue

            latest = builds[0]
            attrs = latest.get("attributes", {})
            state = attrs.get("processingState", "UNKNOWN")
            version = attrs.get("version", "?")

            print(f"[{datetime.now().strftime('%H:%M:%S')}] Build {version}: {state}")
            sys.stdout.flush()

            if state == "VALID":
                print(f"\nBuild {version} is VALID and ready in TestFlight.")
                if args.json_out:
                    print(json.dumps({"status": "VALID", "build": version, "data": latest}))
                sys.exit(0)
            elif state == "INVALID":
                print(f"\nBuild {version} is INVALID — check App Store Connect for details.")
                if args.json_out:
                    print(json.dumps({"status": "INVALID", "build": version, "data": latest}))
                sys.exit(1)

            time.sleep(POLL_INTERVAL)

        print(f"\nTimeout after {args.timeout}s. Build still processing -- not a failure.")
        sys.exit(0)

    else:
        builds = fetch_builds(key_id, issuer_id, private_key, args.build, args.limit)
        if not builds:
            print("No builds found.")
            sys.exit(0)

        if args.json_out:
            print(json.dumps({"data": builds}, indent=2))
        else:
            for b in builds:
                print(format_build(b))


if __name__ == "__main__":
    main()

"""
netflix-setup.py

Reads Netflix session cookies from Safari's binary cookie store and saves
them to the macOS Keychain under com.example.jarvis.

Run via:
    /opt/homebrew/bin/uv run python scripts/netflix-setup.py
"""

import struct
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

# Mac epoch offset: 2001-01-01T00:00:00Z in Unix seconds
MAC_EPOCH_OFFSET = 978307200

KEYCHAIN_SERVICE = "com.example.jarvis"

COOKIE_MAP = {
    "NetflixId": "netflix_id",
    "SecureNetflixId": "netflix_secure_id",
}

NETFLIX_DOMAIN = "netflix.com"


def find_cookie_file() -> Path:
    candidates = [
        Path.home() / "Library/Containers/com.apple.Safari/Data/Library/Cookies"
        / "Cookies.binarycookies",
        Path.home() / "Library/Cookies/Cookies.binarycookies",
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(
        "Safari cookie file not found. "
        "Make sure Safari has been launched on this machine."
    )


def parse_binarycookies(data: bytes) -> list[dict]:
    """Parse the Safari binary cookies format and return a list of cookie dicts."""
    if data[:4] != b"cook":
        raise ValueError("Not a valid Safari binary cookies file (bad magic bytes).")

    offset = 4
    page_count = struct.unpack_from(">I", data, offset)[0]
    offset += 4

    page_sizes: list[int] = []
    for _ in range(page_count):
        page_sizes.append(struct.unpack_from(">I", data, offset)[0])
        offset += 4

    cookies: list[dict] = []

    for page_size in page_sizes:
        page_data = data[offset : offset + page_size]
        offset += page_size
        cookies.extend(_parse_page(page_data))

    return cookies


def _parse_page(page: bytes) -> list[dict]:
    """Parse a single page of cookies."""
    # Page magic is 0x00000100 little-endian
    page_magic = struct.unpack_from("<I", page, 0)[0]
    if page_magic != 0x00010000:
        return []

    num_cookies = struct.unpack_from("<I", page, 4)[0]

    cookie_offsets: list[int] = []
    for i in range(num_cookies):
        cookie_offsets.append(struct.unpack_from("<I", page, 8 + i * 4)[0])

    cookies: list[dict] = []
    for cookie_offset in cookie_offsets:
        try:
            cookie = _parse_cookie(page, cookie_offset)
            cookies.append(cookie)
        except Exception:
            # Skip malformed records
            pass

    return cookies


def _parse_cookie(page: bytes, record_start: int) -> dict:
    """Parse a single cookie record from a page at record_start."""
    size          = struct.unpack_from("<I", page, record_start)[0]
    flags         = struct.unpack_from("<I", page, record_start + 8)[0]
    domain_offset = struct.unpack_from("<I", page, record_start + 16)[0]
    name_offset   = struct.unpack_from("<I", page, record_start + 20)[0]
    path_offset   = struct.unpack_from("<I", page, record_start + 24)[0]
    value_offset  = struct.unpack_from("<I", page, record_start + 28)[0]
    expiry_mac    = struct.unpack_from("<d", page, record_start + 40)[0]
    creation_mac  = struct.unpack_from("<d", page, record_start + 48)[0]

    record_bytes = page[record_start : record_start + size]

    def read_string(rel_offset: int) -> str:
        start = rel_offset
        end = record_bytes.index(b"\x00", start)
        return record_bytes[start:end].decode("utf-8", errors="replace")

    domain   = read_string(domain_offset)
    name     = read_string(name_offset)
    path     = read_string(path_offset)
    value    = read_string(value_offset)
    expiry   = expiry_mac + MAC_EPOCH_OFFSET
    creation = creation_mac + MAC_EPOCH_OFFSET
    secure   = bool(flags & 1)
    http_only = bool(flags & 4)

    return {
        "domain": domain,
        "name": name,
        "path": path,
        "value": value,
        "expiry": expiry,
        "creation": creation,
        "secure": secure,
        "http_only": http_only,
    }


def store_in_keychain(account: str, value: str) -> None:
    """Delete any existing entry then write the new value."""
    subprocess.run(
        [
            "security",
            "delete-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", account,
        ],
        capture_output=True,
    )

    result = subprocess.run(
        [
            "security",
            "add-generic-password",
            "-s", KEYCHAIN_SERVICE,
            "-a", account,
            "-w", value,
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to store {account} in Keychain: {result.stderr.strip()}"
        )


def main() -> None:
    try:
        cookie_file = find_cookie_file()
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    data = cookie_file.read_bytes()

    try:
        all_cookies = parse_binarycookies(data)
    except ValueError as exc:
        print(f"Error parsing cookie file: {exc}", file=sys.stderr)
        sys.exit(1)

    all_netflix = [c for c in all_cookies if NETFLIX_DOMAIN in c["domain"]]

    if not any(c["name"] == "NetflixId" for c in all_netflix):
        print(
            "Netflix cookies not found — make sure you're logged into Netflix in Safari"
            " and try again",
            file=sys.stderr,
        )
        sys.exit(1)

    # Store the full cookie header string so the fetch script passes every cookie Netflix sees.
    cookie_header = "; ".join(f"{c['name']}={c['value']}" for c in all_netflix)
    try:
        store_in_keychain("netflix_cookies", cookie_header)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    netflix_id = next(c for c in all_netflix if c["name"] == "NetflixId")
    expiry_dt = datetime.fromtimestamp(netflix_id["expiry"], tz=UTC)
    expiry_str = expiry_dt.strftime("%Y-%m-%d %H:%M UTC")
    print(f"Stored {len(all_netflix)} Netflix cookies in Keychain.")
    print(f"NetflixId expires: {expiry_str}")
    print("Run: npx tsx ~/Jarvis/scripts/netflix-history.ts")


if __name__ == "__main__":
    main()

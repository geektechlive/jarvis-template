# apple-foundation

On-device Apple Foundation Models inference for Jarvis. Free, offline, ~200-360ms
warm per call on the M2 Mini (macOS 26, Apple Intelligence on). Implements issue
[#775](https://github.com/<your-org>/jarvis/issues/775).

## Why two processes

`FoundationModels` is a **Swift-only** framework (no HTTP/CLI). So:

- **`afm`** (Swift, `Sources/afm/AFM.swift`) is the only thing that touches the
  model. It reads newline-delimited JSON requests on stdin and writes one JSON
  response per line on stdout. Built with `swift build -c release` (Command Line
  Tools only — no Xcode, so the `@Generable` macro is unavailable; we use the
  runtime `DynamicGenerationSchema` API instead).
- **`server.py`** (Python, stdlib only) spawns `afm` once, keeps it warm,
  serialises access, and exposes HTTP on `127.0.0.1:9878` so the harness calls it
  like the vector server.

## Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET  | `/health` | — | `{"ok","availability","pid"}` |
| POST | `/generate` | `{prompt, instructions?}` | `{"ok","content"}` |
| POST | `/generate_typed` | `{prompt, schema, instructions?}` | `{"ok","content"}` where `content` is a JSON string |

`schema` is a flat property spec (not full JSON-Schema):
`{"properties":[{"name","type":"string|string[]|number|boolean","enum"?,"description"?}]}`.

## Build & run (on the Mini)

```bash
cd tools-py/apple-foundation
swift build -c release
AFM_BIN=$PWD/.build/release/afm python3 server.py   # or via the launchd plist
```

Deploy: `make deploy-apple-foundation` (builds on the Mini, installs the plist).
Status: `make apple-foundation-status`. Logs: `make apple-foundation-logs`.

## Constraints

- On-device model: **4K context, no reasoning**. Good for classification,
  tagging, extraction, short summaries; not long-context synthesis or code/math.
- Private Cloud Compute (32K + reasoning) needs **macOS 27** — not available yet.
- If Apple Intelligence is off / model unavailable, every request returns
  `ok:false` so callers fall back to their prior backend.

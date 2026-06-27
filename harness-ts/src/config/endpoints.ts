// Local-host endpoints for tools-py FastAPI servers and the voice TTS server.
// Centralized so endpoint URLs are one ctrl-F away and trivially mockable.

export const VOICE_SERVER = 'http://127.0.0.1:9877'
export const VEC_SERVER = 'http://127.0.0.1:9876'
export const VEC_TIMEOUT_MS = 5000
// On-device Apple Foundation Models service (tools-py/apple-foundation), issue #775.
export const AFM_SERVER = process.env['AFM_SERVER'] ?? 'http://127.0.0.1:9878'

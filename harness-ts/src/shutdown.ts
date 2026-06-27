import { log } from 'ion-sdk'
import { stop as stopAutonomy } from './autonomy'

// Graceful shutdown: launchd sends SIGTERM, manual ^C sends SIGINT.
// Autonomy loop is a no-op (ion engine owns its lifecycle),
// but we call it for clean log output.
function gracefulShutdown(signal: string): void {
  log.info('jarvis: shutdown requested', { signal })
  try { stopAutonomy() } catch (err: unknown) { log.warn('jarvis: stopAutonomy error', { err: String(err) }) }
}

export function wireShutdown(): void {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
}

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { log } from 'ion-sdk'

interface FileCursor {
  lastByteOffset: number
  lastInode?: number
}

interface CursorState {
  [logPath: string]: FileCursor
}

const CURSOR_PATH = path.join(os.homedir(), '.jarvis', 'log-patrol-cursor.json')

function readCursor(): CursorState {
  try {
    if (fs.existsSync(CURSOR_PATH)) {
      const data = fs.readFileSync(CURSOR_PATH, 'utf8')
      return JSON.parse(data) as CursorState
    }
  } catch (err) {
    log.warn('log-patrol-cursor: failed to read cursor, resetting', { err: String(err) })
  }
  return {}
}

function writeCursor(state: CursorState): void {
  try {
    fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true })
    fs.writeFileSync(CURSOR_PATH, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    log.warn('log-patrol-cursor: failed to write cursor', { err: String(err) })
  }
}

export function readLogSlice(logPath: string, maxLines: number): string {
  const state = readCursor()
  const hasExistingCursor = logPath in state
  const cursor = state[logPath] ?? { lastByteOffset: 0 }

  try {
    const stats = fs.statSync(logPath)
    const currentSize = stats.size
    const currentInode = stats.ino

    // Cold start: no prior cursor for this file. Seed at EOF so the first
    // run does NOT replay the entire historical log as "new" content. This
    // mirrors a tail -f starting from now, not from the beginning. Without
    // this, a fresh cursor (or a deleted cursor file) sees the whole file
    // and patrol re-files every old error.
    if (!hasExistingCursor) {
      state[logPath] = { lastByteOffset: currentSize, lastInode: currentInode }
      writeCursor(state)
      return ''
    }

    // If inode changed or size shrank, file was rotated/truncated
    if (cursor.lastInode && cursor.lastInode !== currentInode) {
      cursor.lastByteOffset = 0
    } else if (cursor.lastByteOffset > currentSize) {
      cursor.lastByteOffset = 0
    }

    // Read from cursor offset to EOF
    let slice = ''
    if (cursor.lastByteOffset < currentSize) {
      const buffer = Buffer.alloc(currentSize - cursor.lastByteOffset)
      const fd = fs.openSync(logPath, 'r')
      try {
        fs.readSync(fd, buffer, 0, buffer.length, cursor.lastByteOffset)
        slice = buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    }

    // Cap to last N lines
    const lines = slice.split('\n')
    const cappedLines = lines.slice(-maxLines)
    const cappedSlice = cappedLines.join('\n')

    // Update cursor for next run
    state[logPath] = {
      lastByteOffset: currentSize,
      lastInode: currentInode,
    }
    writeCursor(state)

    return cappedSlice
  } catch (err) {
    log.warn(`log-patrol-cursor: failed to read ${logPath}`, { err: String(err) })
    return ''
  }
}

export function resetCursor(): void {
  try {
    if (fs.existsSync(CURSOR_PATH)) {
      fs.unlinkSync(CURSOR_PATH)
    }
  } catch (err) {
    log.warn('log-patrol-cursor: failed to reset cursor', { err: String(err) })
  }
}

// RSS feed fetcher. Reads harness/config/feeds.yaml, fetches each feed,
// filters by freshness and quality, and stores notable items to the
// news collection via the vec server (with a 14-day TTL per #850).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import Parser from 'rss-parser'

import { log } from 'ion-sdk'
import { HARNESS_DIR } from '../config'
import { remember } from '../memory/recall'

const FRESHNESS_MS = 48 * 60 * 60 * 1000  // 48 hours
const MIN_TITLE_LEN = 20
const SNIPPET_MAX = 300
const MAX_ITEMS_PER_FEED = 50

interface FeedConfig {
  id: string
  url: string
  category: string
  signal: string
  description: string
}

// Hand-rolled YAML parser matching the depth-based pattern used elsewhere
// in this codebase. Feeds.yaml is a top-level list under the "feeds:" key.
function parseFeedsYaml(content: string): FeedConfig[] {
  const feeds: FeedConfig[] = []
  let inFeeds = false
  let current: Partial<FeedConfig> | null = null

  for (const line of content.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const depth = line.length - line.trimStart().length
    const trimmed = line.trimStart()

    if (depth === 0) {
      inFeeds = trimmed.startsWith('feeds:')
      if (!inFeeds && current?.id) {
        feeds.push(current as FeedConfig)
        current = null
      }
      continue
    }
    if (!inFeeds) continue

    // Depth 2: new list entry "- id: ..."
    if (depth === 2 && trimmed.startsWith('- id:')) {
      if (current?.id) feeds.push(current as FeedConfig)
      current = {
        id: trimmed.replace(/^- id:\s*/, '').replace(/^['"]|['"]$/g, '').trim(),
        url: '',
        category: '',
        signal: 'medium',
        description: '',
      }
      continue
    }

    if (!current) continue

    // Depth 4: feed fields
    if (depth === 4) {
      if (/^url:/.test(trimmed)) {
        current.url = trimmed.replace(/^url:\s*/, '').replace(/^['"]|['"]$/g, '').trim()
      } else if (/^category:/.test(trimmed)) {
        current.category = trimmed.replace(/^category:\s*/, '').replace(/^['"]|['"]$/g, '').trim()
      } else if (/^signal:/.test(trimmed)) {
        current.signal = trimmed.replace(/^signal:\s*/, '').replace(/^['"]|['"]$/g, '').trim()
      } else if (/^description:/.test(trimmed)) {
        current.description = trimmed.replace(/^description:\s*/, '').replace(/^['"]|['"]$/g, '').trim()
      }
    }
  }
  if (current?.id) feeds.push(current as FeedConfig)
  return feeds
}

function loadFeedsConfig(): FeedConfig[] {
  try {
    const content = readFileSync(join(HARNESS_DIR, 'harness/config/feeds.yaml'), 'utf8')
    return parseFeedsYaml(content)
  } catch (err) {
    log.warn('feeds: could not load feeds.yaml', { err: String(err) })
    return []
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

function isFresh(item: Parser.Item): boolean {
  const raw = item.pubDate ?? item.isoDate
  if (!raw) return true  // no date = assume fresh rather than discard
  const ts = new Date(raw).getTime()
  if (isNaN(ts)) return true
  return Date.now() - ts < FRESHNESS_MS
}

function isQuality(title: string, description: string): boolean {
  return title.length >= MIN_TITLE_LEN && description.length > 0
}

export async function fetchAndStoreFeeds(): Promise<number> {
  const feeds = loadFeedsConfig()
  if (!feeds.length) {
    log.warn('feeds: no feeds configured')
    return 0
  }

  const parser = new Parser({ timeout: 15_000 })
  let stored = 0

  for (const feed of feeds) {
    try {
      try { new URL(feed.url) } catch {
        log.warn('feeds: invalid feed URL, skipping', { id: feed.id, url: feed.url })
        continue
      }
      log.info('feeds: fetching', { id: feed.id, url: feed.url })
      // Use native fetch + parseString instead of parseURL to avoid rss-parser's
      // internal url.parse() call (DEP0169) in its HTTP layer.
      const feedRes = await fetch(feed.url, { signal: AbortSignal.timeout(15_000) })
      if (!feedRes.ok) throw new Error(`HTTP ${feedRes.status}`)
      const parsed = await parser.parseString(await feedRes.text())

      let feedStored = 0
      for (const item of parsed.items ?? []) {
        if (feedStored >= MAX_ITEMS_PER_FEED) break

        const title = (item.title ?? '').trim()
        const rawDescription = item.contentSnippet ?? item.content ?? item.summary ?? ''
        const description = stripHtml(rawDescription).slice(0, SNIPPET_MAX)

        if (!isFresh(item)) continue
        if (!isQuality(title, description)) continue

        const text = `[${feed.category}] ${title}: ${description}`
        const result = await remember(text, 'news', `feed:${feed.id}`, 'jarvis_inference', { ttl_days: 14 })
        if (result.ok) {
          stored++
          feedStored++
        } else {
          log.debug('feeds: remember failed', { id: feed.id, reason: result.reason })
        }
      }

      log.info('feeds: feed done', { id: feed.id, stored: feedStored, capped: feedStored >= MAX_ITEMS_PER_FEED })
    } catch (err) {
      log.warn('feeds: fetch failed', { id: feed.id, err: String(err) })
    }
  }

  return stored
}

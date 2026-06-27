// Fetch Netflix viewing history via authenticated Netflix API.
//
// Requires two Keychain entries (one-time setup):
//   security add-generic-password -s com.example.jarvis -a netflix_id -w <NetflixId>
//   security add-generic-password -s com.example.jarvis -a netflix_secure_id -w <SecureNetflixId>
//
// Get cookies from any browser: DevTools → Application → Cookies → netflix.com
//
// Output (stdout): { "count": N, "outputPath": "...", "fetchedAt": "..." }
// Errors go to stderr with actionable instructions.

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEYCHAIN_SERVICE = 'com.example.jarvis'
const OUTPUT_DIR = join(
  homedir(),
  'Library',
  'Mobile Documents',
  'com~apple~CloudDocs',
  'Jarvis',
  'entertainment',
)
const OUTPUT_PATH = join(OUTPUT_DIR, 'netflix-history.jsonl')

interface NetflixViewedItem {
  videoId: number
  title: string
  seriesTitle?: string
  episodeTitle?: string
  date: number
  cumDuration?: number
  duration?: number
  percentWatched?: number
}

interface HistoryEntry {
  videoId: number
  title: string
  seriesTitle: string
  episodeTitle: string
  date: string
  durationSecs: number
  percentWatched: number
  fetchedAt: string
}

function getKeychainSecret(key: string): string | null {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key, '-w'],
    { encoding: 'utf8' },
  )
  return result.status === 0 ? result.stdout.trim() || null : null
}

const CURL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

function curlGet(url: string, cookieHeader: string, extraHeaders: string[] = []): { status: number; body: string } {
  const args = [
    '-s', '-L', '--http1.1',
    '-w', '\n__STATUS__%{http_code}',
    '-H', `Cookie: ${cookieHeader}`,
    '-H', `User-Agent: ${CURL_UA}`,
    '-H', 'Accept-Language: en-US,en;q=0.9',
  ]
  for (const h of extraHeaders) args.push('-H', h)
  args.push(url)

  const result = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (result.error) throw new Error(`curl failed: ${result.error.message}`)

  const output = result.stdout
  const statusMatch = /\n__STATUS__(\d+)$/.exec(output)
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0
  return { status, body: output.replace(/\n__STATUS__\d+$/, '') }
}

function credentialError(): never {
  process.stderr.write(
    [
      'Netflix credentials not found in Keychain.',
      '',
      'One-time setup:',
      '  1. Open Netflix in Safari and log in',
      '  2. Open DevTools → Application → Cookies → netflix.com',
      '  3. Copy the value of NetflixId and SecureNetflixId',
      '  4. Run:',
      '     security add-generic-password -s com.example.jarvis -a netflix_id -w <NetflixId>',
      '     security add-generic-password -s com.example.jarvis -a netflix_secure_id -w <SecureNetflixId>',
    ].join('\n') + '\n',
  )
  process.exit(1)
}

function authError(): never {
  process.stderr.write(
    [
      'Netflix returned 401/403 — session cookies have expired.',
      '',
      'Refresh:',
      '  1. Open Netflix in Safari and log in',
      '  2. Get fresh NetflixId and SecureNetflixId from DevTools cookies',
      '  3. Run:',
      '     security delete-generic-password -s com.example.jarvis -a netflix_id',
      '     security delete-generic-password -s com.example.jarvis -a netflix_secure_id',
      '     security add-generic-password -s com.example.jarvis -a netflix_id -w <new NetflixId>',
      '     security add-generic-password -s com.example.jarvis -a netflix_secure_id -w <new SecureNetflixId>',
    ].join('\n') + '\n',
  )
  process.exit(1)
}

function getHomePageData(cookieHeader: string): { buildId: string; authURL: string } {
  const { status, body } = curlGet('https://www.netflix.com/', cookieHeader, [
    'Accept: text/html,application/xhtml+xml',
  ])
  if (status === 401 || status === 403) authError()
  const buildMatch = /"BUILD_IDENTIFIER"\s*:\s*"([^"]+)"/.exec(body)
  if (!buildMatch?.[1]) throw new Error('Could not extract BUILD_IDENTIFIER from Netflix homepage')
  const authMatch = /"authURL"\s*:\s*"([^"]+)"/.exec(body)
  if (!authMatch?.[1]) throw new Error('Could not extract authURL from Netflix homepage')
  return { buildId: buildMatch[1], authURL: authMatch[1] }
}

function fetchPage(
  buildId: string,
  authURL: string,
  cookieHeader: string,
  page: number,
): { items: NetflixViewedItem[]; total: number } {
  const url = `https://www.netflix.com/api/shakti/${buildId}/viewingactivity?authURL=${encodeURIComponent(authURL)}&pg=${page}&pgSize=100`
  const { status, body } = curlGet(url, cookieHeader, [
    'Accept: application/json',
    'Referer: https://www.netflix.com/viewingactivity',
    'X-Netflix.browserName: Safari',
    'X-Netflix.browserVersion: 18',
    'X-Netflix.osName: MacOS',
  ])
  if (status === 401 || status === 403) authError()
  if (status < 200 || status >= 300) throw new Error(`Netflix API returned ${status}`)
  const data = JSON.parse(body) as {
    viewedItems?: NetflixViewedItem[]
    totalVideoCount?: number
  }
  return { items: data.viewedItems ?? [], total: data.totalVideoCount ?? 0 }
}

function transform(item: NetflixViewedItem, fetchedAt: string): HistoryEntry {
  return {
    videoId: item.videoId,
    title: item.title,
    seriesTitle: item.seriesTitle ?? '',
    episodeTitle: item.episodeTitle ?? '',
    date: new Date(item.date).toISOString().slice(0, 10),
    durationSecs: item.cumDuration ?? item.duration ?? 0,
    percentWatched: item.percentWatched ?? 0,
    fetchedAt,
  }
}

function main(): void {
  const cookieHeader = getKeychainSecret('netflix_cookies')
  if (!cookieHeader) credentialError()
  const fetchedAt = new Date().toISOString()

  process.stderr.write('Fetching Netflix homepage data...\n')
  const { buildId, authURL } = getHomePageData(cookieHeader)
  process.stderr.write(`Build ID: ${buildId}\n`)

  const allItems: HistoryEntry[] = []
  let page = 0
  let total = Infinity

  while (allItems.length < total) {
    process.stderr.write(
      `Fetching page ${page} (${allItems.length}/${total === Infinity ? '?' : total})...\n`,
    )
    const { items, total: t } = fetchPage(buildId, authURL, cookieHeader, page)
    if (page === 0) total = t
    for (const item of items) allItems.push(transform(item, fetchedAt))
    if (items.length === 0) break
    page++
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(OUTPUT_PATH, allItems.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

  process.stdout.write(JSON.stringify({ count: allItems.length, outputPath: OUTPUT_PATH, fetchedAt }) + '\n')
}

try {
  main()
} catch (err: unknown) {
  process.stderr.write(`Error: ${String(err)}\n`)
  process.exit(1)
}

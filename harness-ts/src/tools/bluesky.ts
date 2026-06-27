// Bluesky posting tool for the Jarvis harness.
//
// Wraps @atproto/api (BskyAgent + RichText) to provide four operations:
//   post    -- create a new top-level post
//   reply   -- reply to an existing post
//   repost  -- repost (retweet equivalent)
//   like    -- like a post
//
// Auth via app password. Credentials come from macOS Keychain:
//   bluesky-identifier   -- account handle, e.g. user.bsky.social
//   bluesky-app-password -- app password generated in Bluesky settings
//
// Session token is cached in memory for the lifetime of the process.
// Bluesky enforces a hard limit of 300 session creations per account per day,
// so we must not re-authenticate on every tool call. The cache is keyed by
// identifier; if the identifier changes we create a new session and discard
// the old one.

// @ts-expect-error -- @atproto/api ships ESM-only; incompatible with moduleResolution:node
// in this tsconfig. esbuild resolves the exports map correctly at bundle time.
 
import { BskyAgent, RichText } from '@atproto/api'

const BLUESKY_SERVICE = 'https://bsky.social'

interface CachedSession {
  agent: BskyAgent
  identifier: string
}

let _sessionCache: CachedSession | null = null

async function getAgent(identifier: string, appPassword: string): Promise<BskyAgent> {
  // Return cached agent when the identifier matches and the agent has an
  // active session (session property is set by BskyAgent after login).
  if (_sessionCache !== null && _sessionCache.identifier === identifier) {
    const sess = _sessionCache.agent.session
    if (sess !== undefined) {
      return _sessionCache.agent
    }
  }

  const agent = new BskyAgent({ service: BLUESKY_SERVICE })
  await agent.login({ identifier, password: appPassword })

  _sessionCache = { agent, identifier }
  return agent
}

function resolveCredentials(): { identifier: string; appPassword: string } | null {
  // Prefer environment variables (for local dev and CI).
  const envIdentifier = process.env['BLUESKY_IDENTIFIER']
  const envPassword = process.env['BLUESKY_APP_PASSWORD']
  if (envIdentifier && envPassword) {
    return { identifier: envIdentifier, appPassword: envPassword }
  }

  // Fall back to macOS Keychain (production path on Mini).
  // Import lazily so this file can be required in non-macOS test environments
  // without the security CLI crashing.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSecret } = require('../secrets') as { getSecret: (key: string) => string | null }
    const identifier = getSecret('bluesky-identifier')
    const appPassword = getSecret('bluesky-app-password')
    if (identifier && appPassword) {
      return { identifier, appPassword }
    }
  } catch {
    // secrets module unavailable (e.g. non-macOS test runner)
  }

  return null
}

export type BlueskyResult =
  | { ok: true; uri: string; cid: string }
  | { ok: true; uri?: undefined; cid?: undefined }
  | { ok: false; error: string }

/**
 * Create a new top-level Bluesky post.
 * Runs RichText facet detection so mentions, hashtags, and URLs are
 * automatically linked.
 */
export async function blueskyPost(text: string): Promise<BlueskyResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured. Set bluesky-identifier and bluesky-app-password in Keychain (or BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD env vars).' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    const rt = new RichText({ text })
    await rt.detectFacets(agent)
    const res = await agent.post({ text: rt.text, facets: rt.facets })
    return { ok: true, uri: res.uri, cid: res.cid }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Reply to an existing Bluesky post.
 * Requires the parent post's AT URI and CID.
 * The root reference defaults to the parent (i.e. replying to a top-level
 * post). When replying inside a thread, pass root_uri and root_cid explicitly.
 */
export async function blueskyReply(
  text: string,
  parentUri: string,
  parentCid: string,
  rootUri?: string,
  rootCid?: string,
): Promise<BlueskyResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    const rt = new RichText({ text })
    await rt.detectFacets(agent)

    const resolvedRootUri = rootUri ?? parentUri
    const resolvedRootCid = rootCid ?? parentCid

    const res = await agent.post({
      text: rt.text,
      facets: rt.facets,
      reply: {
        root: { uri: resolvedRootUri, cid: resolvedRootCid },
        parent: { uri: parentUri, cid: parentCid },
      },
    })
    return { ok: true, uri: res.uri, cid: res.cid }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Repost an existing Bluesky post.
 */
export async function blueskyRepost(
  subjectUri: string,
  subjectCid: string,
): Promise<BlueskyResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    await agent.repost(subjectUri, subjectCid)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Like an existing Bluesky post.
 */
export async function blueskyLike(
  subjectUri: string,
  subjectCid: string,
): Promise<BlueskyResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    await agent.like(subjectUri, subjectCid)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Mark Bluesky notifications seen up to `seenAt` (default: now), via
 * app.bsky.notification.updateSeen. Without this, blueskyGetNotifications keeps
 * returning the same unread backlog, so CoC re-surfaces a draft reply for the
 * same mention on every comms_pulse (#816). Call after processing notifications.
 */
export async function blueskyMarkNotificationsSeen(seenAt?: string): Promise<BlueskyResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    await agent.updateSeen(seenAt ?? new Date().toISOString())
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// Inbound / read operations (#595)
// Reuse the cached session from getAgent() — reads share the same auth as posts.
// ---------------------------------------------------------------------------

const READ_LIMIT_DEFAULT = 25
const READ_LIMIT_MAX = 100

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return READ_LIMIT_DEFAULT
  return Math.min(Math.max(Math.trunc(limit), 1), READ_LIMIT_MAX)
}

export interface BlueskyPost {
  author: string
  text: string
  uri: string
  cid: string
  indexedAt: string
  likeCount: number
  replyCount: number
  repostCount: number
}

export interface BlueskyNotification {
  author: string
  reason: string
  text: string
  uri: string
  cid: string
  isRead: boolean
  indexedAt: string
}

export type BlueskyPostsResult =
  | { ok: true; posts: BlueskyPost[] }
  | { ok: false; error: string }

export type BlueskyNotificationsResult =
  | { ok: true; notifications: BlueskyNotification[] }
  | { ok: false; error: string }

// Map an app.bsky.feed.defs#postView to our compact shape. The @atproto/api
// import is @ts-expect-error'd above, so view payloads arrive loosely typed;
// read defensively.
function mapPostView(post: {
  author?: { handle?: string }
  record?: { text?: string }
  uri?: string
  cid?: string
  indexedAt?: string
  likeCount?: number
  replyCount?: number
  repostCount?: number
}): BlueskyPost {
  return {
    author: post.author?.handle ?? '',
    text: typeof post.record?.text === 'string' ? post.record.text : '',
    uri: post.uri ?? '',
    cid: post.cid ?? '',
    indexedAt: post.indexedAt ?? '',
    likeCount: post.likeCount ?? 0,
    replyCount: post.replyCount ?? 0,
    repostCount: post.repostCount ?? 0,
  }
}

/**
 * Read recent notifications (mentions, replies, likes, reposts, follows, quotes).
 * Backed by app.bsky.notification.listNotifications.
 */
export async function blueskyGetNotifications(limit = READ_LIMIT_DEFAULT): Promise<BlueskyNotificationsResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    const res = await agent.listNotifications({ limit: clampLimit(limit) })
    const raw = (res.data.notifications ?? []) as Array<{
      author?: { handle?: string }
      reason?: string
      record?: { text?: string }
      uri?: string
      cid?: string
      isRead?: boolean
      indexedAt?: string
    }>
    const notifications: BlueskyNotification[] = raw.map((n) => ({
      author: n.author?.handle ?? '',
      reason: n.reason ?? '',
      text: typeof n.record?.text === 'string' ? n.record.text : '',
      uri: n.uri ?? '',
      cid: n.cid ?? '',
      isRead: n.isRead ?? false,
      indexedAt: n.indexedAt ?? '',
    }))
    return { ok: true, notifications }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Search public posts by keyword or hashtag.
 * Backed by app.bsky.feed.searchPosts.
 */
export async function blueskySearchPosts(query: string, limit = READ_LIMIT_DEFAULT): Promise<BlueskyPostsResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }
  if (!query.trim()) return { ok: false, error: 'search query required' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    const res = await agent.app.bsky.feed.searchPosts({ q: query, limit: clampLimit(limit) })
    const posts = ((res.data.posts ?? []) as Parameters<typeof mapPostView>[0][]).map(mapPostView)
    return { ok: true, posts }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Read the authenticated account's home timeline.
 * Backed by app.bsky.feed.getTimeline.
 */
export async function blueskyGetTimeline(limit = READ_LIMIT_DEFAULT): Promise<BlueskyPostsResult> {
  const creds = resolveCredentials()
  if (!creds) return { ok: false, error: 'Bluesky credentials not configured.' }

  try {
    const agent = await getAgent(creds.identifier, creds.appPassword)
    const res = await agent.getTimeline({ limit: clampLimit(limit) })
    const feed = (res.data.feed ?? []) as Array<{ post?: Parameters<typeof mapPostView>[0] }>
    const posts = feed.map((item) => mapPostView(item.post ?? {}))
    return { ok: true, posts }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// Regex matches:
//   https://bsky.app/profile/<handle>/post/<rkey>
//   <handle>/post/<rkey>
//   <handle>/<rkey>  (shorthand without the word "post")
const BSKY_URL_RE =
  /(?:https?:\/\/bsky\.app\/profile\/)?([^/\s]+)\/(?:post\/)?([a-zA-Z0-9]+)$/

/**
 * Resolve a Bluesky post URL or handle/rkey pair to its AT URI and CID.
 *
 * Accepts:
 *   - Full URL: https://bsky.app/profile/handle.bsky.social/post/3abc123
 *   - Shorthand: handle.bsky.social/post/3abc123
 *   - Bare: handle.bsky.social/3abc123
 *
 * Returns { uri, cid } on success. Throws on invalid input or API errors.
 */
export async function blueskyResolvePost(
  input: string,
): Promise<{ uri: string; cid: string }> {
  const match = BSKY_URL_RE.exec(input.trim())
  if (!match) {
    throw new Error(
      `blueskyResolvePost: cannot parse "${input}". ` +
        'Expected a bsky.app URL or handle/rkey pair.',
    )
  }
  const handle = match[1]
  const rkey = match[2]

  if (!handle || !rkey) {
    throw new Error(
      `blueskyResolvePost: failed to extract handle and rkey from "${input}".`,
    )
  }

  const creds = resolveCredentials()
  if (!creds) {
    throw new Error(
      'blueskyResolvePost: Bluesky credentials not configured. ' +
        'Set bluesky-identifier and bluesky-app-password in Keychain.',
    )
  }

  const agent = await getAgent(creds.identifier, creds.appPassword)

  // Step 1: resolve handle → DID
  const handleRes = await agent.resolveHandle({ handle })
  const did = handleRes.data.did

  // Step 2: build AT URI and fetch the record to get the CID
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`
  const postRes = await agent.getPost({ repo: did, rkey })

  return { uri, cid: postRes.cid }
}

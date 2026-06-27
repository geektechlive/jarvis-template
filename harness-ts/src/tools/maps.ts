// Apple Maps Server API integration for Jarvis.
//
// Canonical Maps implementation. NOT registered as ion tools (ion registerTool
// tools are not callable by the LLM on the CLI backend -- see Issue #576).
// Maps queries route via the admin agent to ~/bin/jarvis-maps (scripts/jarvis-maps.js).
//
// This module is kept for potential use on non-CLI backends and as the
// authoritative Apple Maps Server API client. The canonical LLM-reachable
// implementation is scripts/jarvis-maps.js.
//
// Provides four operations:
//   searchPlaces   -- find places/businesses/POI
//   getDirections  -- turn-by-turn directions between two locations
//   getEta         -- estimated travel time to one or more destinations
//   geocodeAddress -- convert an address to lat/lng
//
// Auth: Apple Maps Server API uses an ES256 JWT exchanged for a short-lived
// access token (valid 30 min). The JWT is signed with a .p8 private key
// from App Store Connect. Credentials come from macOS Keychain:
//   jarvis-maps-key-id      -- Key ID (e.g. 524HZRNGCW)
//   jarvis-maps-id          -- Maps ID (e.g. maps.com.<your-org>.jarvis)
//   jarvis-maps-private-key -- PEM .p8 private key (ES256/P-256)
//
// Access token is cached in module-level variables and refreshed 60s before
// expiry to avoid mid-call expiry.
//
// All HTTP calls use spawnSync('curl') for reliability in the LaunchAgent
// process context where fetch() can fail.

import { createSign } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const TEAM_ID = '<apple-team-id>'
const MAPS_API = 'https://maps-api.apple.com/v1'

// Apple Maps Server API transport type enum.
// Apple accepts: Automobile, Walking, Transit (not "Driving").
export type TransportType = 'Automobile' | 'Walking' | 'Transit'

// ── Credentials ──────────────────────────────────────────────────────────────

interface MapsCredentials {
  keyId: string
  mapsId: string
  privateKey: string
}

function resolveCredentials(): MapsCredentials | null {
  // Env-var path for local dev / CI.
  const envKeyId = process.env['APPLE_MAPS_KEY_ID']
  const envMapsId = process.env['APPLE_MAPS_ID']
  const envPrivateKey = process.env['APPLE_MAPS_PRIVATE_KEY']
  if (envKeyId && envMapsId && envPrivateKey) {
    return { keyId: envKeyId, mapsId: envMapsId, privateKey: envPrivateKey }
  }

  // Keychain path (production on Mini). Lazy require so the module can be
  // imported in non-macOS test environments without the security CLI crashing.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSecret } = require('../secrets') as { getSecret: (key: string) => string | null }
    const keyId = getSecret('jarvis-maps-key-id')
    const mapsId = getSecret('jarvis-maps-id')
    const privateKey = getSecret('jarvis-maps-private-key')
    if (keyId && mapsId && privateKey) {
      return { keyId, mapsId, privateKey }
    }
  } catch {
    // secrets module unavailable
  }

  return null
}

// ── JWT generation ────────────────────────────────────────────────────────────

function makeAuthJwt(keyId: string, mapsId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ iss: TEAM_ID, iat: now, exp: now + 1800, sub: mapsId }),
  ).toString('base64url')
  const signingInput = `${header}.${payload}`
  const sign = createSign('SHA256')
  sign.update(signingInput)
  // Apple requires IEEE P1363 (raw r||s) ECDSA encoding, not DER.
  const sig = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${signingInput}.${sig}`
}

// ── Token cache + exchange ────────────────────────────────────────────────────

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getMapsToken(): Promise<string> {
  // Return cached token if still valid with 60s skew.
  if (cachedToken !== null && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken
  }

  const creds = resolveCredentials()
  if (!creds) {
    throw new Error('Apple Maps credentials not configured. Set jarvis-maps-key-id, jarvis-maps-id, and jarvis-maps-private-key in Keychain.')
  }

  const jwt = makeAuthJwt(creds.keyId, creds.mapsId, creds.privateKey)

  const result = spawnSync('curl', [
    '-sf',
    '--max-time', '15',
    '-X', 'POST',
    `${MAPS_API}/token`,
    '-H', `Authorization: Bearer ${jwt}`,
  ])

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? ''
    throw new Error(`Maps token exchange failed (curl exit ${result.status ?? 'null'}): ${stderr}`)
  }

  const body = result.stdout.toString().trim()
  if (!body) {
    throw new Error('Maps token exchange returned empty response (HTTP error or network failure)')
  }

  let data: unknown
  try {
    data = JSON.parse(body) as unknown
  } catch {
    throw new Error(`Maps token exchange returned invalid JSON: ${body.slice(0, 200)}`)
  }

  const rec = data as Record<string, unknown>
  if (typeof rec['accessToken'] !== 'string') {
    throw new Error(`Maps token exchange response missing accessToken: ${body.slice(0, 200)}`)
  }

  const expiresIn = typeof rec['expiresInSeconds'] === 'number' ? rec['expiresInSeconds'] : 1800
  cachedToken = rec['accessToken']
  tokenExpiresAt = Date.now() + expiresIn * 1000

  return cachedToken
}

// ── curl helper ───────────────────────────────────────────────────────────────

function mapsGet(endpoint: string, token: string): unknown {
  const result = spawnSync('curl', [
    '-sf',
    '--max-time', '10',
    `${MAPS_API}/${endpoint}`,
    '-H', `Authorization: Bearer ${token}`,
  ])

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? ''
    throw new Error(`Maps API request failed (curl exit ${result.status ?? 'null'}): ${stderr}`)
  }

  const body = result.stdout.toString().trim()
  if (!body) {
    throw new Error(`Maps API returned empty response for /${endpoint} (likely HTTP error)`)
  }

  return JSON.parse(body) as unknown
}

// ── Public tool functions ─────────────────────────────────────────────────────

export interface PlaceResult {
  name: string
  address: string
  lat: number
  lng: number
}

/**
 * Search for places, businesses, or points of interest.
 * Returns up to 5 results with name, address, and coordinates.
 */
export async function searchPlaces(
  query: string,
  region?: string,
  lang = 'en-US',
): Promise<PlaceResult[] | string> {
  try {
    const token = await getMapsToken()
    const params = new URLSearchParams({ q: query, limitToCountries: 'US', lang })
    if (region) params.set('region', region)
    const data = mapsGet(`search?${params.toString()}`, token)

    const rec = data as Record<string, unknown>
    if (!Array.isArray(rec['results'])) return []

    const results = rec['results'] as Array<Record<string, unknown>>
    return results.slice(0, 5).map((r): PlaceResult => {
      const coord = (r['coordinate'] ?? {}) as Record<string, unknown>
      const addressLines = Array.isArray(r['formattedAddressLines'])
        ? (r['formattedAddressLines'] as string[]).join(', ')
        : String(r['formattedAddressLines'] ?? '')
      return {
        name: String(r['name'] ?? ''),
        address: addressLines,
        lat: typeof coord['lat'] === 'number' ? coord['lat'] : 0,
        lng: typeof coord['lng'] === 'number' ? coord['lng'] : 0,
      }
    })
  } catch (err) {
    return `search_places error: ${String(err)}`
  }
}

export interface DirectionsResult {
  distance: string
  duration: string
  steps: string[]
}

/**
 * Get turn-by-turn directions between two locations.
 */
export async function getDirections(
  origin: string,
  destination: string,
  transportType: TransportType = 'Automobile',
): Promise<DirectionsResult | string> {
  try {
    const token = await getMapsToken()
    const params = new URLSearchParams({
      origin,
      destination,
      transportType,
    })
    const data = mapsGet(`directions?${params.toString()}`, token)

    const rec = data as Record<string, unknown>
    const routes = Array.isArray(rec['routes']) ? (rec['routes'] as Array<Record<string, unknown>>) : []
    const route = routes[0]
    if (!route) return 'No route found.'

    const distanceMeters = typeof route['distanceMeters'] === 'number' ? route['distanceMeters'] : 0
    const travelSeconds = typeof route['expectedTravelTimeSeconds'] === 'number' ? route['expectedTravelTimeSeconds'] : 0

    const distanceMiles = (distanceMeters / 1609.344).toFixed(1)
    const durationMin = Math.round(travelSeconds / 60)
    const durationStr = durationMin >= 60
      ? `${Math.floor(durationMin / 60)} hr ${durationMin % 60} min`
      : `${durationMin} min`

    const stepsRaw = Array.isArray(route['steps']) ? (route['steps'] as Array<Record<string, unknown>>) : []
    const steps = stepsRaw.map((s) => String(s['instructions'] ?? s['description'] ?? '')).filter(Boolean)

    return {
      distance: `${distanceMiles} miles`,
      duration: durationStr,
      steps,
    }
  } catch (err) {
    return `get_directions error: ${String(err)}`
  }
}

export interface EtaResult {
  destination: string
  etaSeconds: number
  etaReadable: string
}

/**
 * Get estimated travel time from an origin to one or more destinations.
 */
export async function getEta(
  origin: string,
  destinations: string[],
  transportType: TransportType = 'Automobile',
): Promise<EtaResult[] | string> {
  try {
    const token = await getMapsToken()
    // URLSearchParams encodes origin and transportType automatically.
    // Destinations are joined with | (literal separator) and appended manually
    // since URLSearchParams would encode the | character. Each destination is
    // individually encoded before joining.
    const destParam = destinations.map((d) => encodeURIComponent(d)).join('|')
    const params = new URLSearchParams({ origin, transportType })
    const data = mapsGet(`eta?${params.toString()}&destinations=${destParam}`, token)

    const rec = data as Record<string, unknown>
    const etas = Array.isArray(rec['etas']) ? (rec['etas'] as Array<Record<string, unknown>>) : []

    return etas.map((e, i): EtaResult => {
      const seconds = typeof e['expectedTravelTimeSeconds'] === 'number' ? e['expectedTravelTimeSeconds'] : 0
      const minutes = Math.round(seconds / 60)
      const readable = minutes >= 60
        ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
        : `${minutes} min`
      return {
        destination: destinations[i] ?? String(e['destination'] ?? ''),
        etaSeconds: seconds,
        etaReadable: readable,
      }
    })
  } catch (err) {
    return `get_eta error: ${String(err)}`
  }
}

export interface GeocodeResult {
  lat: number
  lng: number
  formattedAddress: string
}

/**
 * Convert a street address to latitude/longitude coordinates.
 * Returns null if the address cannot be geocoded.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null | string> {
  try {
    const token = await getMapsToken()
    const params = new URLSearchParams({ q: address })
    const data = mapsGet(`geocode?${params.toString()}`, token)

    const rec = data as Record<string, unknown>
    const results = Array.isArray(rec['results']) ? (rec['results'] as Array<Record<string, unknown>>) : []
    const first = results[0]
    if (!first) return null

    const coord = (first['coordinate'] ?? {}) as Record<string, unknown>
    const addressLines = Array.isArray(first['formattedAddressLines'])
      ? (first['formattedAddressLines'] as string[]).join(', ')
      : String(first['formattedAddressLines'] ?? address)

    return {
      lat: typeof coord['lat'] === 'number' ? coord['lat'] : 0,
      lng: typeof coord['lng'] === 'number' ? coord['lng'] : 0,
      formattedAddress: addressLines,
    }
  } catch (err) {
    return `geocode_address error: ${String(err)}`
  }
}

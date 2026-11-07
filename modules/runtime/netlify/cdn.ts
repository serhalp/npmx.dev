/**
 * Maps Nitro `isr` route rules onto Netlify's CDN primitives.
 *
 * Netlify has no ISR primitive, but its durable cache with `stale-while-revalidate` and
 * `Netlify-Vary` gives the same behaviour: one shared entry per deploy, served stale while
 * the function revalidates in the background. Unlike Vercel's per-deployment ISR cache, entries
 * can also opt out of deploy invalidation, which immutable version-keyed responses use.
 *
 * Kept free of Nitro imports so it can be unit tested.
 *
 * @see https://docs.netlify.com/build/caching/caching-overview/
 */

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365
// A 404 may become a 200 once the package or version is published.
const NOT_FOUND_MAX_AGE = 60 * 5

/**
 * Function responses vary on every query param by default, and there's no documented way to
 * vary on none. Varying on a param nothing sends has that effect (verified on Netlify).
 */
export const IGNORE_QUERY_VARY_PARAM = '__netlify_vary_none'

/**
 * Bump to purge everything cached under {@link getPersistentCacheId}, e.g. after changing how
 * one of those routes renders its output.
 */
export const PERSISTENT_CACHE_ID = 'npmx-immutable-v1'

/** Routes whose response for an exact `name/v/<semver>` never changes. JSON only: never HTML. */
const IMMUTABLE_ROUTE_PREFIXES = [
  '/api/registry/file/',
  '/api/registry/files/',
  '/api/registry/provenance/',
  '/api/registry/docs/',
]
const EXACT_VERSION_SEGMENT_RE = /\/v\/\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?(?:\/|$)/

/** Heuristically cacheable statuses (RFC 9110 §15.1), minus 206 and 501. */
const CACHEABLE_STATUSES = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414])

export interface NormalizedISR {
  /** Seconds until stale, or `false` to cache until the next deploy. */
  expiration: number | false
  passQuery: boolean
  allowQuery?: string[]
}

type ISRRule =
  | boolean
  | number
  | { expiration?: number | false; passQuery?: boolean; allowQuery?: string[] }
  | undefined

export function normalizeISR(isr: ISRRule): NormalizedISR | null {
  if (isr === undefined || isr === false) return null
  if (isr === true) return { expiration: false, passQuery: false }
  if (typeof isr === 'number') return { expiration: isr, passQuery: false }
  return {
    expiration: isr.expiration ?? false,
    passQuery: !!isr.passQuery,
    allowQuery: isr.allowQuery,
  }
}

/**
 * The URL handed to Nitro. Matches Vercel: without `passQuery` the function sees no query, and
 * with `allowQuery` only allowed params, keeping output consistent with {@link getNetlifyVary}.
 */
export function getISRRequestPath(url: URL, isr: NormalizedISR | null): string {
  if (!isr) return url.pathname + url.search
  if (!isr.passQuery) return url.pathname
  if (!isr.allowQuery) return url.pathname + url.search

  const allowed = new Set(isr.allowQuery)
  const params = new URLSearchParams()
  for (const [key, value] of url.searchParams) {
    if (allowed.has(key)) params.append(key, value)
  }
  const search = params.toString()
  return search ? `${url.pathname}?${search}` : url.pathname
}

/** Mirrors vercel.json's `trailingSlash: false`, which Netlify `_redirects` can't express. */
export function getTrailingSlashRedirect(url: URL): Response | null {
  if (url.pathname === '/' || !url.pathname.endsWith('/')) return null
  return new Response(null, {
    status: 308,
    headers: {
      'location': url.pathname.replace(/\/+$/, '') + url.search,
      'cache-control': 'public, s-maxage=86400',
      'netlify-cdn-cache-control': 'public, durable, s-maxage=86400',
    },
  })
}

export function getNetlifyVary(isr: NormalizedISR): string | undefined {
  if (isr.passQuery && !isr.allowQuery) return undefined
  const params =
    isr.passQuery && isr.allowQuery?.length ? isr.allowQuery : [IGNORE_QUERY_VARY_PARAM]
  return `query=${params.join('|')}`
}

export function getISRCdnCacheControl(isr: NormalizedISR, status: number): string {
  if (status === 404) {
    const maxAge = isr.expiration === false ? NOT_FOUND_MAX_AGE : isr.expiration
    return `public, durable, s-maxage=${Math.min(maxAge, NOT_FOUND_MAX_AGE)}`
  }
  if (isr.expiration === false) {
    return `public, durable, s-maxage=${ONE_YEAR_IN_SECONDS}`
  }
  return `public, durable, s-maxage=${isr.expiration}, stale-while-revalidate=${ONE_YEAR_IN_SECONDS}`
}

/** Cache ID that keeps an immutable response cached across deploys, if `pathname` has one. */
export function getPersistentCacheId(pathname: string): string | undefined {
  const immutable =
    IMMUTABLE_ROUTE_PREFIXES.some(prefix => pathname.startsWith(prefix)) &&
    EXACT_VERSION_SEGMENT_RE.test(pathname)
  return immutable ? PERSISTENT_CACHE_ID : undefined
}

function parseCacheControl(value: string | null): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(directive => directive.trim().split('=')[0]!.toLowerCase())
      .filter(Boolean),
  )
}

/**
 * Adds Netlify CDN cache headers to a function response, in place.
 *
 * - `isr` routes get a durable SWR entry and a `Netlify-Vary` matching `allowQuery`.
 * - Other responses already opting into shared caching via `Cache-Control: s-maxage` (cached
 *   event handlers, redirects) are promoted to the durable cache, shared across edge nodes.
 */
export function applyNetlifyCacheHeaders(
  headers: Headers,
  status: number,
  isr: NormalizedISR | null,
  pathname: string,
): void {
  if (headers.has('netlify-cdn-cache-control')) return

  const directives = parseCacheControl(headers.get('cache-control'))
  // `no-cache` included: Nuxt sends it on error pages.
  const optedOut =
    directives.has('private') ||
    directives.has('no-store') ||
    directives.has('no-cache') ||
    headers.has('set-cookie')

  if (!CACHEABLE_STATUSES.has(status) || optedOut) {
    // Stops the CDN honouring a handler's `s-maxage` on an error or personalised response.
    if (isr || directives.has('s-maxage')) {
      headers.set('netlify-cdn-cache-control', 'no-store')
    }
    return
  }

  if (isr) {
    headers.set('netlify-cdn-cache-control', getISRCdnCacheControl(isr, status))
    const vary = getNetlifyVary(isr)
    if (vary && !headers.has('netlify-vary')) headers.set('netlify-vary', vary)
    if (!headers.has('cache-control')) {
      headers.set('cache-control', 'public, max-age=0, must-revalidate')
    }
    const cacheId = status === 200 ? getPersistentCacheId(pathname) : undefined
    if (cacheId && !headers.has('netlify-cache-id')) headers.set('netlify-cache-id', cacheId)
    return
  }

  if (directives.has('s-maxage')) {
    headers.set('netlify-cdn-cache-control', `${headers.get('cache-control')}, durable`)
  }
}

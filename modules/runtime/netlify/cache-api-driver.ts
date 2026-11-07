/**
 * Unstorage driver backed by the Cache API Netlify exposes to functions: a regional cache shared
 * by every function instance and reset on each deploy, the closest analog of Vercel's runtime
 * cache.
 *
 * Each operation is a network round trip (~50-250ms measured) and Netlify caps operations per
 * invocation, silently dropping the excess. Operations past the budget or slower than the
 * timeout count as misses, so they can never hold up a response. Falls back to an in-memory map
 * where `caches` doesn't exist (build-time prerendering, `nuxt preview`).
 *
 * @see https://docs.netlify.com/build/caching/cache-api/
 */

export interface CacheApiDriverOptions {
  /** Namespace for keys, so separate mounts can't collide. */
  base?: string
  /** Seconds an entry is retained; callers track their own freshness. */
  ttl?: number
}

const DEFAULT_TTL = 60 * 60 * 24 * 7
const OPERATION_TIMEOUT_MS = 1000
// Netlify's documented per-invocation limits.
const MAX_LOOKUPS = 100
const MAX_WRITES = 20
// Never fetched: Cache API keys must be URLs, and a fake origin can't clash with real fetches.
const KEY_ORIGIN = 'https://nitro-storage.npmx.internal'
const CACHE_NAME = 'nitro-storage'

// Module-scoped: an instance serves one invocation at a time, and entry.ts resets it.
const budget = { lookups: 0, writes: 0 }

export function resetCacheApiBudget() {
  budget.lookups = 0
  budget.writes = 0
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(resolve, OPERATION_TIMEOUT_MS, fallback)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function openCache() {
  return typeof globalThis.caches === 'undefined' ? null : globalThis.caches.open(CACHE_NAME)
}

// Plain factory rather than unstorage's `defineDriver` (an identity helper): Nitro loads drivers
// in Node at build time, where `unstorage` isn't resolvable from the project root.
export default function cacheApiDriver(opts: CacheApiDriverOptions = {}) {
  const base = opts.base ?? ''
  const memory = new Map<string, string>()
  const toUrl = (key: string) =>
    `${KEY_ORIGIN}/${encodeURIComponent(base)}/${encodeURIComponent(key)}`

  async function getItem(key: string): Promise<string | null> {
    const cache = await openCache()
    if (!cache) return memory.get(key) ?? null
    if (++budget.lookups > MAX_LOOKUPS) return null
    const response = await withTimeout(cache.match(toUrl(key)), undefined)
    return response ? withTimeout(response.text(), null) : null
  }

  return {
    name: 'netlify-cache-api',
    options: opts,
    getItem,
    async hasItem(key: string) {
      return (await getItem(key)) !== null
    },
    async setItem(key: string, value: string, tOptions?: { ttl?: number }) {
      const cache = await openCache()
      if (!cache) {
        memory.set(key, value)
        return
      }
      if (++budget.writes > MAX_WRITES) return
      // The Cache API rejects entries without a positive max-age.
      const ttl = Math.max(1, Math.floor(tOptions?.ttl ?? opts.ttl ?? DEFAULT_TTL))
      const response = new Response(value, {
        headers: {
          'content-type': 'text/plain;charset=utf-8',
          'cache-control': `public, max-age=${ttl}`,
        },
      })
      await withTimeout(cache.put(toUrl(key), response), undefined)
    },
    async removeItem(key: string) {
      const cache = await openCache()
      if (!cache) {
        memory.delete(key)
        return
      }
      if (++budget.writes > MAX_WRITES) return
      await withTimeout(cache.delete(toUrl(key)), false)
    },
    // The Cache API can't enumerate entries.
    getKeys: () => [],
    clear() {
      memory.clear()
    },
  }
}

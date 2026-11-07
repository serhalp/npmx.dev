import { describe, expect, it } from 'vite-plus/test'
import {
  applyNetlifyCacheHeaders,
  getISRRequestPath,
  getPersistentCacheId,
  getTrailingSlashRedirect,
  IGNORE_QUERY_VARY_PARAM,
  normalizeISR,
  PERSISTENT_CACHE_ID,
} from '../../../modules/runtime/netlify/cdn'

describe('normalizeISR', () => {
  it.each([
    [undefined, null],
    [false, null],
    [true, { expiration: false, passQuery: false }],
    [300, { expiration: 300, passQuery: false }],
    [
      { expiration: 60, passQuery: true, allowQuery: ['q'] },
      { expiration: 60, passQuery: true, allowQuery: ['q'] },
    ],
    [{ passQuery: true }, { expiration: false, passQuery: true, allowQuery: undefined }],
  ])('%j → %j', (input, expected) => {
    expect(normalizeISR(input)).toEqual(expected)
  })
})

describe('getISRRequestPath', () => {
  const url = new URL('https://npmx.dev/api/x?q=vue&utm_source=bsky&q=nuxt')

  it('forwards the full URL for non-ISR routes', () => {
    expect(getISRRequestPath(url, null)).toBe('/api/x?q=vue&utm_source=bsky&q=nuxt')
  })

  it('drops the query without passQuery, like Vercel', () => {
    expect(getISRRequestPath(url, normalizeISR(300))).toBe('/api/x')
  })

  it('keeps the whole query with passQuery and no allowQuery', () => {
    expect(getISRRequestPath(url, normalizeISR({ passQuery: true }))).toBe(
      '/api/x?q=vue&utm_source=bsky&q=nuxt',
    )
  })

  it('keeps only allowed params, including repeats', () => {
    const isr = normalizeISR({ expiration: 60, passQuery: true, allowQuery: ['q'] })
    expect(getISRRequestPath(url, isr)).toBe('/api/x?q=vue&q=nuxt')
  })

  it('drops the `?` when no allowed params remain', () => {
    const isr = normalizeISR({ expiration: 60, passQuery: true, allowQuery: ['other'] })
    expect(getISRRequestPath(url, isr)).toBe('/api/x')
  })
})

function apply(
  init: HeadersInit,
  status: number,
  isr: Parameters<typeof normalizeISR>[0],
  pathname = '/api/x',
) {
  const headers = new Headers(init)
  applyNetlifyCacheHeaders(headers, status, normalizeISR(isr), pathname)
  return Object.fromEntries(headers)
}

describe('applyNetlifyCacheHeaders', () => {
  it('maps an expiring ISR rule to a durable SWR entry that ignores the query', () => {
    expect(apply({}, 200, 300)).toEqual({
      'cache-control': 'public, max-age=0, must-revalidate',
      'netlify-cdn-cache-control': 'public, durable, s-maxage=300, stale-while-revalidate=31536000',
      'netlify-vary': `query=${IGNORE_QUERY_VARY_PARAM}`,
    })
  })

  it('caches non-expiring ISR rules until the next deploy', () => {
    expect(apply({}, 200, true)['netlify-cdn-cache-control']).toBe(
      'public, durable, s-maxage=31536000',
    )
  })

  it('caps 404s, which may become 200s once something is published', () => {
    expect(apply({}, 404, true)['netlify-cdn-cache-control']).toBe('public, durable, s-maxage=300')
    expect(apply({}, 404, 60)['netlify-cdn-cache-control']).toBe('public, durable, s-maxage=60')
  })

  it('varies the cache key on allowQuery only', () => {
    const headers = apply({}, 200, { expiration: 60, passQuery: true, allowQuery: ['a', 'b'] })
    expect(headers['netlify-vary']).toBe('query=a|b')
  })

  it('keeps the default full-query cache key for passQuery without allowQuery', () => {
    expect(apply({}, 200, { expiration: 60, passQuery: true })['netlify-vary']).toBeUndefined()
  })

  it("keeps a handler's own browser Cache-Control", () => {
    const headers = apply({ 'cache-control': 's-maxage=60' }, 200, 300)
    expect(headers['cache-control']).toBe('s-maxage=60')
    expect(headers['netlify-cdn-cache-control']).toContain('s-maxage=300')
  })

  it.each([301, 308])('caches ISR %i responses', status => {
    expect(apply({}, status, 300)['netlify-cdn-cache-control']).toContain('durable')
  })

  it.each([500, 502, 429, 401])('never caches ISR %i responses', status => {
    expect(apply({ 'cache-control': 's-maxage=60' }, status, 300)).toMatchObject({
      'netlify-cdn-cache-control': 'no-store',
    })
  })

  it.each([
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store' },
    { 'cache-control': 'no-cache' },
    { 'set-cookie': 'session=1' },
  ])('respects a handler opting out of shared caching: %j', init => {
    expect(apply(init, 200, 300)['netlify-cdn-cache-control']).toBe('no-store')
  })

  it("never overrides a handler's own Netlify-CDN-Cache-Control", () => {
    expect(apply({ 'netlify-cdn-cache-control': 'no-cache' }, 200, 300)).toEqual({
      'netlify-cdn-cache-control': 'no-cache',
    })
  })

  it('promotes s-maxage responses on non-ISR routes to the durable cache', () => {
    expect(apply({ 'cache-control': 'public, s-maxage=3600' }, 301, undefined)).toEqual({
      'cache-control': 'public, s-maxage=3600',
      'netlify-cdn-cache-control': 'public, s-maxage=3600, durable',
    })
  })

  it('leaves uncached non-ISR responses alone', () => {
    expect(apply({ 'cache-control': 'max-age=60' }, 200, undefined)).toEqual({
      'cache-control': 'max-age=60',
    })
    expect(apply({}, 500, undefined)).toEqual({})
  })

  it('keeps immutable versioned responses across deploys, but only on 200', () => {
    const path = '/api/registry/files/vue/v/3.5.0'
    expect(apply({}, 200, true, path)['netlify-cache-id']).toBe(PERSISTENT_CACHE_ID)
    expect(apply({}, 404, true, path)['netlify-cache-id']).toBeUndefined()
  })
})

describe('getPersistentCacheId', () => {
  it.each([
    '/api/registry/file/vue/v/3.5.0/dist/vue.js',
    '/api/registry/files/@vue/runtime-core/v/3.5.0',
    '/api/registry/provenance/vue/v/3.5.0-beta.1',
    '/api/registry/docs/zod/v/4.0.0+build.5',
  ])('pins exact versions: %s', path => {
    expect(getPersistentCacheId(path)).toBe(PERSISTENT_CACHE_ID)
  })

  it.each([
    '/api/registry/files/vue/v/latest',
    '/api/registry/files/vue/v/next',
    '/api/registry/files/vue',
    '/api/registry/readme/vue/v/3.5.0',
    '/package/vue/v/3.5.0',
  ])('never pins tags, unversioned or other routes: %s', path => {
    expect(getPersistentCacheId(path)).toBeUndefined()
  })
})

describe('getTrailingSlashRedirect', () => {
  it.each(['https://npmx.dev/', 'https://npmx.dev/package/vue', 'https://npmx.dev/?q=a'])(
    'leaves %s alone',
    url => {
      expect(getTrailingSlashRedirect(new URL(url))).toBeNull()
    },
  )

  it('strips trailing slashes and keeps the whole query', () => {
    const response = getTrailingSlashRedirect(
      new URL('https://npmx.dev/package/vue//?activeTab=readme&utm_source=x'),
    )
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('/package/vue?activeTab=readme&utm_source=x')
    expect(response?.headers.get('netlify-cdn-cache-control')).toContain('durable')
  })
})

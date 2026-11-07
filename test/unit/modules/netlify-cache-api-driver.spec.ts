import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import cacheApiDriver, {
  resetCacheApiBudget,
} from '../../../modules/runtime/netlify/cache-api-driver'

function stubCaches(cache: Partial<Cache>) {
  vi.stubGlobal('caches', { open: async () => cache })
}

describe('Cache API driver', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetCacheApiBudget()
  })

  it('falls back to memory without a Cache API', async () => {
    const driver = cacheApiDriver({ base: 'x' })
    await driver.setItem('k', 'v')

    expect(await driver.getItem('k')).toBe('v')
  })

  it('round-trips through the Cache API with a max-age', async () => {
    const store = new Map<string, Response>()
    stubCaches({
      match: async (url: RequestInfo | URL) => store.get(String(url))?.clone(),
      put: async (url: RequestInfo | URL, response: Response) => {
        store.set(String(url), response)
      },
    })
    const driver = cacheApiDriver({ base: 'cache' })
    await driver.setItem('nitro:functions:npm:vue.json', '{"a":1}', { ttl: 60 })

    expect(await driver.getItem('nitro:functions:npm:vue.json')).toBe('{"a":1}')
    expect([...store.values()][0]!.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('treats hung operations as misses', async () => {
    vi.useFakeTimers()
    stubCaches({ match: () => new Promise<undefined>(() => {}) })
    const result = cacheApiDriver().getItem('k')
    await vi.advanceTimersByTimeAsync(1000)

    expect(await result).toBeNull()
  })

  it('stops calling the Cache API once the per-invocation budget is spent', async () => {
    const match = vi.fn(async () => undefined)
    stubCaches({ match })
    const driver = cacheApiDriver()
    for (let i = 0; i < 150; i++) await driver.getItem(`k${i}`)
    expect(match).toHaveBeenCalledTimes(100)

    resetCacheApiBudget()
    await driver.getItem('k')
    expect(match).toHaveBeenCalledTimes(101)
  })
})

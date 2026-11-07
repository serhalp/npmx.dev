import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import vercelConfig from '../../vercel.json'

describe('netlify.toml', () => {
  it('mirrors the host redirects in vercel.json', () => {
    const toml = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf-8')
    const netlifyRedirects = Array.from(
      toml.matchAll(/from = "https:\/\/([^/]+)\/\*"\s+to = "([^"]+)"/g),
      ([, host, destination]) => ({ host, destination }),
    )

    const vercelRedirects = vercelConfig.redirects.map(redirect => ({
      host: redirect.has.find(condition => condition.type === 'host')!.value,
      destination: redirect.destination,
    }))

    expect(netlifyRedirects).toEqual(vercelRedirects)
  })
})

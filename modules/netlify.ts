import process from 'node:process'
import { createResolver, defineNuxtModule, useNuxt, useRuntimeConfig } from 'nuxt/kit'
import { provider } from 'std-env'
import { isProduction } from '../config/env'

// Must match the storage key in shared/utils/fetch-cache-config.ts
const RUNTIME_CACHE_STORAGES = ['cache', 'fetch-cache'] as const

/**
 * Netlify deployment support. The Vercel counterparts live in `cache.ts` and `isr-fallback.ts`.
 *
 * - `isr` route rules become durable CDN cache entries with SWR and `Netlify-Vary`, and
 *   immutable version-keyed API responses survive deploys (see runtime/netlify/cdn.ts), via a
 *   custom function entry that also forwards Netlify's `waitUntil`.
 * - Runtime caches are backed by Netlify's Cache API: shared per region, reset per deploy.
 * - OAuth state goes to Upstash in production when configured, else Netlify Blobs.
 * - Vercel analytics are dropped: their proxies point at npmx.dev's Vercel project.
 *
 * The ISR SPA fallback has no equivalent: on Netlify a cold cache miss waits for the render.
 */
export default defineNuxtModule({
  meta: {
    name: 'netlify',
  },
  setup() {
    const nuxt = useNuxt()
    const isNetlify = provider === 'netlify' || process.env.NITRO_PRESET?.startsWith('netlify')
    // oxlint-disable-next-line eslint/no-underscore-dangle
    if (!isNetlify || nuxt.options.dev || nuxt.options.test || nuxt.options._prepare) return

    const resolver = createResolver(import.meta.url)
    const config = useRuntimeConfig()

    nuxt.hook('app:resolve', app => {
      app.plugins = app.plugins.filter(
        plugin => !/vercel-(?:analytics|speed-insights)/.test(plugin.src),
      )
    })
    for (const path of Object.keys(nuxt.options.routeRules ?? {})) {
      if (path.startsWith('/_v/')) delete nuxt.options.routeRules![path]
    }

    // Set on the resolved instance: via `nitro:config` it'd leak into the prerender build.
    nuxt.hook('nitro:init', nitro => {
      if (nitro.options.preset === 'netlify') {
        nitro.options.entry = resolver.resolve('./runtime/netlify/entry.ts')
      }
    })

    nuxt.hook('nitro:config', nitroConfig => {
      // Netlify's Node runtime rejects `require()` of ES modules, which this CJS package does for
      // `htmlparser2`. Bundling it lets Rollup rewrite those requires.
      nitroConfig.externals ??= {}
      nitroConfig.externals.inline = [...(nitroConfig.externals.inline ?? []), 'sanitize-html']

      // Emit `about.html` rather than `about/index.html`: Netlify serves directories with a
      // trailing slash, which would fight the app's no-trailing-slash URLs.
      nitroConfig.prerender ??= {}
      nitroConfig.prerender.autoSubfolderIndex = false

      nitroConfig.storage ??= {}
      for (const base of RUNTIME_CACHE_STORAGES) {
        nitroConfig.storage[base] = {
          // Nitro imports drivers in plain Node at build time, so the extension is required.
          driver: resolver.resolve('./runtime/netlify/cache-api-driver.ts'),
          base,
        }
      }

      const { redisRestUrl: url, redisRestToken: token } = config.upstash
      nitroConfig.storage.atproto =
        isProduction && url && token
          ? { driver: 'upstash', url, token }
          : isProduction
            ? { driver: 'netlify-blobs', name: 'atproto' }
            : // Keeps preview sessions out of the production store.
              { driver: 'netlify-blobs', deployScoped: true }
    })
  },
})

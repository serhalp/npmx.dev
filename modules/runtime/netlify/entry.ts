import '#nitro-internal-pollyfills'
import { useNitroApp } from 'nitropack/runtime'
import {
  getRouteRulesForPath,
  joinHeaders,
  normalizeCookieHeader,
} from 'nitropack/runtime/internal/index'
import { resetCacheApiBudget } from './cache-api-driver'
import {
  applyNetlifyCacheHeaders,
  getISRRequestPath,
  getTrailingSlashRedirect,
  normalizeISR,
} from './cdn'

/** Subset of the Netlify Functions `Context` we rely on. */
interface NetlifyContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * Replaces Nitro's stock Netlify entry, which drops the function context (so `event.waitUntil`
 * work can be frozen once the response is sent) and caches every object-form `isr` rule for a
 * year regardless of `expiration`.
 */
const nitroApp = useNitroApp()

export default async function handler(request: Request, context?: NetlifyContext) {
  resetCacheApiBudget()
  const url = new URL(request.url)
  const redirect = getTrailingSlashRedirect(url)
  if (redirect) return redirect

  const isr = normalizeISR(getRouteRulesForPath(url.pathname).isr)

  const response = await nitroApp.localCall({
    url: getISRRequestPath(url, isr),
    headers: request.headers,
    method: request.method,
    body: request.body,
    // Read by Nitro's `onRequest` to wire up `event.waitUntil` and `event.context.netlify`.
    context: {
      waitUntil: context?.waitUntil?.bind(context),
      _platform: { netlify: { request, context } },
    },
  })

  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    if (name === 'set-cookie') {
      for (const cookie of normalizeCookieHeader(value)) headers.append(name, cookie)
    } else {
      headers.set(name, joinHeaders(value))
    }
  }
  applyNetlifyCacheHeaders(headers, response.status, isr, url.pathname)

  return new Response(response.body as BodyInit | null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

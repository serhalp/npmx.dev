// Nitro internals used by entry.ts, the same ones its stock Netlify entry imports. Nuxt's
// tsconfig only maps `nitropack/runtime`, so these would otherwise be untyped.
declare module '#nitro-internal-pollyfills' {}

declare module 'nitropack/runtime/internal/index' {
  import type { NitroRouteRules } from 'nitropack/types'

  export function getRouteRulesForPath(path: string): NitroRouteRules
  export function joinHeaders(value: number | string | string[]): string
  export function normalizeCookieHeader(header?: number | string | string[]): string[]
}

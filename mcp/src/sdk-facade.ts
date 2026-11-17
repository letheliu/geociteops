/**
 * Typecheck stand-in for `@geociteops/sdk`.
 *
 * The real SDK infers its client from the server router, so a direct import
 * pulls the whole API into this program. esbuild aliases `@geociteops/sdk` to
 * `sdk/src/index.ts` when it builds `dist/cli.js`. Do not call this function.
 */
import type { GeoApi } from './api-types.js'

export interface CreateGeoClientOptions {
  serviceUrl: string
  apiKey: string
  workspaceId?: string
  webhookUrl?: string
}

export function createGeoClient(_options: CreateGeoClientOptions): GeoApi {
  throw new Error('createGeoClient is replaced at build time by @geociteops/sdk')
}

import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { GeoAppRouter } from './types.js'

export interface CreateGeoClientOptions {
  serviceUrl: string
  apiKey: string
  /**
   * Sent as `x-workspace-id`.
   * A workspace API key is already bound to one workspace; the API ignores this
   * header on the API-key channel and uses the key's workspace. The header
   * matters for session-cookie calls.
   */
  workspaceId?: string
  webhookUrl?: string
}

export function geoClientHeaders(options: CreateGeoClientOptions): Record<string, string> {
  const headers: Record<string, string> = { 'x-api-key': options.apiKey }
  if (options.workspaceId) headers['x-workspace-id'] = options.workspaceId
  return headers
}

export function createGeoClient(options: CreateGeoClientOptions) {
  return createTRPCProxyClient<GeoAppRouter>({
    links: [
      httpBatchLink({
        url: `${options.serviceUrl}/trpc`,
        headers: () => geoClientHeaders(options),
      }),
    ],
  })
}

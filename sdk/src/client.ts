import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { GeoAppRouter } from './types.js'

export interface CreateGeoClientOptions {
  serviceUrl: string
  apiKey: string
  webhookUrl?: string
}

export function createGeoClient(options: CreateGeoClientOptions) {
  return createTRPCProxyClient<GeoAppRouter>({
    links: [
      httpBatchLink({
        url: `${options.serviceUrl}/trpc`,
        headers: () => ({
          'x-api-key': options.apiKey,
        }),
      }),
    ],
  })
}

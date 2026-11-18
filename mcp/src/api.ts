import { createGeoClient, type CreateGeoClientOptions } from '@geociteops/sdk'
import type { GeoApi } from './api-types.js'

export function createGeoApi(options: CreateGeoClientOptions): GeoApi {
  return createGeoClient(options) as unknown as GeoApi
}

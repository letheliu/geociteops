import type { HealthLanguage } from './types.js'

/** Inputs captured when the check is queued. Pillars read this, not the live form. */
export interface GeoHealthRunInput {
  workspaceId: string
  brandName: string
  siteUrl: string
  industry: string | null
  competitors: string[]
  userQueries: string[]
  language: HealthLanguage
}

/**
 * The slice of the GeoCiteOps tRPC client this server calls.
 * The running client is `createGeoClient` from `@geociteops/sdk`.
 */

export interface Query<I, O> {
  query(input: I): Promise<O>
}

export interface QueryOptional<I, O> {
  query(input?: I): Promise<O>
}

export interface Mutate<I, O> {
  mutate(input: I): Promise<O>
}

export interface GeoHealthStartInput {
  brandName: string
  siteUrl: string
  industry?: string
  competitors?: string[]
  queries?: string[]
  language?: 'zh' | 'en' | 'auto'
}

export interface CitationQueryInput {
  queryText: string
  source: 'manual' | 'google_suggest' | 'llm_generated' | 'paa' | 'competitor'
  intent?: Record<string, unknown>
  pageId?: string
}

export interface RunCreateInput {
  platforms: string[]
  queryIds?: string[]
  sampleCount?: number
}

export interface SovInput {
  competitors: string[]
  dateRange: { start: string; end: string }
  platform?: string
}

export interface OptimizeInput {
  pageId?: string
  content?: string
  url?: string
  pageType?: string
}

export interface JsonLdInput {
  pageUrl: string
  schemaType: 'SoftwareApplication' | 'Organization' | 'Product' | 'FAQPage' | 'Article' | 'BreadcrumbList'
  fields: Record<string, unknown>
}

export interface LlmsTxtInput {
  pageUrl?: string
  brandName: string
  tagline: string
  sections: Array<{
    title: string
    items: Array<{ label: string; url: string; description: string }>
  }>
  updateFrequency?: { docs?: string; blog?: string }
}

export interface PageUpsertInput {
  url: string
  pageType: string
  currentContent: string
}

export interface GeoApi {
  geoHealth: {
    start: Mutate<GeoHealthStartInput, unknown>
    get: Query<{ id: string }, unknown>
    list: QueryOptional<{ limit?: number }, unknown>
    export: Query<{ id: string; format: 'markdown' | 'json' }, unknown>
  }
  agentReadiness: {
    start: Mutate<{ url: string }, unknown>
    get: Query<{ id: string }, unknown>
    list: QueryOptional<{ limit?: number }, unknown>
  }
  citation: {
    queries: {
      list: QueryOptional<{ status?: 'active' | 'paused' }, unknown>
      add: Mutate<CitationQueryInput, unknown>
    }
    runs: {
      create: Mutate<RunCreateInput, unknown>
      samples: Query<{ runId: string }, unknown>
    }
    runStatus: Query<{ runId: string }, unknown>
    getSovScore: Query<SovInput, unknown>
  }
  workspace: {
    get: QueryOptional<undefined, unknown>
  }
  content: {
    optimize: Mutate<OptimizeInput, unknown>
    pages: {
      upsert: Mutate<PageUpsertInput, unknown>
    }
  }
  schema: {
    generate: {
      jsonLd: Mutate<JsonLdInput, unknown>
      llmsTxt: Mutate<LlmsTxtInput, unknown>
    }
  }
  kg: {
    extractFromPage: Mutate<{ pageId: string }, unknown>
  }
}

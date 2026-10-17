export interface CitationEntry {
  url: string
  position: number
  snippet?: string
}

export interface SourceCitation {
  url: string
  title?: string
  snippet?: string
  position: number
  sourceType: 'api_citation' | 'grounding' | 'answer_url'
  providerMetadata?: Record<string, unknown>
}

export interface BrandMention {
  brand: string
  mentioned: boolean
  firstIndex: number | null
  count: number
}

export interface PlatformResult {
  answer: string
  sourceCitations: SourceCitation[]
  groundingSources: SourceCitation[]
  answerMentions: BrandMention[]
  raw?: unknown
}

export interface PlatformAdapter {
  name: string
  query(text: string, credentials: Record<string, string>): Promise<PlatformResult>
}

export function normalizePlatformResult(input: PlatformResult | any): PlatformResult {
  if (Array.isArray(input.sourceCitations)) {
    return {
      answer: input.answer ?? '',
      sourceCitations: input.sourceCitations,
      groundingSources: input.groundingSources ?? [],
      answerMentions: input.answerMentions ?? [],
      raw: input.raw,
    }
  }

  return {
    answer: input.answer ?? '',
    sourceCitations: (input.citations ?? []).map((c: any, i: number) => ({
      url: String(c.url),
      position: Number(c.position ?? i + 1),
      snippet: c.snippet,
      sourceType: 'answer_url' as const,
    })),
    groundingSources: [],
    answerMentions: [],
    raw: input.raw,
  }
}

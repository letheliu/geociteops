import { describe, expect, it, vi } from 'vitest'
import type { GeoApi } from './api-types.js'
import { loadConfig } from './config.js'
import { parseArgs } from './args.js'
import {
  addQueries,
  extractKnowledgeGraph,
  generateLlmsTxt,
  generateSchema,
  getShareOfVoice,
  listQueries,
  optimizeContent,
  runAgentReadinessAuditTool,
  runCitationCheck,
  runGeoHealthCheck,
  type HandlerDeps,
} from './handlers.js'
import type { Clocks } from './poll.js'
import type { AgentReadinessReport } from '../../src/modules/agent-readiness/types.js'

function clock(): Clocks {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

function deps(partial: Partial<HandlerDeps> = {}): HandlerDeps {
  return { api: null, preferLocal: false, clocks: clock(), ...partial }
}

function report(): AgentReadinessReport {
  return {
    version: 1,
    url: 'https://acme.example/',
    finalUrl: 'https://acme.example/',
    fetchedAt: '2026-11-17T00:00:00.000Z',
    durationMs: 10,
    score: 80,
    grade: 'B',
    summary: { en: 'Most crawlers can read the site.', zh: '大多数爬虫能读这个站点。' },
    checks: [],
    fixes: [{
      checkId: 'llms.txt',
      category: 'llms',
      title: { en: 'Publish llms.txt', zh: '发布 llms.txt' },
      status: 'fail',
      impact: 8,
      fix: { en: 'Add /llms.txt', zh: '加上 /llms.txt' },
      verify: { en: 'Fetch /llms.txt', zh: '抓取 /llms.txt' },
    }],
    categories: [],
  }
}

describe('loadConfig', () => {
  it('treats a blank API key as local mode', () => {
    expect(loadConfig({ GEOCITEOPS_API_KEY: '  ', GEOCITEOPS_API_URL: 'http://localhost:4000/' })).toMatchObject({
      apiUrl: 'http://localhost:4000',
      apiKey: null,
      preferLocal: false,
    })
  })

  it('rejects a non-http API URL', () => {
    expect(() => loadConfig({ GEOCITEOPS_API_URL: 'ftp://files.example' })).toThrow(/http/)
  })
})

describe('parseArgs', () => {
  it('defaults to stdio', () => {
    expect(parseArgs([])).toMatchObject({ http: false, port: 3333, host: '127.0.0.1' })
  })

  it('reads the http port', () => {
    expect(parseArgs(['--http', '--port', '4001'])).toMatchObject({ http: true, port: 4001 })
  })
})

describe('local tools', () => {
  it('builds JSON-LD without calling the API', () => {
    const mutate = vi.fn()
    const result = generateSchema(
      { schemaType: 'Organization', fields: { name: 'Acme', url: 'https://acme.example' } },
      deps({ api: { schema: { generate: { jsonLd: { mutate } } } } as unknown as GeoApi, preferLocal: true }),
    )
    return expect(result).resolves.toMatchObject({
      isError: undefined,
      data: { mode: 'local', persisted: false, valid: true },
    }).then(() => {
      expect(mutate).not.toHaveBeenCalled()
    })
  })

  it('reports a missing schema field', async () => {
    const result = await generateSchema({ schemaType: 'Organization', fields: { name: 'Acme' } }, deps())
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/url/)
  })

  it('generates llms.txt in-process', async () => {
    const result = await generateLlmsTxt({
      brandName: 'Acme',
      tagline: 'Tools for teams',
      sections: [{ title: 'Docs', items: [{ label: 'Guide', url: 'https://acme.example/guide', description: 'Start here' }] }],
    }, deps())
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('# Acme')
    expect(result.text).toContain('https://acme.example/guide')
  })

  it('validates llms.txt that is missing a summary', async () => {
    const result = await generateLlmsTxt({ text: '# Acme\n\n## Docs\n- [Guide](https://acme.example): Start' }, deps())
    expect(result.data).toMatchObject({ validation: { status: 'fail' } })
  })

  it('audits with the injected runner and does not call the API', async () => {
    const start = vi.fn()
    const result = await runAgentReadinessAuditTool(
      { url: 'https://acme.example/' },
      deps({
        api: { agentReadiness: { start: { mutate: start } } } as unknown as GeoApi,
        preferLocal: true,
        runAudit: async () => report(),
      }),
    )
    expect(start).not.toHaveBeenCalled()
    expect(result.text).toContain('80/100')
    expect(result.text).toContain('Publish llms.txt')
    expect(result.data).toMatchObject({ mode: 'local', score: 80 })
  })
})

describe('remote tools', () => {
  it('returns a job id when the health check is still running', async () => {
    const api = {
      geoHealth: {
        start: { mutate: vi.fn(async () => ({ id: 'h1', status: 'QUEUED' })) },
        get: { query: vi.fn(async () => ({ id: 'h1', status: 'RUNNING', progress: { percent: 40 } })) },
      },
    } as unknown as GeoApi
    const result = await runGeoHealthCheck(
      { brandName: 'Acme', siteUrl: 'https://acme.example/', waitMs: 1000 },
      deps({ api }),
    )
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('h1')
    expect(result.data).toMatchObject({ timedOut: true, followUp: { tool: 'get_geo_health_report', id: 'h1' } })
  })

  it('summarizes a finished health check and its top actions', async () => {
    const api = {
      geoHealth: {
        start: { mutate: vi.fn(async () => ({ id: 'h1', status: 'QUEUED' })) },
        get: { query: vi.fn(async () => ({
          id: 'h1',
          status: 'SUCCEEDED',
          progress: { percent: 100 },
          report: {
            score: 72,
            grade: 'C',
            summary: { en: 'Citations are the weak pillar.' },
            pillars: {
              agentReadiness: { score: 80 },
              citations: { score: 40 },
              citability: { score: 70 },
              structuredSignals: { score: 90 },
            },
            actions: [{ impact: 'high', title: { en: 'Allow GPTBot' }, fix: { en: 'Update robots.txt' } }],
          },
        })) },
      },
    } as unknown as GeoApi
    const result = await runGeoHealthCheck(
      { brandName: 'Acme', siteUrl: 'https://acme.example/', waitMs: 5000 },
      deps({ api }),
    )
    expect(result.text).toContain('72/100')
    expect(result.text).toContain('Allow GPTBot')
    expect(result.data).toMatchObject({ timedOut: false, score: 72 })
  })

  it('refuses library calls without an API key', async () => {
    const result = await listQueries(deps())
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/GEOCITEOPS_API_KEY/)
  })

  it('adds each query and keeps going after one failure', async () => {
    const add = vi.fn()
      .mockResolvedValueOnce({ id: 'q1', queryText: 'what is geo' })
      .mockRejectedValueOnce(new Error('duplicate'))
    const api = { citation: { queries: { add: { mutate: add } } } } as unknown as GeoApi
    const result = await addQueries({
      queries: [{ queryText: 'what is geo' }, { queryText: 'acme vs other', source: 'competitor' }],
    }, deps({ api }))
    expect(add).toHaveBeenCalledTimes(2)
    expect(result.data).toMatchObject({
      created: [{ id: 'q1' }],
      errors: [{ queryText: 'acme vs other' }],
    })
  })

  it('runs a citation check and drops raw answers', async () => {
    const api = {
      citation: {
        queries: {
          list: { query: vi.fn(async () => []) },
          add: { mutate: vi.fn(async () => ({ id: 'q1', queryText: 'best geo tool' })) },
        },
        runs: {
          create: { mutate: vi.fn(async () => ({ runId: 'r1', status: 'RUNNING' })) },
          samples: { query: vi.fn(async () => ({
            events: [{
              platform: 'deepseek',
              status: 'OK',
              brandMentioned: true,
              brandSourceCited: false,
              rankInAnswer: 1,
              sovScore: 0.5,
              citedUrls: ['https://acme.example'],
              rawAnswer: 'SECRET ANSWER',
              query: { queryText: 'best geo tool' },
            }],
          })) },
        },
        runStatus: { query: vi.fn(async () => ({ id: 'r1', status: 'COMPLETED', plannedUnits: 1, completedUnits: 1 })) },
      },
      workspace: { get: { query: vi.fn(async () => ({ platformSummary: { deepseek: { configured: true } }, competitors: [] })) } },
    } as unknown as GeoApi
    const result = await runCitationCheck({ query: 'best geo tool', waitMs: 5000 }, deps({ api }))
    expect(result.text).toContain('1 of 1')
    expect(result.text).not.toContain('SECRET ANSWER')
    expect(JSON.stringify(result.data)).not.toContain('SECRET ANSWER')
    expect(result.data).toMatchObject({ runId: 'r1', mentioned: 1 })
  })

  it('returns the run id when the citation check is still going', async () => {
    const api = {
      citation: {
        queries: {
          list: { query: vi.fn(async () => [{ id: 'q9', queryText: 'geo' }]) },
          add: { mutate: vi.fn() },
        },
        runs: { create: { mutate: vi.fn(async () => ({ runId: 'r9', status: 'RUNNING' })) } },
        runStatus: { query: vi.fn(async () => ({ id: 'r9', status: 'RUNNING', plannedUnits: 4, completedUnits: 1 })) },
      },
      workspace: { get: { query: vi.fn() } },
    } as unknown as GeoApi
    const result = await runCitationCheck({ queryId: 'q9', platforms: ['deepseek'], waitMs: 1000 }, deps({ api }))
    expect(result.data).toMatchObject({ runId: 'r9', timedOut: true })
    expect(api.citation.queries.add.mutate).not.toHaveBeenCalled()
  })

  it('names the missing-engine case before creating a run', async () => {
    const create = vi.fn()
    const api = {
      citation: {
        queries: { list: { query: vi.fn(async () => []) }, add: { mutate: vi.fn(async () => ({ id: 'q1' })) } },
        runs: { create: { mutate: create } },
      },
      workspace: { get: { query: vi.fn(async () => ({ platformSummary: { deepseek: { configured: false } }, competitors: [] })) } },
    } as unknown as GeoApi
    const result = await runCitationCheck({ query: 'geo', waitMs: 0 }, deps({ api }))
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/No AI engines/)
    expect(create).not.toHaveBeenCalled()
  })

  it('reads share of voice for the default window', async () => {
    const query = vi.fn(async () => ({ sovMean: 0.42, brandMentionRate: 0.5 }))
    const api = {
      citation: { getSovScore: { query } },
      workspace: { get: { query: vi.fn(async () => ({ competitors: ['Other'] })) } },
    } as unknown as GeoApi
    const result = await getShareOfVoice({}, deps({ api, clocks: { now: () => Date.parse('2026-11-17T00:00:00.000Z'), sleep: async () => undefined } }))
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      competitors: ['Other'],
      dateRange: { start: '2026-10-19T00:00:00.000Z', end: '2026-11-17T00:00:00.000Z' },
    }))
    expect(result.text).toContain('0.42')
  })

  it('fetches a URL and sends the text to optimize', async () => {
    const mutate = vi.fn(async () => ({ overallScore: 61, rewrittenCount: 1, atoms: [{ text: 'Acme is a tool.', score: { total: 80 } }], faqs: [], report: {} }))
    const api = { content: { optimize: { mutate } } } as unknown as GeoApi
    const result = await optimizeContent({ url: 'https://acme.example' }, deps({
      api,
      fetchUrl: async () => ({ url: 'https://acme.example', status: 200, body: '<p>Acme is a tool.</p>', contentType: 'text/html' }),
    }))
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ content: 'Acme is a tool.', url: 'https://acme.example' }))
    expect(result.text).toContain('61')
  })

  it('extracts a knowledge graph from a page id', async () => {
    const api = {
      kg: {
        extractFromPage: { mutate: vi.fn(async () => ({
          task: { id: 't1' },
          proposals: { entities: [{ name: 'Acme', type: 'Organization' }], relations: [] },
        })) },
      },
    } as unknown as GeoApi
    const result = await extractKnowledgeGraph({ pageId: 'p1' }, deps({ api }))
    expect(result.data).toMatchObject({ pageId: 'p1', entityCount: 1, entities: [{ name: 'Acme' }] })
  })
})

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { GeoApi } from './api-types.js'
import { SCHEMA_TYPES } from './local.js'
import {
  addQueries,
  extractKnowledgeGraph,
  generateLlmsTxt,
  generateSchema,
  getAgentReadinessReport,
  getGeoHealthReport,
  getShareOfVoice,
  listQueries,
  optimizeContent,
  runAgentReadinessAuditTool,
  runCitationCheck,
  runGeoHealthCheck,
  type HandlerDeps,
} from './handlers.js'
import { isToolOutput, type ToolOutput } from './result.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface GeoMcpOptions {
  api: GeoApi | null
  preferLocal: boolean
  version: string
}

const querySource = z.enum(['manual', 'google_suggest', 'llm_generated', 'paa', 'competitor'])
const queryItem = z.union([
  z.string().trim().min(1).max(500),
  z.object({
    queryText: z.string().trim().min(1).max(500),
    source: querySource.optional(),
    pageId: z.string().min(1).optional(),
    intent: z.record(z.string(), z.unknown()).optional(),
  }),
])

function normalizeQueries(queries: Array<z.infer<typeof queryItem>>) {
  return queries.map((query) => (typeof query === 'string' ? { queryText: query } : query))
}

function depsFrom(options: GeoMcpOptions, extra: Extra): HandlerDeps {
  return {
    api: options.api,
    preferLocal: options.preferLocal,
    signal: extra.signal,
    onProgress: async (progress, total, message) => {
      const token = extra._meta?.progressToken
      if (token === undefined) return
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total, message },
      })
    },
  }
}

function toResult(output: ToolOutput): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: output.text }],
    isError: output.isError,
  }
  if (!output.isError && output.data && typeof output.data === 'object' && !Array.isArray(output.data)) {
    result.structuredContent = output.data as Record<string, unknown>
  }
  return result
}

async function run(extra: Extra, options: GeoMcpOptions, task: (deps: HandlerDeps) => Promise<ToolOutput>): Promise<CallToolResult> {
  try {
    const output = await task(depsFrom(options, extra))
    if (!isToolOutput(output)) throw new Error('Tool returned an unexpected value')
    return toResult(output)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

const instructions = [
  'GeoCiteOps tools for generative engine optimization.',
  'With no API key, run_agent_readiness_audit, generate_llms_txt, and generate_schema run in-process.',
  'GEO health, citation checks, share of voice, content rewrite, and knowledge graph extraction need GEOCITEOPS_API_URL and GEOCITEOPS_API_KEY.',
  'Long jobs return a job id when the wait ends. Fetch them with the matching get tool.',
].join(' ')

export function createGeoMcpServer(options: GeoMcpOptions): McpServer {
  const server = new McpServer(
    { name: 'geociteops', version: options.version },
    { instructions },
  )

  server.registerTool('run_geo_health_check', {
    title: 'Run GEO health check',
    description: 'Start a GEO health check (agent readiness, citation snapshot, citability, structured signals) and poll until it finishes or waitMs elapses. Returns the score, pillar scores, top actions, and a job id. Requires GEOCITEOPS_API_KEY. Default wait is 45 seconds. Pass waitMs 0 to return the job id immediately.',
    inputSchema: {
      brandName: z.string().trim().min(1).max(80).describe('Brand name'),
      siteUrl: z.string().trim().min(1).max(2048).describe('Official http(s) URL'),
      industry: z.string().trim().max(80).optional(),
      competitors: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
      queries: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
      language: z.enum(['zh', 'en', 'auto']).optional(),
      waitMs: z.number().int().min(0).max(180000).optional().describe('How long to poll before returning the job id'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, async (args, extra) => run(extra, options, (deps) => runGeoHealthCheck(args, deps)))

  server.registerTool('get_geo_health_report', {
    title: 'Get GEO health report',
    description: 'Fetch a GEO health check by id. Pass format markdown or json to export the stored report. Requires GEOCITEOPS_API_KEY.',
    inputSchema: {
      id: z.string().min(1),
      format: z.enum(['markdown', 'json']).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, extra) => run(extra, options, (deps) => getGeoHealthReport(args, deps)))

  server.registerTool('run_agent_readiness_audit', {
    title: 'Run agent readiness audit',
    description: 'Score a public URL for AI crawlers: robots.txt, llms.txt, sitemap, page signals, markdown, and bot access. Runs in-process when no API key is set (or GEOCITEOPS_PREFER_LOCAL=1). With an API key, queues the audit and polls. Returns score, grade, and the highest-impact fixes.',
    inputSchema: {
      url: z.string().trim().min(1).max(2048).describe('Public http(s) URL'),
      waitMs: z.number().int().min(0).max(180000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, async (args, extra) => run(extra, options, (deps) => runAgentReadinessAuditTool(args, deps)))

  server.registerTool('get_agent_readiness_report', {
    title: 'Get agent readiness report',
    description: 'Fetch a stored agent readiness audit by id. Local audits are not stored; this needs GEOCITEOPS_API_KEY.',
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, extra) => run(extra, options, (deps) => getAgentReadinessReport(args, deps)))

  server.registerTool('list_queries', {
    title: 'List citation queries',
    description: 'List active queries in the workspace query library. Requires GEOCITEOPS_API_KEY. The API currently returns active queries only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (_args, extra) => run(extra, options, (deps) => listQueries(deps)))

  server.registerTool('add_queries', {
    title: 'Add citation queries',
    description: 'Add one or more queries to the workspace query library. Each item is a string or { queryText, source, pageId }. Source defaults to manual. Requires GEOCITEOPS_API_KEY.',
    inputSchema: {
      queries: z.array(queryItem).min(1).max(20),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (args, extra) => run(extra, options, (deps) => addQueries({ queries: normalizeQueries(args.queries) }, deps)))

  server.registerTool('run_citation_check', {
    title: 'Run citation check',
    description: 'Run one query across the workspace AI engines (or the platforms you pass). Adds the query to the library when query text is new. Polls the run and returns mention counts. Omits raw model answers. On timeout, returns the run id. Requires GEOCITEOPS_API_KEY.',
    inputSchema: {
      query: z.string().trim().min(1).max(500).optional().describe('Question text. Added to the library if it is not already there.'),
      queryId: z.string().min(1).optional(),
      platforms: z.array(z.string().min(1)).min(1).max(12).optional().describe('Engine ids: deepseek, doubao, qwen, ernie, perplexity, chatgpt, gemini, kimi, yuanbao. Defaults to engines with credentials. kimi is Moonshot; yuanbao is the Hunyuan API.'),
      sampleCount: z.number().int().min(1).max(20).optional(),
      waitMs: z.number().int().min(0).max(180000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, async (args, extra) => run(extra, options, (deps) => runCitationCheck(args, deps)))

  server.registerTool('get_share_of_voice', {
    title: 'Get share of voice',
    description: 'Share of voice, mention rate, and citation rate for a date range. Defaults to the last 30 days and the workspace competitor list. Requires GEOCITEOPS_API_KEY.',
    inputSchema: {
      competitors: z.array(z.string()).max(20).optional(),
      start: z.string().optional().describe('Range start, ISO date'),
      end: z.string().optional().describe('Range end, ISO date'),
      platform: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, extra) => run(extra, options, (deps) => getShareOfVoice(args, deps)))

  server.registerTool('optimize_content', {
    title: 'Optimize content',
    description: 'Atomize, score, and rewrite a page. Pass text, a public url (fetched then sent to the API), or a stored pageId. Requires GEOCITEOPS_API_KEY. Rewrite uses the workspace LLM.',
    inputSchema: {
      url: z.string().optional(),
      text: z.string().max(100000).optional(),
      pageId: z.string().optional(),
      pageType: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, async (args, extra) => run(extra, options, (deps) => optimizeContent(args, deps)))

  server.registerTool('generate_schema', {
    title: 'Generate JSON-LD',
    description: `Build Schema.org JSON-LD and validate it. Registry types: ${SCHEMA_TYPES.join(', ')}. With an API key and pageUrl, SoftwareApplication, Organization, Product, FAQPage, Article, and BreadcrumbList are stored. Other types, or no API key, are generated in-process and not stored.`,
    inputSchema: {
      schemaType: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).describe('Properties for that schema type'),
      pageUrl: z.string().optional().describe('Page URL. Required only when storing on the workspace.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => run(extra, options, (deps) => generateSchema(args, deps)))

  server.registerTool('generate_llms_txt', {
    title: 'Generate or validate llms.txt',
    description: 'Generate llms.txt from brandName, tagline, and sections, or validate existing markdown (text) or a live /llms.txt (url). Generation runs in-process. With an API key it is also stored, unless GEOCITEOPS_PREFER_LOCAL=1.',
    inputSchema: {
      brandName: z.string().min(1).max(200).optional(),
      tagline: z.string().min(1).max(500).optional(),
      sections: z.array(z.object({
        title: z.string().min(1),
        items: z.array(z.object({
          label: z.string().min(1),
          url: z.string().min(1),
          description: z.string(),
        })).max(50),
      })).max(20).optional(),
      updateFrequency: z.object({
        docs: z.string().optional(),
        blog: z.string().optional(),
      }).optional(),
      pageUrl: z.string().optional(),
      text: z.string().max(200000).optional().describe('Existing llms.txt markdown to validate'),
      url: z.string().optional().describe('Site or llms.txt URL to fetch and validate'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, async (args, extra) => run(extra, options, (deps) => generateLlmsTxt(args, deps)))

  server.registerTool('extract_knowledge_graph', {
    title: 'Extract knowledge graph',
    description: 'Extract entities and relations from a stored pageId, from text, or from a public url. Text and url are saved as a content page first. Requires GEOCITEOPS_API_KEY and the workspace LLM.',
    inputSchema: {
      pageId: z.string().optional(),
      url: z.string().optional(),
      text: z.string().max(100000).optional(),
      pageType: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, async (args, extra) => run(extra, options, (deps) => extractKnowledgeGraph(args, deps)))

  server.registerPrompt('geo-audit', {
    title: 'GEO audit',
    description: 'Audit a public URL for AI crawler readiness. Use for "/geo audit <url>".',
    argsSchema: {
      url: z.string().describe('Public http(s) URL'),
    },
  }, ({ url }) => ({
    description: `Agent readiness audit for ${url}`,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Run a GeoCiteOps agent readiness audit for ${url}.`,
          'Call run_agent_readiness_audit with that URL.',
          'Lead with the score and grade, then the highest-impact fixes and how to verify each one.',
          'Use only checks present in the tool result. If the result includes a job id and no score, call get_agent_readiness_report.',
        ].join('\n'),
      },
    }],
  }))

  server.registerPrompt('improve-citations', {
    title: 'Improve citations',
    description: 'Plan how a brand gets cited more often. Use for "/geo improve-citations <brand>".',
    argsSchema: {
      brand: z.string().describe('Brand name'),
    },
  }, ({ brand }) => ({
    description: `Citation improvement plan for ${brand}`,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Improve how AI answer engines cite ${brand}.`,
          'If an API key is configured, call get_share_of_voice and list_queries.',
          'Ask for the official URL if you do not have it, then call run_geo_health_check or run_agent_readiness_audit.',
          'Recommend the top fixes from the tool results. Do not invent mention rates, share of voice, or engine names that the tools did not return.',
          'When a job is still running, say so and keep the job id.',
        ].join('\n'),
      },
    }],
  }))

  server.registerResource(
    'latest-geo-health',
    'geociteops://reports/geo-health/latest',
    {
      description: 'Latest GEO health check for the workspace API key. Explains local mode when no key is set.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await latest(options, 'geo-health')),
      }],
    }),
  )

  server.registerResource(
    'latest-agent-readiness',
    'geociteops://reports/agent-readiness/latest',
    {
      description: 'Latest stored agent readiness audit. Local audits are not listed here.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await latest(options, 'agent-readiness')),
      }],
    }),
  )

  return server
}

async function latest(options: GeoMcpOptions, kind: 'geo-health' | 'agent-readiness'): Promise<unknown> {
  if (!options.api || options.preferLocal) {
    return {
      available: false,
      reason: 'No workspace API key is configured, or local mode is forced. Stored reports live on the GeoCiteOps server.',
    }
  }
  try {
    if (kind === 'geo-health') {
      const rows = await options.api.geoHealth.list.query({ limit: 1 })
      const first = Array.isArray(rows) ? rows[0] : null
      const id = first && typeof first === 'object' && first && 'id' in first ? String(first.id) : null
      if (!id) return { available: false, reason: 'No GEO health checks stored.' }
      return { available: true, report: await options.api.geoHealth.get.query({ id }) }
    }
    const rows = await options.api.agentReadiness.list.query({ limit: 1 })
    const first = Array.isArray(rows) ? rows[0] : null
    const id = first && typeof first === 'object' && first && 'id' in first ? String(first.id) : null
    if (!id) return { available: false, reason: 'No agent readiness audits stored.' }
    return { available: true, report: await options.api.agentReadiness.get.query({ id }) }
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : 'Could not load the latest report.' }
  }
}

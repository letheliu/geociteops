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
import { redactSecret } from './redact.js'
import { toolDenial, type McpPrincipal } from './scopes.js'
import { credentialAllows } from '../../src/platform/tenancy/credential-scopes.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface GeoMcpOptions {
  api: GeoApi | null
  preferLocal: boolean
  version: string
  /** Set on HTTP after the bearer token is accepted. stdio leaves this empty. */
  principal?: McpPrincipal | null
  /** Process-level demo switch. Also true when the token's API is in DEMO_MODE. */
  readOnly?: boolean
  /** HTTP bearer, used only to scrub error text. Never log it. */
  secret?: string | null
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
    readOnly: options.readOnly || options.principal?.readOnly === true,
    allowWrite: options.principal
      ? credentialAllows(options.principal.scopes, 'run-checks')
      : true,
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
    const message = redactSecret(err instanceof Error ? err.message : 'Unexpected error', options.secret)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

function guarded(
  options: GeoMcpOptions,
  name: string,
  handler: (args: any, deps: HandlerDeps) => Promise<ToolOutput>,
) {
  return async (args: any, extra: Extra): Promise<CallToolResult> => {
    const denial = toolDenial(name, { principal: options.principal ?? null, readOnly: options.readOnly === true }, args)
    if (denial) return { content: [{ type: 'text', text: denial }], isError: true }
    return run(extra, options, (deps) => handler(args, deps))
  }
}

const instructions = [
  'GeoCiteOps tools for generative engine optimization.',
  'Use run_geo_health_check for a full score, run_agent_readiness_audit for crawler access, and generate_llms_txt or generate_schema when the user wants those files.',
  'stdio with no API key runs readiness, llms.txt, and JSON-LD in-process.',
  'HTTP requires Authorization: Bearer with a workspace token. read can fetch reports. run-checks starts jobs, writes, and can call paid models.',
  'DEMO_MODE is read-only. Long jobs return a job id when the wait ends.',
].join(' ')

export function createGeoMcpServer(options: GeoMcpOptions): McpServer {
  const server = new McpServer(
    { name: 'geociteops', version: options.version },
    { instructions },
  )

  server.registerTool('run_geo_health_check', {
    title: 'Run GEO health check',
    description: 'Use when the user wants one GEO score for a brand and its official site. Starts the check and polls. Writes a workspace job and can call paid AI engines. Returns the score, pillar scores, top actions, and a job id. Needs the run-checks scope. Default wait is 45 seconds. Pass waitMs 0 to return the job id immediately.',
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
  }, guarded(options, 'run_geo_health_check', (args, deps) => runGeoHealthCheck(args, deps)))

  server.registerTool('get_geo_health_report', {
    title: 'Get GEO health report',
    description: 'Use when a GEO health job id is already known. Fetches that check. Pass format markdown or json to export the stored report. Read-only. Needs the read scope.',
    inputSchema: {
      id: z.string().min(1),
      format: z.enum(['markdown', 'json']).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  }, guarded(options, 'get_geo_health_report', (args, deps) => getGeoHealthReport(args, deps)))

  server.registerTool('run_agent_readiness_audit', {
    title: 'Run agent readiness audit',
    description: 'Use when the user asks if AI crawlers can read one public URL. Scores robots.txt, llms.txt, sitemap, page signals, markdown, and bot access. stdio with no key runs in-process and does not store the audit. With an API token it writes a job and polls. Needs run-checks on HTTP. Not a paid model call.',
    inputSchema: {
      url: z.string().trim().min(1).max(2048).describe('Public http(s) URL'),
      waitMs: z.number().int().min(0).max(180000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, guarded(options, 'run_agent_readiness_audit', (args, deps) => runAgentReadinessAuditTool(args, deps)))

  server.registerTool('get_agent_readiness_report', {
    title: 'Get agent readiness report',
    description: 'Use when an agent-readiness job id is already known. Fetches that stored audit. Local audits are not stored. Read-only. Needs the read scope.',
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  }, guarded(options, 'get_agent_readiness_report', (args, deps) => getAgentReadinessReport(args, deps)))

  server.registerTool('list_queries', {
    title: 'List citation queries',
    description: 'Use when the user wants the workspace question list before a citation check. Returns active queries only. Read-only. Needs the read scope.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  }, guarded(options, 'list_queries', (_args, deps) => listQueries(deps)))

  server.registerTool('add_queries', {
    title: 'Add citation queries',
    description: 'Use when the user wants new questions saved in the query library. Each item is a string or { queryText, source, pageId }. Source defaults to manual. Writes the library. Needs the run-checks scope. Not a paid model call.',
    inputSchema: {
      queries: z.array(queryItem).min(1).max(20),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guarded(options, 'add_queries', (args, deps) => addQueries({ queries: normalizeQueries(args.queries) }, deps)))

  server.registerTool('run_citation_check', {
    title: 'Run citation check',
    description: 'Use when the user wants mention counts for one question. Runs it on the workspace AI engines, or on platforms you pass. Adds new query text to the library. Writes a run and calls paid models. Omits raw answers. On timeout, returns the run id. Needs the run-checks scope.',
    inputSchema: {
      query: z.string().trim().min(1).max(500).optional().describe('Question text. Added to the library if it is not already there.'),
      queryId: z.string().min(1).optional(),
      platforms: z.array(z.string().min(1)).min(1).max(12).optional().describe('Engine ids: deepseek, doubao, qwen, ernie, perplexity, chatgpt, gemini, kimi, yuanbao. Defaults to engines with credentials. kimi is Moonshot; yuanbao is the Hunyuan API.'),
      sampleCount: z.number().int().min(1).max(20).optional(),
      waitMs: z.number().int().min(0).max(180000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  }, guarded(options, 'run_citation_check', (args, deps) => runCitationCheck(args, deps)))

  server.registerTool('get_share_of_voice', {
    title: 'Get share of voice',
    description: 'Use when the user wants share of voice for a date range. Defaults to the last 30 days and the workspace competitor list. Read-only. Needs the read scope.',
    inputSchema: {
      competitors: z.array(z.string()).max(20).optional(),
      start: z.string().optional().describe('Range start, ISO date'),
      end: z.string().optional().describe('Range end, ISO date'),
      platform: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  }, guarded(options, 'get_share_of_voice', (args, deps) => getShareOfVoice(args, deps)))

  server.registerTool('optimize_content', {
    title: 'Optimize content',
    description: 'Use when the user wants a page split into claims, scored, and rewritten. Pass text, a public url, or a stored pageId. Writes the workspace and calls a paid model. Destructive: the rewrite can replace stored page content. Needs the run-checks scope.',
    inputSchema: {
      url: z.string().optional(),
      text: z.string().max(100000).optional(),
      pageId: z.string().optional(),
      pageType: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  }, guarded(options, 'optimize_content', (args, deps) => optimizeContent(args, deps)))

  server.registerTool('generate_schema', {
    title: 'Generate JSON-LD',
    description: `Use when the user wants Schema.org JSON-LD for a page. Registry types: ${SCHEMA_TYPES.join(', ')}. Validates the document. A read token generates it and does not store it. Storing SoftwareApplication, Organization, Product, FAQPage, Article, or BreadcrumbList needs pageUrl and the run-checks scope. Not a paid model call.`,
    inputSchema: {
      schemaType: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).describe('Properties for that schema type'),
      pageUrl: z.string().optional().describe('Page URL. Required only when storing on the workspace.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(options, 'generate_schema', (args, deps) => generateSchema(args, deps)))

  server.registerTool('generate_llms_txt', {
    title: 'Generate or validate llms.txt',
    description: 'Use when the user wants llms.txt written or checked. Generate from brandName, tagline, and sections, or validate markdown (text) or a live file (url). A read token does not store the file. Storing needs the run-checks scope, unless GEOCITEOPS_PREFER_LOCAL=1. Not a paid model call. Fetching url contacts that site.',
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
  }, guarded(options, 'generate_llms_txt', (args, deps) => generateLlmsTxt(args, deps)))

  server.registerTool('extract_knowledge_graph', {
    title: 'Extract knowledge graph',
    description: 'Use when the user wants entities and relations from a page. Pass a stored pageId, text, or a public url. Text and url are saved as a content page first. Writes the workspace and calls a paid model. Destructive: saving text or a url overwrites that page. Needs the run-checks scope.',
    inputSchema: {
      pageId: z.string().optional(),
      url: z.string().optional(),
      text: z.string().max(100000).optional(),
      pageType: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  }, guarded(options, 'extract_knowledge_graph', (args, deps) => extractKnowledgeGraph(args, deps)))

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
    async (uri) => {
      const denial = toolDenial('get_geo_health_report', {
        principal: options.principal ?? null,
        readOnly: options.readOnly === true,
      })
      const payload = denial ? { available: false, reason: denial } : await latest(options, 'geo-health')
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(payload),
        }],
      }
    },
  )

  server.registerResource(
    'latest-agent-readiness',
    'geociteops://reports/agent-readiness/latest',
    {
      description: 'Latest stored agent readiness audit. Local audits are not listed here.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const denial = toolDenial('get_agent_readiness_report', {
        principal: options.principal ?? null,
        readOnly: options.readOnly === true,
      })
      const payload = denial ? { available: false, reason: denial } : await latest(options, 'agent-readiness')
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(payload),
        }],
      }
    },
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

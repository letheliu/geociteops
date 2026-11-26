import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { startHttpServer } from './http.js'
import { createGeoMcpServer } from './server.js'

const TOOLS = [
  'run_geo_health_check',
  'get_geo_health_report',
  'run_agent_readiness_audit',
  'get_agent_readiness_report',
  'list_queries',
  'add_queries',
  'run_citation_check',
  'get_share_of_voice',
  'optimize_content',
  'generate_schema',
  'generate_llms_txt',
  'extract_knowledge_graph',
]

async function connect() {
  const server = createGeoMcpServer({ api: null, preferLocal: false, version: '0.0.0-test' })
  const client = new Client({ name: 'geociteops-smoke', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

describe('MCP protocol', () => {
  it('lists the GEO tools and calls generate_schema', async () => {
    const { client, server } = await connect()
    try {
      const listed = await client.listTools()
      const names = listed.tools.map((tool) => tool.name)
      for (const name of TOOLS) expect(names).toContain(name)

      const prompts = await client.listPrompts()
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining(['geo-audit', 'improve-citations']))

      const resources = await client.listResources()
      expect(resources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
        'geociteops://reports/geo-health/latest',
        'geociteops://reports/agent-readiness/latest',
      ]))

      const result = await client.callTool({
        name: 'generate_schema',
        arguments: {
          schemaType: 'Organization',
          fields: { name: 'Acme', url: 'https://acme.example' },
        },
      })
      const text = JSON.stringify(result)
      expect(text).toContain('Acme')
      expect(text).toContain('https://schema.org')
      expect(text).not.toContain('"isError":true')

      const missing = await client.callTool({
        name: 'list_queries',
        arguments: {},
      })
      expect(JSON.stringify(missing)).toContain('GEOCITEOPS_API_KEY')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('answers initialize on the local HTTP endpoint when a bearer token is accepted', async () => {
    const http = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      authenticate: async () => ({ credentialId: 'c', workspaceId: 'w', scopes: ['read'], readOnly: false }),
      createServer: () => createGeoMcpServer({ api: null, preferLocal: false, version: '0.0.0-test' }),
    })
    try {
      const response = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer geo_test_token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'geociteops-http-smoke', version: '0' },
          },
        }),
      })
      const text = await response.text()
      expect(response.status).toBe(200)
      expect(text).toContain('geociteops')
    } finally {
      await http.close()
    }
  })
})

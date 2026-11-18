import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

describe('stdio bin', () => {
  it('lists tools and generates JSON-LD', async () => {
    execFileSync('pnpm', ['--filter', './mcp', 'build'], { cwd: repoRoot, stdio: 'inherit' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      env: { ...getDefaultEnvironment(), GEOCITEOPS_API_KEY: '' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'geociteops-bin-smoke', version: '0.0.0' })
    await client.connect(transport)
    try {
      const listed = await client.listTools()
      expect(listed.tools.some((tool) => tool.name === 'generate_llms_txt')).toBe(true)
      const result = await client.callTool({
        name: 'generate_llms_txt',
        arguments: {
          brandName: 'Acme',
          tagline: 'Tools for teams',
          sections: [],
        },
      })
      expect(JSON.stringify(result)).toContain('# Acme')
    } finally {
      await client.close()
    }
  }, 30_000)
})

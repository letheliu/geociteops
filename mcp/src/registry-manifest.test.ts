import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)

describe('MCP registry packet', () => {
  it('keeps the root smithery.yaml identical to the packet copy', () => {
    const primary = readFileSync(new URL('smithery.yaml', root), 'utf8')
    const packet = readFileSync(new URL('integrations/mcp-registry/smithery.yaml', root), 'utf8')
    expect(packet).toBe(primary)
    expect(primary).toContain("@geociteops/mcp")
  })

  it('points server.json at the same server name as mcp/package.json', () => {
    const server = JSON.parse(readFileSync(new URL('integrations/mcp-registry/server.json', root), 'utf8')) as {
      name: string
      version: string
      packages: Array<{ identifier: string; version: string; transport: { type: string } }>
    }
    const pkg = JSON.parse(readFileSync(new URL('mcp/package.json', root), 'utf8')) as {
      name: string
      version: string
      mcpName: string
    }
    expect(server.name).toBe(pkg.mcpName)
    expect(server.name).toBe('io.github.letheliu/geociteops')
    expect(server.version).toBe(pkg.version)
    expect(server.packages[0]?.identifier).toBe(pkg.name)
    expect(server.packages[0]?.version).toBe(pkg.version)
    expect(server.packages[0]?.transport.type).toBe('stdio')
  })
})

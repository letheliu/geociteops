import { describe, it, expect, vi } from 'vitest'
import { createGraphExporter } from './exporter.js'
import type { PrismaClient } from '@prisma/client'

function mockPrisma(entities: any[] = [], relations: any[] = []) {
  return {
    kgEntity: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        let result = entities
        const ws = where?.workspaceId
        if (ws) result = result.filter((e) => e.workspaceId === ws)
        if (where?.id?.in) result = result.filter((e) => where.id.in.includes(e.id))
        return result
      }),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
        entities.find((e) => e.id === where.id),
      ),
    },
    kgRelation: {
      findMany: vi.fn().mockResolvedValue(relations),
    },
  } as unknown as PrismaClient
}

describe('GraphExporter', () => {
  it('export jsonld 输出 @context + @graph 结构', async () => {
    const exporter = createGraphExporter(
      mockPrisma(
        [
          { id: 'e1', workspaceId: 'w1', name: 'zoomer AI', type: 'SoftwareApplication', properties: { url: 'https://x.com' } },
        ],
        [],
      ),
    )
    const out = await exporter.export({ workspaceId: 'w1', format: 'jsonld' })
    const parsed = JSON.parse(out)
    expect(parsed['@context']).toBeDefined()
    expect(parsed['@graph']).toHaveLength(1)
    expect(parsed['@graph'][0]['@type']).toBe('SoftwareApplication')
    expect(parsed['@graph'][0]['@id']).toContain('zoomer-ai')
  })

  it('export turtle 输出 @prefix + 主语谓语宾语句子', async () => {
    const exporter = createGraphExporter(
      mockPrisma(
        [
          { id: 'e1', workspaceId: 'w1', name: 'zoomer AI', type: 'SoftwareApplication', properties: { name: 'zoomer AI', url: 'https://x.com' } },
        ],
        [],
      ),
    )
    const out = await exporter.export({ workspaceId: 'w1', format: 'turtle' })
    expect(out).toMatch(/^@prefix/)
    expect(out).toContain('a schema:SoftwareApplication')
    expect(out).toMatch(/schema:name\s+"zoomer AI"/)
  })

  it('空 workspace 时 jsonld 输出空 @graph', async () => {
    const exporter = createGraphExporter(mockPrisma([]))
    const out = await exporter.export({ workspaceId: 'empty', format: 'jsonld' })
    const parsed = JSON.parse(out)
    expect(parsed['@graph']).toEqual([])
  })

  it('空 workspace 时 turtle 仅输出 @prefix', async () => {
    const exporter = createGraphExporter(mockPrisma([]))
    const out = await exporter.export({ workspaceId: 'empty', format: 'turtle' })
    expect(out).toMatch(/^@prefix/)
  })

  it('entityIds 过滤生效', async () => {
    const exporter = createGraphExporter(
      mockPrisma([
        { id: 'e1', workspaceId: 'w1', name: 'A', type: 'X', properties: {} },
        { id: 'e2', workspaceId: 'w1', name: 'B', type: 'X', properties: {} },
      ]),
    )
    const out = await exporter.export({ workspaceId: 'w1', format: 'jsonld', entityIds: ['e1'] })
    const parsed = JSON.parse(out)
    expect(parsed['@graph']).toHaveLength(1)
    expect(parsed['@graph'][0]['@id']).toContain('a')
  })
})

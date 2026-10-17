import { describe, it, expect, vi } from 'vitest'
import { schemaRouter } from './router.js'

function mockCtx(services: any, workspaceId = 'w1') {
  // 任务 9：Context 双通道形状——补 actor/requestMeta/status mock 字段
  return {
    workspace: { id: workspaceId, status: 'ACTIVE' },
    actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId } },
    requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
    services,
  } as any
}

describe('schemaRouter', () => {
  const schema = {
    generateJsonLd: vi.fn().mockImplementation((input: any) => ({ jsonld: { '@type': input.schemaType }, record: { id: 'sr-1' } })),
    generateLlmsTxt: vi.fn().mockResolvedValue({ markdown: '# x', record: { id: 'sr-2' } }),
    regenerateForPage: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    buildAutoSections: vi.fn().mockResolvedValue({ sections: [], warnings: [] }),
  }
  const services = { schema }

  it('generate.jsonLd 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    const input = { pageUrl: 'https://x.com', schemaType: 'SoftwareApplication' as const, fields: { name: 'a', applicationCategory: 'b' } }
    const result = await caller.generate.jsonLd(input)
    expect(schema.generateJsonLd).toHaveBeenCalledWith({ workspaceId: 'w1', ...input })
    expect(result.jsonld['@type']).toBe('SoftwareApplication')
  })

  it('generate.llmsTxt 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    const input = { brandName: 'z', tagline: 't', sections: [{ title: 'S', items: [] }] }
    const result = await caller.generate.llmsTxt(input)
    expect(schema.generateLlmsTxt).toHaveBeenCalled()
    expect(result.markdown).toBe('# x')
  })

  it('autoSections 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.autoSections()
    expect(schema.buildAutoSections).toHaveBeenCalledWith('w1')
  })

  it('list 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.list({ pageUrl: 'https://x.com' })
    expect(schema.list).toHaveBeenCalledWith({ workspaceId: 'w1', pageUrl: 'https://x.com' })
  })

  it('get 路由注入 workspaceId', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.get({ id: 'sr-1' })
    expect(schema.getById).toHaveBeenCalledWith('w1', 'sr-1')
  })

  it('regenerateForPage 路由', async () => {
    const caller = schemaRouter.createCaller(mockCtx(services))
    await caller.regenerateForPage({ pageId: 'page-1' })
    expect(schema.regenerateForPage).toHaveBeenCalledWith('page-1')
  })
})

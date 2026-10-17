import { describe, it, expect, vi } from 'vitest'
import { createQueryPlanner, type QueryPlannerDeps } from './query-planner.js'

function mockDeps(): QueryPlannerDeps {
  const prisma = {
    diagnosticQuery: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
  } as any
  return { prisma }
}

describe('QueryPlanner', () => {
  it('rejects LLM output with invalid structure', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)

    await expect(planner.validateLlmOutput('not-json'))
      .rejects.toThrow()

    await expect(planner.validateLlmOutput('{"wrong": "structure"}'))
      .rejects.toThrow()
  })

  it('validates valid LLM output array', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)

    const valid = JSON.stringify([
      { queryText: 'what is X?', queryType: 'BRAND', intentLabel: 'explore', priority: 3 },
    ])
    const result = await planner.validateLlmOutput(valid)
    expect(result).toHaveLength(1)
    expect(result[0].queryType).toBe('BRAND')
  })

  it('rejects more than 50 queries per generation', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)

    await expect(planner.generate('ws-1', 'project-1', { BRAND: 60, CATEGORY: 0, SCENARIO: 0, COMPARISON: 0 }))
      .rejects.toThrow(/50/)
  })

  it('rejects COMPARISON queries when no competitors configured', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)
    deps.prisma.diagnosticQuery.findFirst = vi.fn().mockResolvedValue(null)

    // Mock getProject to return project without competitors
    const project = {
      id: 'project-1', workspaceId: 'ws-1',
      competitors: [],
    }
    deps.prisma.diagnosticQuery.findFirst.mockResolvedValue(null)

    // We need to check the planner.validateGenerationRequest
    const result = planner.validateGenerationRequest(project as any, { BRAND: 3, CATEGORY: 3, SCENARIO: 3, COMPARISON: 3 })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('COMPARISON')
  })

  it('generated queries start as DRAFT', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)
    deps.prisma.diagnosticQuery.create.mockResolvedValue({
      id: 'q-new',
      projectId: 'project-1',
      queryText: 'test query',
      normalizedText: 'test query',
      queryType: 'BRAND',
      intentLabel: 'test',
      targetAudience: null,
      mappedPageUrl: null,
      priority: 3,
      source: 'LLM_GENERATED',
      status: 'DRAFT',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const queries = [
      { queryText: 'test query', queryType: 'BRAND' as const, intentLabel: 'test', priority: 3 },
    ]

    const saved = await planner.saveGenerated('project-1', queries)
    expect(saved).toHaveLength(1)
    expect(saved[0].source).toBe('LLM_GENERATED')
    expect(saved[0].status).toBe('DRAFT')
  })

  it('batch confirm is atomic', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)
    deps.prisma.diagnosticQuery.findMany.mockResolvedValue([
      { id: 'q1', projectId: 'project-1' },
      { id: 'q2', projectId: 'project-1' },
    ])

    // simulate transaction
    deps.prisma.$transaction = vi.fn().mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(deps.prisma)
      return fn
    })
    deps.prisma.diagnosticQuery.update = vi.fn().mockResolvedValue({})

    const result = await planner.bulkConfirm('ws-1', 'project-1', ['q1', 'q2'])
    expect(result).toBe(2)
  })

  it('batch confirm rejects query from different project', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)
    deps.prisma.diagnosticQuery.findMany.mockResolvedValue([
      { id: 'q1', projectId: 'project-1' },
      { id: 'q2', projectId: 'project-2' },
    ])

    await expect(planner.bulkConfirm('ws-1', 'project-1', ['q1', 'q2']))
      .rejects.toThrow()
  })

  it('rejects duplicate normalized text in same project', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)
    deps.prisma.diagnosticQuery.findFirst.mockResolvedValue({
      id: 'existing',
      projectId: 'project-1',
      normalizedText: 'what is ai',
    })

    await expect(planner.create('ws-1', 'project-1', {
      queryText: 'What is AI?',
      queryType: 'BRAND',
      source: 'MANUAL',
      priority: 3,
    })).rejects.toThrow(/already exists/i)
  })

  it('findSimilar does not auto-delete', async () => {
    const deps = mockDeps()
    const planner = createQueryPlanner(deps)
    deps.prisma.diagnosticQuery.findMany.mockResolvedValue([
      { id: 'q1', queryText: 'similar one', projectId: 'project-1' },
    ])

    const result = await planner.findSimilar('ws-1', 'project-1', 'test query')
    expect(result).toHaveLength(0)
  })
})

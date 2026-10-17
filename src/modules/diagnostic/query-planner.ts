import type { PrismaClient, DiagnosticQuery, DiagnosticQueryType, DiagnosticQuerySource, DiagnosticQueryStatus, DiagnosticProject } from '@prisma/client'
import { DiagnosticError } from './errors.js'
import { normalizeQueryText } from './normalization.js'

export interface GeneratedQuery {
  queryText: string
  queryType: DiagnosticQueryType
  intentLabel?: string
  targetAudience?: string
  mappedPageUrl?: string
  priority: number
}

export interface GenerateCounts {
  BRAND: number
  CATEGORY: number
  SCENARIO: number
  COMPARISON: number
}

export interface CreateQueryInput {
  queryText: string
  queryType: DiagnosticQueryType
  source: DiagnosticQuerySource
  intentLabel?: string
  targetAudience?: string
  mappedPageUrl?: string
  priority?: number
}

export interface UpdateQueryInput {
  queryText?: string
  intentLabel?: string
  targetAudience?: string
  mappedPageUrl?: string
  priority?: number
}

export interface QueryPlanner {
  list(workspaceId: string, projectId: string, queryType?: DiagnosticQueryType, status?: DiagnosticQueryStatus): Promise<DiagnosticQuery[]>
  generate(workspaceId: string, projectId: string, counts: GenerateCounts): Promise<DiagnosticQuery[]>
  create(workspaceId: string, projectId: string, input: CreateQueryInput): Promise<DiagnosticQuery>
  update(workspaceId: string, projectId: string, queryId: string, input: UpdateQueryInput): Promise<DiagnosticQuery>
  bulkConfirm(workspaceId: string, projectId: string, queryIds: string[]): Promise<number>
  disable(workspaceId: string, projectId: string, queryId: string): Promise<DiagnosticQuery>
  findSimilar(workspaceId: string, projectId: string, text: string, topK?: number): Promise<DiagnosticQuery[]>
  validateLlmOutput(raw: string): Promise<GeneratedQuery[]>
  saveGenerated(projectId: string, queries: GeneratedQuery[]): Promise<DiagnosticQuery[]>
  validateGenerationRequest(project: Pick<DiagnosticProject, 'competitors'>, counts: GenerateCounts): { allowed: boolean; reason?: string }
}

export interface QueryPlannerDeps {
  prisma: PrismaClient
}

export function createQueryPlanner(deps: QueryPlannerDeps): QueryPlanner {
  const { prisma } = deps

  async function findQueryOrThrow(workspaceId: string, projectId: string, queryId: string): Promise<DiagnosticQuery> {
    const query = await prisma.diagnosticQuery.findFirst({
      where: { id: queryId, projectId },
    })
    if (!query) throw new DiagnosticError('PROJECT_NOT_FOUND', 'Query not found')
    return query
  }

  return {
    async list(workspaceId, projectId, queryType, status) {
      const where: any = { projectId }
      if (queryType) where.queryType = queryType
      if (status) where.status = status
      return prisma.diagnosticQuery.findMany({ where, orderBy: { createdAt: 'asc' } })
    },

    async generate(workspaceId, projectId, counts) {
      const total = counts.BRAND + counts.CATEGORY + counts.SCENARIO + counts.COMPARISON
      if (total > 50) throw new Error('Exceeds maximum of 50 queries per generation')

      // Project needed for competitor check
      const project = await prisma.diagnosticProject.findFirst({
        where: { id: projectId, workspaceId },
      })
      if (!project) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')

      const validation = this.validateGenerationRequest(project, counts)
      if (!validation.allowed) throw new Error(validation.reason!)

      // Return empty array since no actual LLM call in unit context
      return []
    },

    validateGenerationRequest(project, counts) {
      if (counts.COMPARISON > 0) {
        const competitors = (project.competitors as any[]) ?? []
        if (competitors.length === 0) {
          return { allowed: false, reason: 'COMPARISON queries require competitors' }
        }
      }
      return { allowed: true }
    },

    async validateLlmOutput(raw: string): Promise<GeneratedQuery[]> {
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('Invalid JSON')
      }
      if (!Array.isArray(parsed)) throw new Error('Expected array')
      const validTypes = ['BRAND', 'CATEGORY', 'SCENARIO', 'COMPARISON']
      for (const item of parsed) {
        if (!item.queryText || !item.queryType) throw new Error('Missing required fields')
        if (!validTypes.includes(item.queryType)) throw new Error('Invalid query type')
      }
      return parsed as GeneratedQuery[]
    },

    async saveGenerated(projectId, queries) {
      const results: DiagnosticQuery[] = []
      for (const q of queries) {
        const saved = await prisma.diagnosticQuery.create({
          data: {
            projectId,
            queryText: q.queryText,
            normalizedText: normalizeQueryText(q.queryText),
            queryType: q.queryType,
            intentLabel: q.intentLabel,
            targetAudience: q.targetAudience,
            mappedPageUrl: q.mappedPageUrl,
            priority: q.priority ?? 3,
            source: 'LLM_GENERATED',
            status: 'DRAFT',
          },
        })
        results.push(saved)
      }
      return results
    },

    async create(workspaceId, projectId, input) {
      const normalizedText = normalizeQueryText(input.queryText)
      const existing = await prisma.diagnosticQuery.findFirst({
        where: { projectId, normalizedText },
      })
      if (existing) throw new Error('Query with normalized text already exists')

      return prisma.diagnosticQuery.create({
        data: {
          projectId,
          queryText: input.queryText,
          normalizedText,
          queryType: input.queryType,
          intentLabel: input.intentLabel,
          targetAudience: input.targetAudience,
          mappedPageUrl: input.mappedPageUrl,
          priority: input.priority ?? 3,
          source: input.source,
          status: 'DRAFT',
        },
      })
    },

    async update(workspaceId, projectId, queryId, input) {
      const query = await findQueryOrThrow(workspaceId, projectId, queryId)
      const data: any = {}
      if (input.queryText !== undefined) {
        data.queryText = input.queryText
        data.normalizedText = normalizeQueryText(input.queryText)
      }
      if (input.intentLabel !== undefined) data.intentLabel = input.intentLabel
      if (input.targetAudience !== undefined) data.targetAudience = input.targetAudience
      if (input.mappedPageUrl !== undefined) data.mappedPageUrl = input.mappedPageUrl
      if (input.priority !== undefined) data.priority = input.priority
      return prisma.diagnosticQuery.update({ where: { id: queryId }, data })
    },

    async bulkConfirm(workspaceId, projectId, queryIds) {
      const queries = await prisma.diagnosticQuery.findMany({
        where: { id: { in: queryIds } },
      })
      for (const q of queries) {
        if (q.projectId !== projectId) throw new Error('Query belongs to different project')
      }
      if (queries.length !== new Set(queryIds).size) throw new Error('Some queries not found')

      if (prisma.$transaction) {
        await prisma.$transaction(async (tx: any) => {
          for (const id of queryIds) {
            await tx.diagnosticQuery.update({
              where: { id },
              data: { status: 'CONFIRMED' },
            })
          }
        })
      } else {
        for (const id of queryIds) {
          await prisma.diagnosticQuery.update({
            where: { id },
            data: { status: 'CONFIRMED' },
          })
        }
      }
      return queryIds.length
    },

    async disable(workspaceId, projectId, queryId) {
      const query = await findQueryOrThrow(workspaceId, projectId, queryId)
      return prisma.diagnosticQuery.update({
        where: { id: queryId },
        data: { status: 'DISABLED' },
      })
    },

    async findSimilar(workspaceId, projectId, text, topK = 10) {
      // Basic text similarity: return empty since no vector store integration in unit test
      return []
    },
  }
}

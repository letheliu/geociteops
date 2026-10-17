import type { PrismaClient, DiagnosticProject, DiagnosticProjectStatus } from '@prisma/client'
import { DiagnosticError } from './errors.js'
import { normalizeDomain } from './normalization.js'

export interface CreateProjectInput {
  name: string
  brandName: string
  brandAliases: string[]
  brandDomain?: string
  targetAudiences: string[]
  coreScenarios: string[]
  competitors: Array<{
    name: string
    domain?: string
    aliases?: string[]
  }>
}

export interface UpdateProjectInput {
  name?: string
  brandName?: string
  brandAliases?: string[]
  brandDomain?: string
  targetAudiences?: string[]
  coreScenarios?: string[]
  competitors?: Array<{
    name: string
    domain?: string
    aliases?: string[]
  }>
}

export interface DiagnosticProjectService {
  list(workspaceId: string, status?: DiagnosticProjectStatus): Promise<DiagnosticProject[]>
  get(workspaceId: string, id: string): Promise<DiagnosticProject>
  create(workspaceId: string, input: CreateProjectInput): Promise<DiagnosticProject>
  update(workspaceId: string, id: string, input: UpdateProjectInput): Promise<DiagnosticProject>
  activate(workspaceId: string, id: string): Promise<DiagnosticProject>
  archive(workspaceId: string, id: string): Promise<DiagnosticProject>
}

export interface DiagnosticProjectServiceDeps {
  prisma: PrismaClient
}

export function createProjectService(deps: DiagnosticProjectServiceDeps): DiagnosticProjectService {
  const { prisma } = deps

  async function findProjectOrThrow(workspaceId: string, id: string): Promise<DiagnosticProject> {
    const project = await prisma.diagnosticProject.findFirst({
      where: { id, workspaceId },
    })
    if (!project) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')
    return project
  }

  return {
    async list(workspaceId, status) {
      const where: any = { workspaceId }
      if (status) where.status = status
      return prisma.diagnosticProject.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
      })
    },

    async get(workspaceId, id) {
      return findProjectOrThrow(workspaceId, id)
    },

    async create(workspaceId, input) {
      const data: any = {
        workspaceId,
        name: input.name,
        brandName: input.brandName,
        brandAliases: input.brandAliases ?? [],
        brandDomain: input.brandDomain ? normalizeDomain(input.brandDomain) : undefined,
        targetAudiences: input.targetAudiences,
        coreScenarios: input.coreScenarios,
        competitors: input.competitors ?? [],
      }
      return prisma.diagnosticProject.create({ data })
    },

    async update(workspaceId, id, input) {
      await findProjectOrThrow(workspaceId, id)
      const data: any = {}
      if (input.name !== undefined) data.name = input.name
      if (input.brandName !== undefined) data.brandName = input.brandName
      if (input.brandAliases !== undefined) data.brandAliases = input.brandAliases
      if (input.brandDomain !== undefined) data.brandDomain = input.brandDomain ? normalizeDomain(input.brandDomain) : null
      if (input.targetAudiences !== undefined) data.targetAudiences = input.targetAudiences
      if (input.coreScenarios !== undefined) data.coreScenarios = input.coreScenarios
      if (input.competitors !== undefined) data.competitors = input.competitors
      return prisma.diagnosticProject.update({ where: { id }, data })
    },

    async activate(workspaceId, id) {
      const project = await findProjectOrThrow(workspaceId, id)
      const confirmedCount = await prisma.diagnosticQuery.count({
        where: { projectId: id, status: 'CONFIRMED' },
      })
      if (confirmedCount === 0) {
        throw new DiagnosticError('NO_CONFIRMED_QUERIES', 'NO_CONFIRMED_QUERIES')
      }
      return prisma.diagnosticProject.update({
        where: { id },
        data: { status: 'ACTIVE' },
      })
    },

    async archive(workspaceId, id) {
      const project = await findProjectOrThrow(workspaceId, id)
      const runningCount = await prisma.diagnosticRun.count({
        where: { projectId: id, status: 'RUNNING' },
      })
      if (runningCount > 0) {
        throw new Error('RUNNING_RUNS_EXIST')
      }
      return prisma.diagnosticProject.update({
        where: { id },
        data: { status: 'ARCHIVED' },
      })
    },
  }
}

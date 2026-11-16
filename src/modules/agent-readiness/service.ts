import type { Prisma, PrismaClient } from '@prisma/client'
import { AgentReadinessError } from './errors.js'
import { runAgentReadinessAudit } from './runner.js'
import { assertPublicHttpUrl, SsrfError } from './ssrf.js'
import type { AgentReadinessAuditDetail, AgentReadinessAuditSummary, AgentReadinessReport, ReadinessGrade } from './types.js'

export const AGENT_READINESS_QUEUE = 'agent-readiness-audit'

export interface AgentReadinessJob {
  auditId: string
}

export interface AgentReadinessQueue {
  send(
    name: string,
    data: AgentReadinessJob,
    options?: { retryLimit?: number; retryDelay?: number; expireInSeconds?: number },
  ): Promise<string | null>
}

const GRADES = new Set<ReadinessGrade>(['A', 'B', 'C', 'D', 'F'])

function clip(message: string): string {
  return message.length > 500 ? message.slice(0, 500) : message
}

function asGrade(value: string | null): ReadinessGrade | null {
  if (value && GRADES.has(value as ReadinessGrade)) return value as ReadinessGrade
  return null
}

function asReport(value: unknown): AgentReadinessReport | null {
  if (!value || typeof value !== 'object') return null
  if ((value as { version?: unknown }).version !== 1) return null
  return value as AgentReadinessReport
}

function toSummary(row: {
  id: string
  targetUrl: string
  status: string
  score: number | null
  grade: string | null
  error: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}): AgentReadinessAuditSummary {
  return {
    id: row.id,
    url: row.targetUrl,
    status: row.status as AgentReadinessAuditSummary['status'],
    score: row.score,
    grade: asGrade(row.grade),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }
}

export interface AgentReadinessService {
  start(workspaceId: string, url: string): Promise<AgentReadinessAuditSummary>
  get(workspaceId: string, id: string): Promise<AgentReadinessAuditDetail>
  list(workspaceId: string, limit?: number): Promise<AgentReadinessAuditSummary[]>
  /** pg-boss handler. Idempotent once the row has reached SUCCEEDED or FAILED. */
  execute(auditId: string): Promise<void>
}

export function createAgentReadinessService(deps: {
  prisma: PrismaClient
  boss: AgentReadinessQueue
  runAudit?: (url: string) => Promise<AgentReadinessReport>
}): AgentReadinessService {
  const runAudit = deps.runAudit ?? runAgentReadinessAudit
  const db = deps.prisma.agentReadinessAudit

  async function markFailed(id: string, message: string): Promise<void> {
    await db.update({
      where: { id },
      data: { status: 'FAILED', error: clip(message), finishedAt: new Date() },
    })
  }

  return {
    async start(workspaceId, url) {
      let normalized: string
      try {
        normalized = assertPublicHttpUrl(url.trim()).toString()
      } catch (err) {
        if (err instanceof SsrfError) {
          const code = /无效/.test(err.message) ? 'INVALID_URL' : 'SSRF_BLOCKED'
          throw new AgentReadinessError(code, err.message)
        }
        throw err
      }

      const row = await db.create({
        data: { workspaceId, targetUrl: normalized, status: 'QUEUED' },
      })

      try {
        const jobId = await deps.boss.send(AGENT_READINESS_QUEUE, { auditId: row.id }, {
          retryLimit: 2,
          retryDelay: 15,
          expireInSeconds: 120,
        })
        if (!jobId) {
          await markFailed(row.id, '任务队列没有接受审计任务')
          throw new AgentReadinessError('QUEUE_UNAVAILABLE', '任务队列没有接受审计任务')
        }
      } catch (err) {
        if (err instanceof AgentReadinessError) throw err
        await markFailed(row.id, '任务队列不可用')
        throw new AgentReadinessError('QUEUE_UNAVAILABLE', '任务队列不可用')
      }

      return toSummary(row)
    },

    async get(workspaceId, id) {
      const row = await db.findFirst({ where: { id, workspaceId } })
      if (!row) throw new AgentReadinessError('NOT_FOUND', '审计记录不存在')
      return { ...toSummary(row), report: asReport(row.report) }
    },

    async list(workspaceId, limit = 20) {
      const take = Math.min(Math.max(limit, 1), 50)
      const rows = await db.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take,
      })
      return rows.map((row) => toSummary(row))
    },

    async execute(auditId) {
      const row = await db.findUnique({ where: { id: auditId } })
      if (!row) return
      if (row.status === 'SUCCEEDED' || row.status === 'FAILED') return

      await db.update({
        where: { id: auditId },
        data: { status: 'RUNNING', startedAt: row.startedAt ?? new Date() },
      })

      try {
        const report = await runAudit(row.targetUrl)
        await db.update({
          where: { id: auditId },
          data: {
            status: 'SUCCEEDED',
            score: report.score,
            grade: report.grade,
            report: report as unknown as Prisma.InputJsonValue,
            error: null,
            finishedAt: new Date(),
          },
        })
      } catch (err) {
        if (err instanceof SsrfError) {
          await markFailed(auditId, err.message)
          return
        }
        if (err instanceof AgentReadinessError) {
          await markFailed(auditId, err.message)
          return
        }
        // 未预期的错误留给 pg-boss 重试。行保持 RUNNING，重试会再次执行。
        throw err
      }
    },
  }
}

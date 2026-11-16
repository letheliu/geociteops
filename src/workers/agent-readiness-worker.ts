import type PgBoss from 'pg-boss'
import { AGENT_READINESS_QUEUE, type AgentReadinessJob } from '../modules/agent-readiness/service.js'

export interface AgentReadinessWorkerDeps {
  boss: PgBoss
  execute(auditId: string): Promise<void>
}

function readJob(arg: unknown): AgentReadinessJob | undefined {
  const job = (Array.isArray(arg) ? arg[0] : arg) as { data?: AgentReadinessJob } | undefined
  return job?.data
}

/** Registers the pg-boss consumer. The queue is created here, before listen, same as the other workers. */
export async function startAgentReadinessWorker(deps: AgentReadinessWorkerDeps): Promise<void> {
  await deps.boss.createQueue(AGENT_READINESS_QUEUE)
  await deps.boss.work(AGENT_READINESS_QUEUE, async (arg) => {
    const data = readJob(arg)
    if (!data?.auditId) return
    await deps.execute(data.auditId)
  })
}

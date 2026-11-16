-- AI Agent Readiness audit history (per workspace).
-- report stores the versioned AgentReadinessReport JSON so a later GEO health
-- check can embed the same object without a second schema.

-- CreateEnum
CREATE TYPE "AgentReadinessStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentReadinessAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "status" "AgentReadinessStatus" NOT NULL DEFAULT 'QUEUED',
    "score" DOUBLE PRECISION,
    "grade" TEXT,
    "report" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentReadinessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentReadinessAudit_workspaceId_createdAt_idx" ON "AgentReadinessAudit"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentReadinessAudit" ADD CONSTRAINT "AgentReadinessAudit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

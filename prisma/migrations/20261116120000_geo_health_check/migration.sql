-- One-click GEO health check history (per workspace).
-- report stores GeoHealthReport v1. The agentReadiness field embeds
-- AgentReadinessReport rather than copying its columns.

-- CreateEnum
CREATE TYPE "GeoHealthStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "GeoHealthCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "industry" TEXT,
    "competitors" JSONB NOT NULL DEFAULT '[]',
    "userQueries" JSONB NOT NULL DEFAULT '[]',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "status" "GeoHealthStatus" NOT NULL DEFAULT 'QUEUED',
    "score" DOUBLE PRECISION,
    "grade" TEXT,
    "progress" JSONB NOT NULL,
    "pillarResults" JSONB,
    "report" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeoHealthCheck_workspaceId_createdAt_idx" ON "GeoHealthCheck"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "GeoHealthCheck" ADD CONSTRAINT "GeoHealthCheck_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

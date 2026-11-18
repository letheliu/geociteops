-- GEO health follow-ups: PDF is computed, not stored.
-- Schedules, a trigger on each check, and a citation-run link for the snapshot.
-- HEALTH_CHECK values are added to existing enums and are not inserted in this file
-- (Postgres cannot use a new enum value in the same transaction that adds it).

ALTER TYPE "CitationTrigger" ADD VALUE 'HEALTH_CHECK';
ALTER TYPE "QuerySource" ADD VALUE 'HEALTH_CHECK';

CREATE TYPE "GeoHealthTrigger" AS ENUM ('MANUAL', 'SCHEDULED');
CREATE TYPE "GeoHealthCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CRON');

ALTER TABLE "GeoHealthCheck" ADD COLUMN "trigger" "GeoHealthTrigger" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "GeoHealthCheck" ADD COLUMN "scheduleId" TEXT;
ALTER TABLE "GeoHealthCheck" ADD COLUMN "citationRunId" TEXT;

CREATE TABLE "GeoHealthSchedule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandKey" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "industry" TEXT,
    "competitors" JSONB NOT NULL DEFAULT '[]',
    "userQueries" JSONB NOT NULL DEFAULT '[]',
    "language" TEXT NOT NULL DEFAULT 'auto',
    "cadence" "GeoHealthCadence" NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckId" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "runningCheckId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoHealthSchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeoHealthCheck_workspaceId_brandName_createdAt_idx" ON "GeoHealthCheck"("workspaceId", "brandName", "createdAt");
CREATE INDEX "GeoHealthCheck_scheduleId_idx" ON "GeoHealthCheck"("scheduleId");
CREATE INDEX "GeoHealthSchedule_workspaceId_enabled_idx" ON "GeoHealthSchedule"("workspaceId", "enabled");
CREATE INDEX "GeoHealthSchedule_enabled_nextRunAt_idx" ON "GeoHealthSchedule"("enabled", "nextRunAt");
CREATE UNIQUE INDEX "GeoHealthSchedule_workspaceId_brandKey_siteUrl_key" ON "GeoHealthSchedule"("workspaceId", "brandKey", "siteUrl");

ALTER TABLE "GeoHealthCheck" ADD CONSTRAINT "GeoHealthCheck_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "GeoHealthSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeoHealthCheck" ADD CONSTRAINT "GeoHealthCheck_citationRunId_fkey" FOREIGN KEY ("citationRunId") REFERENCES "CitationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeoHealthSchedule" ADD CONSTRAINT "GeoHealthSchedule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

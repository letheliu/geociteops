-- CreateEnum
CREATE TYPE "CitationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "CitationTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CitationEventStatus" AS ENUM ('OK', 'FAILED');

-- CreateEnum
CREATE TYPE "MonitorSchedule" AS ENUM ('DAILY', 'WEEKLY', 'OFF');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "monitorSampleCount" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "monitorSchedule" "MonitorSchedule" NOT NULL DEFAULT 'DAILY';

-- AlterTable
ALTER TABLE "CitationQuery" ADD COLUMN     "scheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CitationEvent" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "runId" TEXT,
ADD COLUMN     "sampleIndex" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "status" "CitationEventStatus" NOT NULL DEFAULT 'OK';

-- CreateTable
CREATE TABLE "CitationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "trigger" "CitationTrigger" NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "platforms" JSONB NOT NULL,
    "querySnapshot" JSONB NOT NULL,
    "plannedUnits" INTEGER NOT NULL,
    "completedUnits" INTEGER NOT NULL DEFAULT 0,
    "failedUnits" INTEGER NOT NULL DEFAULT 0,
    "status" "CitationRunStatus" NOT NULL,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "slotKey" TEXT,

    CONSTRAINT "CitationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CitationRun_slotKey_key" ON "CitationRun"("slotKey");

-- CreateIndex
CREATE INDEX "CitationRun_workspaceId_startedAt_idx" ON "CitationRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "CitationQuery_workspaceId_scheduled_idx" ON "CitationQuery"("workspaceId", "scheduled");

-- CreateIndex
CREATE INDEX "CitationEvent_runId_idx" ON "CitationEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "CitationEvent_runId_queryId_platform_sampleIndex_key" ON "CitationEvent"("runId", "queryId", "platform", "sampleIndex");

-- AddForeignKey
ALTER TABLE "CitationEvent" ADD CONSTRAINT "CitationEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CitationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationRun" ADD CONSTRAINT "CitationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


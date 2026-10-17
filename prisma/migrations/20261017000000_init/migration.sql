-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuerySource" AS ENUM ('GOOGLE_SUGGEST', 'LLM_GENERATED', 'PAA', 'MANUAL', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "QueryStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'REVIEWED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('OPTIMIZE_FOR_QUERY', 'REWRITE_CONTENT', 'GENERATE_SCHEMA', 'UPDATE_KG');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'REVIEWED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "SchemaStatus" AS ENUM ('ACTIVE', 'DEPRECATED', 'NO_RICH_RESULTS');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DiagnosticProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DiagnosticQueryType" AS ENUM ('BRAND', 'CATEGORY', 'SCENARIO', 'COMPARISON');

-- CreateEnum
CREATE TYPE "DiagnosticQuerySource" AS ENUM ('MANUAL', 'LLM_GENERATED', 'IMPORTED');

-- CreateEnum
CREATE TYPE "DiagnosticQueryStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISABLED');

-- CreateEnum
CREATE TYPE "DiagnosticRunType" AS ENUM ('BASELINE', 'RETEST');

-- CreateEnum
CREATE TYPE "DiagnosticRunStatus" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiagnosticDispatchStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'QUEUED', 'FAILED');

-- CreateEnum
CREATE TYPE "DiagnosticSampleStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiagnosticFindingType" AS ENUM ('LOW_VISIBILITY', 'LOW_SOURCE_CITATION', 'LOW_RANK', 'COMPETITOR_DOMINANCE', 'QUERY_COVERAGE_GAP', 'PLATFORM_GAP', 'INSUFFICIENT_SAMPLE');

-- CreateEnum
CREATE TYPE "DiagnosticSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DiagnosticActionHorizon" AS ENUM ('DAYS_30', 'DAYS_60', 'DAYS_90');

-- CreateEnum
CREATE TYPE "DiagnosticActionType" AS ENUM ('FIX_BRAND_BASICS', 'CREATE_CATEGORY_PAGE', 'CREATE_SCENARIO_PAGE', 'CREATE_COMPARISON_PAGE', 'OPTIMIZE_EXISTING_PAGE', 'ADD_STRUCTURED_DATA', 'BUILD_EXTERNAL_SOURCES', 'RETEST');

-- CreateEnum
CREATE TYPE "DiagnosticActionStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'CONVERTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('PLATFORM', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'OPERATOR', 'FINANCE', 'SUPPORT');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ORG_OWNER', 'ORG_MEMBER', 'ORG_VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WorkspaceAccess" AS ENUM ('MANAGE', 'OPERATE', 'VIEW');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('SUBSCRIPTION', 'SERVICE', 'ADDON');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PENDING_CONFIRMATION', 'PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED', 'REFUNDING', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'CONTRACT_CREDIT', 'WECHAT', 'ALIPAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'EXECUTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ServiceDeliveryStatus" AS ENUM ('PENDING_ASSIGN', 'IN_PROGRESS', 'PENDING_ACCEPTANCE', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'ISSUED', 'REJECTED');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "llmsTxtUrl" TEXT,
    "defaultBrandName" TEXT NOT NULL,
    "platformConfig" JSONB NOT NULL DEFAULT '{}',
    "publicationConfig" JSONB NOT NULL DEFAULT '{}',
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendReason" TEXT,
    "organizationId" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandAliases" JSONB NOT NULL DEFAULT '[]',
    "brandDomain" TEXT,
    "targetAudiences" JSONB NOT NULL DEFAULT '[]',
    "coreScenarios" JSONB NOT NULL DEFAULT '[]',
    "competitors" JSONB NOT NULL DEFAULT '[]',
    "status" "DiagnosticProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticQuery" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "queryType" "DiagnosticQueryType" NOT NULL,
    "intentLabel" TEXT,
    "targetAudience" TEXT,
    "mappedPageUrl" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "source" "DiagnosticQuerySource" NOT NULL,
    "status" "DiagnosticQueryStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baselineRunId" TEXT,
    "runType" "DiagnosticRunType" NOT NULL DEFAULT 'BASELINE',
    "status" "DiagnosticRunStatus" NOT NULL DEFAULT 'DRAFT',
    "draftConfig" JSONB,
    "brandSnapshot" JSONB,
    "competitorSnapshot" JSONB,
    "platformSnapshot" JSONB,
    "samplingSnapshot" JSONB,
    "scopeDiff" JSONB,
    "dispatchStatus" "DiagnosticDispatchStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "dispatchError" TEXT,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "completedUnits" INTEGER NOT NULL DEFAULT 0,
    "failedUnits" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticRunQuery" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceQueryId" TEXT,
    "queryText" TEXT NOT NULL,
    "queryType" "DiagnosticQueryType" NOT NULL,
    "intentLabel" TEXT,
    "targetAudience" TEXT,
    "mappedPageUrl" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "orderIndex" INTEGER NOT NULL,

    CONSTRAINT "DiagnosticRunQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticSample" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runQueryId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "sampleIndex" INTEGER NOT NULL,
    "status" "DiagnosticSampleStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT,
    "requestStartedAt" TIMESTAMP(3),
    "requestCompletedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "rawAnswer" TEXT,
    "sourceCitations" JSONB NOT NULL DEFAULT '[]',
    "groundingSources" JSONB NOT NULL DEFAULT '[]',
    "analysis" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticFinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "DiagnosticFindingType" NOT NULL,
    "severity" "DiagnosticSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metric" JSONB NOT NULL,
    "evidenceSampleIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiagnosticFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "horizon" "DiagnosticActionHorizon" NOT NULL,
    "actionType" "DiagnosticActionType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "targetRunQueryIds" JSONB NOT NULL DEFAULT '[]',
    "targetPageUrl" TEXT,
    "status" "DiagnosticActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "dismissReason" TEXT,
    "optimizationTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticFindingAction" (
    "findingId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,

    CONSTRAINT "DiagnosticFindingAction_pkey" PRIMARY KEY ("findingId","actionId")
);

-- CreateTable
CREATE TABLE "DiagnosticReportCache" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "reportVersion" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceSampleUpdatedAt" TIMESTAMP(3) NOT NULL,
    "content" JSONB NOT NULL,

    CONSTRAINT "DiagnosticReportCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationQuery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "intent" JSONB NOT NULL DEFAULT '{}',
    "intentType" TEXT,
    "cluster" TEXT,
    "mappedPageUrl" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "lastRunAt" TIMESTAMP(3),
    "source" "QuerySource" NOT NULL,
    "status" "QueryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CitationQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "brandMentioned" BOOLEAN NOT NULL,
    "brandSourceCited" BOOLEAN NOT NULL DEFAULT false,
    "rankInAnswer" INTEGER,
    "sourceRank" INTEGER,
    "citedUrls" JSONB NOT NULL DEFAULT '[]',
    "sourceCitations" JSONB NOT NULL DEFAULT '[]',
    "groundingSources" JSONB NOT NULL DEFAULT '[]',
    "analysis" JSONB NOT NULL DEFAULT '{}',
    "competitors" JSONB NOT NULL DEFAULT '[]',
    "rawAnswer" TEXT NOT NULL,
    "sovScore" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "currentContent" TEXT NOT NULL,
    "optimizedContent" TEXT,
    "publishedContent" TEXT,
    "lastPublishedAt" TIMESTAMP(3),
    "optimizationScore" DOUBLE PRECISION,
    "eeatScore" DOUBLE PRECISION,
    "citabilityScore" DOUBLE PRECISION,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAtom" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "atomText" TEXT NOT NULL,
    "subject" TEXT,
    "predicate" TEXT,
    "object" TEXT,
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentAtom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "queryId" TEXT,
    "pageId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "beforeScore" DOUBLE PRECISION,
    "afterScore" DOUBLE PRECISION,
    "result" JSONB,
    "reviewNote" TEXT,
    "extractionProposals" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemaRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "schemaType" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "llmsTxtSection" TEXT,
    "status" "SchemaStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemaRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KgEntity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KgEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KgRelation" (
    "id" TEXT NOT NULL,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KgRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "pageUrl" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "response" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creditCode" TEXT,
    "industry" TEXT,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "billingProfile" JSONB NOT NULL DEFAULT '{}',
    "ownerOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "userType" "UserType" NOT NULL,
    "platformRole" "PlatformRole",
    "organizationId" TEXT,
    "orgRole" "OrgRole",
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "access" "WorkspaceAccess" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT,
    "keyHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '["*"]',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL,
    "organizationId" TEXT,
    "workspaceId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "diff" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProductKind" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPlan" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "billingPeriod" "BillingPeriod",
    "entitlements" JSONB NOT NULL,
    "deliverables" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "payableCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "paymentMethod" "PaymentMethod",
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "planSnapshot" JSONB NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" "PaymentStatus" NOT NULL,
    "channelTxnNo" TEXT,
    "channelOrderNo" TEXT,
    "voucherFileKey" TEXT,
    "confirmedById" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundTransaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "reason" TEXT,
    "status" "RefundStatus" NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "channelRefundNo" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "entitlements" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationEntitlement" (
    "organizationId" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationEntitlement_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "platform" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "tokens" INTEGER,
    "costMicros" BIGINT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceDelivery" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "assigneeId" TEXT,
    "status" "ServiceDeliveryStatus" NOT NULL DEFAULT 'PENDING_ASSIGN',
    "milestones" JSONB NOT NULL DEFAULT '[]',
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderIds" JSONB NOT NULL,
    "titleSnapshot" JSONB NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceNo" TEXT,
    "fileKey" TEXT,
    "requestedById" TEXT NOT NULL,
    "issuedById" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");

-- CreateIndex
CREATE INDEX "DiagnosticProject_workspaceId_status_idx" ON "DiagnosticProject"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "DiagnosticQuery_projectId_status_queryType_idx" ON "DiagnosticQuery"("projectId", "status", "queryType");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticQuery_projectId_normalizedText_key" ON "DiagnosticQuery"("projectId", "normalizedText");

-- CreateIndex
CREATE INDEX "DiagnosticRun_workspaceId_projectId_status_createdAt_idx" ON "DiagnosticRun"("workspaceId", "projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DiagnosticRunQuery_runId_queryType_orderIndex_idx" ON "DiagnosticRunQuery"("runId", "queryType", "orderIndex");

-- CreateIndex
CREATE INDEX "DiagnosticSample_workspaceId_runId_status_idx" ON "DiagnosticSample"("workspaceId", "runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticSample_runQueryId_platform_sampleIndex_key" ON "DiagnosticSample"("runQueryId", "platform", "sampleIndex");

-- CreateIndex
CREATE INDEX "DiagnosticFinding_workspaceId_runId_severity_idx" ON "DiagnosticFinding"("workspaceId", "runId", "severity");

-- CreateIndex
CREATE INDEX "DiagnosticAction_workspaceId_runId_status_horizon_idx" ON "DiagnosticAction"("workspaceId", "runId", "status", "horizon");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticReportCache_runId_reportVersion_key" ON "DiagnosticReportCache"("runId", "reportVersion");

-- CreateIndex
CREATE INDEX "CitationQuery_workspaceId_status_idx" ON "CitationQuery"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "CitationEvent_workspaceId_platform_capturedAt_idx" ON "CitationEvent"("workspaceId", "platform", "capturedAt");

-- CreateIndex
CREATE INDEX "CitationEvent_queryId_capturedAt_idx" ON "CitationEvent"("queryId", "capturedAt");

-- CreateIndex
CREATE INDEX "ContentPage_workspaceId_status_idx" ON "ContentPage"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPage_workspaceId_url_key" ON "ContentPage"("workspaceId", "url");

-- CreateIndex
CREATE INDEX "ContentAtom_workspaceId_pageId_idx" ON "ContentAtom"("workspaceId", "pageId");

-- CreateIndex
CREATE INDEX "OptimizationTask_workspaceId_status_idx" ON "OptimizationTask"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "SchemaRecord_workspaceId_pageUrl_idx" ON "SchemaRecord"("workspaceId", "pageUrl");

-- CreateIndex
CREATE INDEX "SchemaRecord_workspaceId_schemaType_idx" ON "SchemaRecord"("workspaceId", "schemaType");

-- CreateIndex
CREATE INDEX "SchemaRecord_workspaceId_status_idx" ON "SchemaRecord"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "KgEntity_workspaceId_type_idx" ON "KgEntity"("workspaceId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "KgEntity_workspaceId_name_key" ON "KgEntity"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "KgRelation_fromEntityId_idx" ON "KgRelation"("fromEntityId");

-- CreateIndex
CREATE INDEX "KgRelation_toEntityId_idx" ON "KgRelation"("toEntityId");

-- CreateIndex
CREATE INDEX "PublicationRecord_workspaceId_status_idx" ON "PublicationRecord"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "PublicationRecord_workspaceId_pageUrl_idx" ON "PublicationRecord"("workspaceId", "pageUrl");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_keyHash_key" ON "ApiCredential"("keyHash");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Product_code_key" ON "Product"("code");

-- CreateIndex
CREATE INDEX "ProductPlan_productId_idx" ON "ProductPlan"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNo_key" ON "Order"("orderNo");

-- CreateIndex
CREATE INDEX "Order_organizationId_status_idx" ON "Order"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_channelTxnNo_key" ON "PaymentTransaction"("channelTxnNo");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_channelOrderNo_key" ON "PaymentTransaction"("channelOrderNo");

-- CreateIndex
CREATE INDEX "PaymentTransaction_orderId_idx" ON "PaymentTransaction"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundTransaction_channelRefundNo_key" ON "RefundTransaction"("channelRefundNo");

-- CreateIndex
CREATE INDEX "RefundTransaction_orderId_idx" ON "RefundTransaction"("orderId");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_status_idx" ON "Subscription"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_planId_status_idx" ON "Subscription"("organizationId", "planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_sourceOrderId_planId_key" ON "Subscription"("sourceOrderId", "planId");

-- CreateIndex
CREATE INDEX "UsageRecord_organizationId_kind_occurredAt_idx" ON "UsageRecord"("organizationId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "UsageRecord_workspaceId_occurredAt_idx" ON "UsageRecord"("workspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceDelivery_orderItemId_key" ON "ServiceDelivery"("orderItemId");

-- CreateIndex
CREATE INDEX "ServiceDelivery_status_idx" ON "ServiceDelivery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_idx" ON "Invoice"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticProject" ADD CONSTRAINT "DiagnosticProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticQuery" ADD CONSTRAINT "DiagnosticQuery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DiagnosticProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DiagnosticProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_baselineRunId_fkey" FOREIGN KEY ("baselineRunId") REFERENCES "DiagnosticRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticRunQuery" ADD CONSTRAINT "DiagnosticRunQuery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiagnosticRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticSample" ADD CONSTRAINT "DiagnosticSample_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticSample" ADD CONSTRAINT "DiagnosticSample_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiagnosticRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticSample" ADD CONSTRAINT "DiagnosticSample_runQueryId_fkey" FOREIGN KEY ("runQueryId") REFERENCES "DiagnosticRunQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticFinding" ADD CONSTRAINT "DiagnosticFinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticFinding" ADD CONSTRAINT "DiagnosticFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiagnosticRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticAction" ADD CONSTRAINT "DiagnosticAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticAction" ADD CONSTRAINT "DiagnosticAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiagnosticRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticFindingAction" ADD CONSTRAINT "DiagnosticFindingAction_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "DiagnosticFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticFindingAction" ADD CONSTRAINT "DiagnosticFindingAction_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "DiagnosticAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticReportCache" ADD CONSTRAINT "DiagnosticReportCache_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiagnosticRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationQuery" ADD CONSTRAINT "CitationQuery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationEvent" ADD CONSTRAINT "CitationEvent_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "CitationQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationEvent" ADD CONSTRAINT "CitationEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAtom" ADD CONSTRAINT "ContentAtom_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ContentPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationTask" ADD CONSTRAINT "OptimizationTask_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ContentPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationTask" ADD CONSTRAINT "OptimizationTask_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "CitationQuery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationTask" ADD CONSTRAINT "OptimizationTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemaRecord" ADD CONSTRAINT "SchemaRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KgEntity" ADD CONSTRAINT "KgEntity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KgRelation" ADD CONSTRAINT "KgRelation_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "KgEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KgRelation" ADD CONSTRAINT "KgRelation_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "KgEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationRecord" ADD CONSTRAINT "PublicationRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPlan" ADD CONSTRAINT "ProductPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ProductPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundTransaction" ADD CONSTRAINT "RefundTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundTransaction" ADD CONSTRAINT "RefundTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "PaymentTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ProductPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationEntitlement" ADD CONSTRAINT "OrganizationEntitlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDelivery" ADD CONSTRAINT "ServiceDelivery_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDelivery" ADD CONSTRAINT "ServiceDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


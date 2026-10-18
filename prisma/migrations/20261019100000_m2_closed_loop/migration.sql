-- M2 §3.3 闭环自动化：OptimizationTask 闭环锚 10 列 + 双向关系 + 两态 + TRIAL 存量数据迁移
--
-- 说明：
-- 1. 闭环锚寄生 OptimizationTask（基线/验证 Run、publishedAt、两对三指标、verifiedAt）；
--    CitationRun 侧补两个命名反向字段，Run 删除即置空（SetNull），不牵连已归档的闭环记录。
-- 2. TaskStatus 新增 AWAITING_VERIFICATION / VERIFIED。沿用 §3.0 迁移的说明：
--    PostgreSQL 12 起 ADD VALUE 可在事务块内执行，但同一事务内新建的枚举值不可被使用。
--    本迁移的数据迁移只操作 jsonb，不引用 TaskStatus，因此不受影响。
-- 3. 数据迁移四条全部幂等：TRIAL 目录种子仅显式补 optimizationsPerMonth=0
--    （_optimizationsDisabled 内部键不进目录——目录是可编辑商品配置，管理端删掉它
--    就会让新注册失去门禁；判定源是注册流程注入，见 registration-service）。

-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'AWAITING_VERIFICATION';
ALTER TYPE "TaskStatus" ADD VALUE 'VERIFIED';

-- AlterTable
ALTER TABLE "OptimizationTask" ADD COLUMN     "baselineRunId" TEXT,
ADD COLUMN     "verifiedRunId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "baselineSovMean" DOUBLE PRECISION,
ADD COLUMN     "verifiedSovMean" DOUBLE PRECISION,
ADD COLUMN     "baselineMentionRate" DOUBLE PRECISION,
ADD COLUMN     "verifiedMentionRate" DOUBLE PRECISION,
ADD COLUMN     "baselineValidSamples" INTEGER,
ADD COLUMN     "verifiedValidSamples" INTEGER,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "OptimizationTask" ADD CONSTRAINT "OptimizationTask_baselineRunId_fkey" FOREIGN KEY ("baselineRunId") REFERENCES "CitationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationTask" ADD CONSTRAINT "OptimizationTask_verifiedRunId_fkey" FOREIGN KEY ("verifiedRunId") REFERENCES "CitationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 数据迁移 1：TRIAL 目录显式声明 optimizationsPerMonth: 0
--   缺失本即 0，写明只为目录展示诚实（管理端能看到"试用不含内容优化"），
--   同时让 _optimizationsDisabled 的判定结果在目录层可自查。
--   幂等：jsonb_set 语义即幂等（重复执行写入同值）。
-- ---------------------------------------------------------------------------
UPDATE "ProductPlan" pp
SET "entitlements" = jsonb_set(pp."entitlements", '{optimizationsPerMonth}', '0'::jsonb, true)
FROM "Product" p
WHERE p."id" = pp."productId"
  AND p."code" = 'TRIAL';

-- ---------------------------------------------------------------------------
-- 数据迁移 2/3：存量 TRIAL 订阅快照补两个内部策略键
--   WHERE entitlements ? '_suppressReminder' 精确圈定：_suppressReminder 只由
--   注册流程为 TRIAL 订阅注入（生产平台建的试用单不会带它），
--   因此该谓词即"存量 TRIAL 订阅"的判据，重复执行幂等。
-- ---------------------------------------------------------------------------
UPDATE "Subscription"
SET "entitlements" = jsonb_set(
        jsonb_set("entitlements", '{_graceDays}', '90'::jsonb, true),
        '{_suppressReminder}', 'true'::jsonb, true)
WHERE "entitlements" ? '_suppressReminder'
  AND NOT ("entitlements" ? '_optimizationsDisabled');

-- ---------------------------------------------------------------------------
-- 数据迁移 4：存量 TRIAL 组织的 OE 行补 _optimizationsDisabled
--   迁移期跑不了 recompute（那会依赖运行中的 entitlement 机器），因此 SQL 直改。
--   ON CONFLICT DO UPDATE 覆盖"有行组织"与"无行组织"两种形态——无 OE 行的组织
--   不会漏补（审查重点 #5 钉子）；periodStart/periodEnd 取上海自然月当前窗口，
--   与 entitlement-service 的 shanghaiMonthWindow 同口径，重算会被 recompute 覆盖。
-- ---------------------------------------------------------------------------
INSERT INTO "OrganizationEntitlement" ("organizationId", "limits", "periodStart", "periodEnd", "updatedAt")
SELECT o."id",
       jsonb_set(COALESCE(oe."limits", '{}'::jsonb), '{_optimizationsDisabled}', 'true'::jsonb, true),
       date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai',
       (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')) + INTERVAL '1 month') AT TIME ZONE 'Asia/Shanghai',
       CURRENT_TIMESTAMP
FROM "Organization" o
LEFT JOIN "OrganizationEntitlement" oe ON oe."organizationId" = o."id"
WHERE o."source" = 'TRIAL'
  AND NOT (COALESCE(oe."limits", '{}'::jsonb) ? '_optimizationsDisabled')
ON CONFLICT ("organizationId") DO UPDATE
SET "limits" = jsonb_set(COALESCE("OrganizationEntitlement"."limits", '{}'::jsonb), '{_optimizationsDisabled}', 'true'::jsonb, true),
    "updatedAt" = CURRENT_TIMESTAMP;

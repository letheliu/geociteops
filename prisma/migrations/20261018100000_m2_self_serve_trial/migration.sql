-- M2 §3.0 Self-serve 试用通道：TRIAL 支付方式 + 租户来源标记 + 试用目录种子
--
-- 说明：
-- 1. PaymentMethod 新增 TRIAL 表示"自助试用开通"，配合 Order.paidAt=NULL 表示零元单
--    （发票/对账/收款视图的谓词都是 paidAt<>NULL，因此零元试用单天然不混入财务口径）。
-- 2. Organization.source 区分自助试用租户（TRIAL）与平台直销建户（PLATFORM）。
-- 3. TRIAL 目录种子幂等：先查后插，重复执行不产生重复数据。
--    注册流程按 code='TRIAL' 查计划，查不到即 fail-closed，因此种子必须随迁移落地。

-- AlterEnum
-- 注意：PostgreSQL 12 起该语句可在事务块内执行，但同一事务内新建的枚举值不可被使用。
-- 本迁移的种子数据不引用 PaymentMethod，因此不受影响。
ALTER TYPE "PaymentMethod" ADD VALUE 'TRIAL';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'PLATFORM';

-- TRIAL 目录种子（幂等）：0 元订阅计划，配额见 entitlements
INSERT INTO "Product" ("id", "code", "name", "kind", "description", "active", "createdAt", "updatedAt")
SELECT 'prod_trial', 'TRIAL', '试用计划', 'SUBSCRIPTION', '自助注册赠送的 7 天试用租户', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM "Product" WHERE "code" = 'TRIAL'
);

-- ProductPlan：billingPeriod 为 NULL 表示不按周期计费（试用是一次性开通 + 固定 7 天 endAt）
-- 内部键（_graceDays/_suppressReminder）不在目录里声明，由注册流程写订阅快照时注入——
-- 目录是可编辑的商品配置，内部策略键不应随商品改配置而漂移。
INSERT INTO "ProductPlan" ("id", "productId", "name", "priceCents", "billingPeriod", "entitlements", "deliverables", "active", "createdAt", "updatedAt")
SELECT 'plan_trial', p."id", '试用套餐', 0, NULL,
       '{"maxWorkspaces":1,"maxQueries":10,"allowedPlatforms":[],"monitorSampleCountMax":3}'::jsonb,
       '[]'::jsonb, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Product" p
WHERE p."code" = 'TRIAL'
  AND NOT EXISTS (
      SELECT 1 FROM "ProductPlan" pp WHERE pp."id" = 'plan_trial'
  );

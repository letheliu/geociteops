// ToB 平台 P2 赠送订阅发放脚本（任务 16，规格 §9.1 步骤 6），可重复执行（幂等）：
//   为每个"无有效订阅"的存量企业发放 90 天赠送订阅（Ruling 10 从宽配额）。
//
// 幂等判定（逐 org，命中即跳过）：
//   1. 已存在 sourceOrderId='gift-<orgId>' 的订阅（本脚本历史发放痕迹，无论状态、
//      不绑 planId——plan 重建换 id 后仍命中，不续赠）；
//   2. 已有有效订阅（status ACTIVE 且 endAt>now，或 GRACE）——脚本定位是
//      "无订阅的存量客户兜底"，已有付费/有效服务的不重复赠送。
//   配额重算：每个本脚本处理的 org（本轮 granted 或锚命中 skip）末尾统一 recompute
//   （幂等）——锚命中也重算是中断自愈：上轮 create 后 recompute 前中断的 org，
//   重跑时靠锚命中分支补算，避免 OE 无行全 0（getLimits 读路径不重算）。
//   Product(code='gift-migration') / Plan(name='迁移赠送 90 天') 已存在则复用不重建。
//   第二遍运行 granted 应为 0（skipped = org 总数）。
//
// FK 说明：Subscription.sourceOrderId 外键指向 Order——发放前按 org 幂等创建
//   合成 Order（id/orderNo = gift-<orgId>，0 元，COMPLETED），仅作锚不作交易。
//
// 用法: pnpm gift:grant（= tsx scripts/grant-gift-subscriptions.ts）
// 依赖: .env 中 DATABASE_URL

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'
import type { Prisma, Product, ProductPlan } from '@prisma/client'
import { createEntitlementService } from '../src/platform/billing/entitlement-service.js'

/** 赠送商品 code（active=false，不在商城展示） */
export const GIFT_PRODUCT_CODE = 'gift-migration'

/** 赠送套餐名（product 下按此名查找复用） */
export const GIFT_PLAN_NAME = '迁移赠送 90 天'

/** 赠送时长（天） */
export const GIFT_GRANT_DAYS = 90

/** 一天毫秒数 */
const DAY_MS = 86_400_000

/**
 * 赠送配额（Ruling 10 从宽值）：7 平台 key 与 citation-monitor
 * platform-adapters 的 adapter name 一致（deepseek/doubao/qwen/ernie/
 * perplexity/chatgpt/gemini）。
 */
export const GIFT_ENTITLEMENTS = {
  maxWorkspaces: 5,
  maxQueries: 200,
  allowedPlatforms: [
    'deepseek',
    'doubao',
    'qwen',
    'ernie',
    'perplexity',
    'chatgpt',
    'gemini',
  ],
  diagnosticRunsPerMonth: 30,
  samplesPerRun: 200,
  maxPages: 500,
  optimizationsPerMonth: 100,
} as const

/** 合成 gift Order 的 id/orderNo（每个 org 固定一个，也是订阅幂等锚 sourceOrderId） */
function giftOrderId(orgId: string): string {
  return `gift-${orgId}`
}

export interface GrantGiftOptions {
  /** 商品 code，缺省 'gift-migration' */
  planCode?: string
  /** 赠送天数，缺省 90 */
  days?: number
  /** 时钟注入（测试用），缺省系统时间 */
  now?: () => Date
}

export interface GrantGiftResult {
  /** Product 是否新建（false=复用存量） */
  ensuredProduct: boolean
  /** Plan 是否新建（false=复用存量） */
  ensuredPlan: boolean
  /** 本次发放订阅数 */
  granted: number
  /** 跳过数（已有 gift 锚或有效订阅） */
  skipped: number
}

/**
 * 发放赠送订阅（幂等可重入）：
 * ensure Product（code 查找或建）→ ensure Plan（product 下 name 匹配或建）→
 * 逐 org 幂等判定 → 建（或复用）合成 Order + ACTIVE Subscription
 * （sourceOrderId=gift-<orgId>，entitlements=配额快照）→ 末尾对每个处理的 org
 * （本轮 granted 或 gift 锚命中 skip）recompute（幂等，含中断自愈）。
 */
export async function grantGiftSubscriptions(
  prisma: PrismaClient,
  options: GrantGiftOptions = {},
): Promise<GrantGiftResult> {
  const planCode = options.planCode ?? GIFT_PRODUCT_CODE
  const days = options.days ?? GIFT_GRANT_DAYS
  const now = options.now ?? (() => new Date())
  const nowValue = now()
  const entitlementsSnapshot = GIFT_ENTITLEMENTS as unknown as Prisma.InputJsonValue

  // 1) ensure Product：code 命中即复用（幂等）
  let product: Product | null = await prisma.product.findUnique({
    where: { code: planCode },
  })
  let ensuredProduct = false
  if (!product) {
    product = await prisma.product.create({
      data: {
        code: planCode,
        name: '迁移赠送订阅',
        kind: 'SUBSCRIPTION',
        description: '存量客户迁移赠送（不在商城展示）',
        active: false,
      },
    })
    ensuredProduct = true
  }

  // 2) ensure Plan：product 下 name 命中即复用（幂等）
  let plan: ProductPlan | null = await prisma.productPlan.findFirst({
    where: { productId: product.id, name: GIFT_PLAN_NAME },
  })
  let ensuredPlan = false
  if (!plan) {
    plan = await prisma.productPlan.create({
      data: {
        productId: product.id,
        name: GIFT_PLAN_NAME,
        priceCents: 0,
        billingPeriod: null,
        entitlements: entitlementsSnapshot,
        deliverables: [],
        active: false,
      },
    })
    ensuredPlan = true
  }

  // 3) 逐 org：幂等判定 → 发放
  const orgs = await prisma.organization.findMany({ select: { id: true } })
  let granted = 0
  let skipped = 0
  // 需配额重算的 org：本轮发放的 + gift 锚命中的（见下方"中断自愈"与文件头说明）
  const recomputeOrgIds: string[] = []
  for (const org of orgs) {
    // 幂等 1：本脚本已发过（gift 锚，无论订阅当前状态——不续赠）。判定只按
    // organizationId + sourceOrderId，不绑 planId：plan 行被运营删除后脚本重建
    // （新 id）时，旧 gift 订阅仍被锚命中，不会过期后二次发放。
    const gifted = await prisma.subscription.findFirst({
      where: {
        organizationId: org.id,
        sourceOrderId: giftOrderId(org.id),
      },
      select: { id: true },
    })
    if (gifted) {
      skipped += 1
      // 锚命中也记入重算集（recompute 幂等）：上轮 subscription.create 之后、
      // recompute 之前中断的 org，重跑时靠此分支补算——否则 OE 无行全 0，
      // BILLING_ENFORCEMENT 下整企业零配额且无自愈
      recomputeOrgIds.push(org.id)
      continue
    }
    // 幂等 2：已有有效订阅（ACTIVE 且 endAt>now / GRACE）→ 有服务的不赠送
    const active = await prisma.subscription.findFirst({
      where: {
        organizationId: org.id,
        OR: [{ status: 'ACTIVE', endAt: { gt: nowValue } }, { status: 'GRACE' }],
      },
      select: { id: true },
    })
    if (active) {
      skipped += 1
      continue
    }

    // 合成 Order（订阅 sourceOrderId 的 FK 锚）：固定 id 幂等，0 元非交易
    const orderId = giftOrderId(org.id)
    const existingOrder = await prisma.order.findUnique({ where: { id: orderId } })
    if (!existingOrder) {
      await prisma.order.create({
        data: {
          id: orderId,
          orderNo: orderId,
          organizationId: org.id,
          status: 'COMPLETED',
          totalCents: 0,
          payableCents: 0,
          remark: '迁移赠送订阅合成订单（非交易，仅作订阅 sourceOrderId 锚）',
        },
      })
    }

    await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: plan.id,
        sourceOrderId: orderId,
        startAt: nowValue,
        endAt: new Date(nowValue.getTime() + days * DAY_MS),
        status: 'ACTIVE',
        entitlements: entitlementsSnapshot,
      },
    })
    granted += 1
    recomputeOrgIds.push(org.id)
  }

  // 4) 配额重算：本轮发放的 org 与 gift 锚命中的 org（recompute 幂等，多算安全）。
  //    锚命中也重算 = 中断自愈：脚本发放对象恰是无订阅 org（大概率无 OE 行），
  //    而 getLimits 读路径不重算、无行返回全 0——若上轮在 subscription.create 之后、
  //    此处之前中断，重跑靠锚命中分支补算，避免 OE 全 0 锁死。
  //    （"已有有效订阅"skip 的 org 配额由其订阅生命周期维护，不在此重算。）
  const entitlementService = createEntitlementService({ prisma, now })
  for (const orgId of recomputeOrgIds) {
    await entitlementService.recompute(orgId)
  }

  return { ensuredProduct, ensuredPlan, granted, skipped }
}

/** 打印各计数（第二遍运行 granted 应为 0）。 */
export async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const result = await grantGiftSubscriptions(prisma)
    console.log(
      `[grant-gift-subscriptions] Product ${result.ensuredProduct ? '新建' : '复用'} / Plan ${result.ensuredPlan ? '新建' : '复用'}`,
    )
    console.log(`[grant-gift-subscriptions] 发放赠送订阅: ${result.granted} 个企业`)
    console.log(`[grant-gift-subscriptions] 跳过（已发放/已有有效订阅）: ${result.skipped} 个企业`)
    console.log('[grant-gift-subscriptions] 完成（脚本可重入，第二遍运行 granted 应为 0）')
  } finally {
    await prisma.$disconnect()
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[grant-gift-subscriptions] 失败:', err)
    process.exitCode = 1
  })
}

import type { Prisma, PrismaClient, BillingPeriod, ProductKind } from '@prisma/client'
import type { AuditService } from '../audit/service.js'

/** 商品 code 冲突错误（prisma P2002 转）：name 固定为 PRODUCT_CODE_CONFLICT */
export class ProductCodeConflictError extends Error {
  constructor(code: string) {
    super(`商品 code 已存在：${code}`)
    this.name = 'PRODUCT_CODE_CONFLICT'
  }
}

/** 商品不存在错误：name 固定为 PRODUCT_NOT_FOUND */
export class ProductNotFoundError extends Error {
  constructor(id: string) {
    super(`商品不存在：${id}`)
    this.name = 'PRODUCT_NOT_FOUND'
  }
}

/** 套餐不存在错误：name 固定为 PRODUCT_PLAN_NOT_FOUND */
export class ProductPlanNotFoundError extends Error {
  constructor(id: string) {
    super(`套餐不存在：${id}`)
    this.name = 'PRODUCT_PLAN_NOT_FOUND'
  }
}

/** prisma P2002（unique 冲突）鸭型判定：不引运行时 Prisma 命名空间，mock 与真实驱动通吃 */
function isPrismaUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'P2002'
}

/** catalog.list 投影（Ruling 7：仅 active，商城展示用，含 entitlements 供配额展示） */
export interface CatalogPlanPublicView {
  id: string
  name: string
  priceCents: number
  billingPeriod: BillingPeriod | null
  entitlements: Prisma.JsonValue
  deliverables: Prisma.JsonValue
}

export interface CatalogProductPublicView {
  id: string
  code: string
  name: string
  kind: ProductKind
  description: string
  plans: CatalogPlanPublicView[]
}

export interface CatalogListResult {
  items: CatalogProductPublicView[]
}

/** admin 变更返回投影（含 active 与全量 plans，含下架项供后台管理） */
export interface ProductPlanAdminView {
  id: string
  productId: string
  name: string
  priceCents: number
  billingPeriod: BillingPeriod | null
  entitlements: Prisma.JsonValue
  deliverables: Prisma.JsonValue
  active: boolean
}

export interface ProductAdminView {
  id: string
  code: string
  name: string
  kind: ProductKind
  description: string
  active: boolean
  createdAt: Date
  updatedAt: Date
  plans: ProductPlanAdminView[]
}

export interface CreateProductInput {
  code: string
  name: string
  kind: ProductKind
  description?: string
}

/** code/kind 不可变：code 是对外业务键（订单引用语义），kind 变更会使存量订单/配额语义漂移 */
export interface UpdateProductInput {
  name?: string
  description?: string
}

export interface CreatePlanInput {
  name: string
  /** 价格：整数分（zod int 校验在前，service 原样落库） */
  priceCents: number
  /** 计费周期：MONTH/YEAR，缺省 null = 一次性 */
  billingPeriod?: BillingPeriod
  /** 配额声明 { maxWorkspaces, maxQueries, allowedPlatforms, ... } */
  entitlements: Prisma.InputJsonValue
  /** 交付模板（专业服务里程碑），缺省 [] */
  deliverables?: Prisma.InputJsonValue
}

export interface UpdatePlanInput {
  name?: string
  priceCents?: number
  /** null = 清除（转一次性） */
  billingPeriod?: BillingPeriod | null
  entitlements?: Prisma.InputJsonValue
  deliverables?: Prisma.InputJsonValue
}

export interface CatalogServiceDeps {
  prisma: PrismaClient
  audit: AuditService
}

export interface CatalogService {
  /** 创建商品：code 冲突（P2002）抛 ProductCodeConflictError */
  createProduct(input: CreateProductInput, actorId?: string): Promise<ProductAdminView>
  updateProduct(id: string, fields: UpdateProductInput, actorId?: string): Promise<ProductAdminView>
  /** 上下架：下架后 listActive 不返回（商城不可见，存量订单不受影响） */
  setProductActive(id: string, active: boolean, actorId?: string): Promise<ProductAdminView>
  /** 创建套餐：所属商品不存在抛 ProductNotFoundError */
  createPlan(
    productId: string,
    input: CreatePlanInput,
    actorId?: string,
  ): Promise<ProductPlanAdminView>
  updatePlan(
    id: string,
    fields: UpdatePlanInput,
    actorId?: string,
  ): Promise<ProductPlanAdminView>
  setPlanActive(id: string, active: boolean, actorId?: string): Promise<ProductPlanAdminView>
  /** 商城目录：仅 active 产品 + active plans 投影 */
  listActive(filter?: { kind?: ProductKind }): Promise<CatalogListResult>
  /** 后台全量目录（任务 15 审查修复）：含 inactive 产品与 plans 的 AdminView 投影，
   *  供目录管理页展示下架条目并重新上架（q 可选 code/name contains 过滤） */
  listAll(filter?: { q?: string }): Promise<{ items: ProductAdminView[] }>
}

type ProductRowWithPlans = Prisma.ProductGetPayload<{ include: { plans: true } }>

/** prisma Product 行（含 plans）→ admin 投影 */
function toProductAdminView(product: ProductRowWithPlans): ProductAdminView {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    kind: product.kind,
    description: product.description,
    active: product.active,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    plans: [...product.plans]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((plan) => ({
        id: plan.id,
        productId: plan.productId,
        name: plan.name,
        priceCents: plan.priceCents,
        billingPeriod: plan.billingPeriod,
        entitlements: plan.entitlements,
        deliverables: plan.deliverables,
        active: plan.active,
      })),
  }
}

/**
 * 服务目录服务（catalog.list 与 admin.catalog.* 路由后端）：
 * 商品（订阅/服务/加购）与套餐（价格/周期/配额/交付模板）的 CRUD + 上下架。
 *
 * - code/kind 创建后不可变（update 不接受这两个字段）；
 * - 所有变更写审计 catalog.product.* / catalog.plan.*（actorType='USER'，
 *   与 workspace-admin 侧惯例一致；audit.record 异常不阻断业务）。
 */
export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { prisma, audit } = deps

  return {
    async createProduct(input, actorId) {
      let created
      try {
        created = await prisma.product.create({
          data: {
            code: input.code,
            name: input.name,
            kind: input.kind,
            description: input.description ?? '',
          },
        })
      } catch (err) {
        if (isPrismaUniqueConstraintViolation(err)) {
          throw new ProductCodeConflictError(input.code)
        }
        throw err
      }
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'catalog.product.create',
        target: `Product:${created.id}`,
        diff: { code: input.code, name: input.name, kind: input.kind },
      })
      // 新建商品必无套餐：直接投影（省一次回读）
      return toProductAdminView({ ...created, plans: [] })
    },

    async updateProduct(id, input, actorId) {
      // 预读含 plans：空变更短路直接投影当前行，免第二次回读
      const existing = await prisma.product.findUnique({ where: { id }, include: { plans: true } })
      if (!existing) throw new ProductNotFoundError(id)

      const data: Prisma.ProductUpdateInput = {}
      const changed: string[] = []
      if (input.name !== undefined) {
        data.name = input.name
        changed.push('name')
      }
      if (input.description !== undefined) {
        data.description = input.description
        changed.push('description')
      }
      // 全字段可选且一个未传（仅 id）：短路返回当前行——不执行空 update、不记 diff:[] 审计
      if (changed.length === 0) return toProductAdminView(existing)

      const updated = await prisma.product.update({
        where: { id },
        data,
        include: { plans: true },
      })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'catalog.product.update',
        target: `Product:${id}`,
        diff: changed,
      })
      return toProductAdminView(updated)
    },

    async setProductActive(id, active, actorId) {
      const existing = await prisma.product.findUnique({ where: { id } })
      if (!existing) throw new ProductNotFoundError(id)

      const updated = await prisma.product.update({
        where: { id },
        data: { active },
        include: { plans: true },
      })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'catalog.product.set_active',
        target: `Product:${id}`,
        diff: { active },
      })
      return toProductAdminView(updated)
    },

    async createPlan(productId, input, actorId) {
      const product = await prisma.product.findUnique({ where: { id: productId } })
      if (!product) throw new ProductNotFoundError(productId)

      const plan = await prisma.productPlan.create({
        data: {
          productId,
          name: input.name,
          priceCents: input.priceCents,
          billingPeriod: input.billingPeriod ?? null,
          entitlements: input.entitlements,
          deliverables: input.deliverables ?? [],
        },
      })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'catalog.plan.create',
        target: `ProductPlan:${plan.id}`,
        diff: {
          productId,
          name: input.name,
          priceCents: input.priceCents,
          billingPeriod: input.billingPeriod ?? null,
        },
      })
      return {
        id: plan.id,
        productId: plan.productId,
        name: plan.name,
        priceCents: plan.priceCents,
        billingPeriod: plan.billingPeriod,
        entitlements: plan.entitlements,
        deliverables: plan.deliverables,
        active: plan.active,
      }
    },

    async updatePlan(id, input, actorId) {
      const existing = await prisma.productPlan.findUnique({ where: { id } })
      if (!existing) throw new ProductPlanNotFoundError(id)

      const data: Prisma.ProductPlanUpdateInput = {}
      const changed: string[] = []
      if (input.name !== undefined) {
        data.name = input.name
        changed.push('name')
      }
      if (input.priceCents !== undefined) {
        data.priceCents = input.priceCents
        changed.push('priceCents')
      }
      if (input.billingPeriod !== undefined) {
        data.billingPeriod = input.billingPeriod
        changed.push('billingPeriod')
      }
      if (input.entitlements !== undefined) {
        data.entitlements = input.entitlements
        changed.push('entitlements')
      }
      if (input.deliverables !== undefined) {
        data.deliverables = input.deliverables
        changed.push('deliverables')
      }
      // 全字段可选且一个未传（仅 id）：短路返回当前行——不执行空 update、不记 diff:[] 审计
      if (changed.length === 0) {
        return {
          id: existing.id,
          productId: existing.productId,
          name: existing.name,
          priceCents: existing.priceCents,
          billingPeriod: existing.billingPeriod,
          entitlements: existing.entitlements,
          deliverables: existing.deliverables,
          active: existing.active,
        }
      }

      const plan = await prisma.productPlan.update({ where: { id }, data })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'catalog.plan.update',
        target: `ProductPlan:${id}`,
        diff: changed,
      })
      return {
        id: plan.id,
        productId: plan.productId,
        name: plan.name,
        priceCents: plan.priceCents,
        billingPeriod: plan.billingPeriod,
        entitlements: plan.entitlements,
        deliverables: plan.deliverables,
        active: plan.active,
      }
    },

    async setPlanActive(id, active, actorId) {
      const existing = await prisma.productPlan.findUnique({ where: { id } })
      if (!existing) throw new ProductPlanNotFoundError(id)

      const plan = await prisma.productPlan.update({ where: { id }, data: { active } })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'catalog.plan.set_active',
        target: `ProductPlan:${id}`,
        diff: { active },
      })
      return {
        id: plan.id,
        productId: plan.productId,
        name: plan.name,
        priceCents: plan.priceCents,
        billingPeriod: plan.billingPeriod,
        entitlements: plan.entitlements,
        deliverables: plan.deliverables,
        active: plan.active,
      }
    },

    async listActive(filter = {}) {
      const where: Prisma.ProductWhereInput = { active: true }
      if (filter.kind) where.kind = filter.kind
      const products = await prisma.product.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { plans: { where: { active: true }, orderBy: { createdAt: 'asc' } } },
      })
      return {
        items: products.map((product) => ({
          id: product.id,
          code: product.code,
          name: product.name,
          kind: product.kind,
          description: product.description,
          // 投影边界二次过滤：include where 已滤，这里兜底防下架 plan 泄漏到商城
          plans: product.plans
            .filter((plan) => plan.active)
            .map((plan) => ({
              id: plan.id,
              name: plan.name,
              priceCents: plan.priceCents,
              billingPeriod: plan.billingPeriod,
              entitlements: plan.entitlements,
              deliverables: plan.deliverables,
            })),
        })),
      }
    },

    async listAll(filter = {}) {
      // 后台管理视角：不过滤 active（下架条目须可见可再上架，任务 15 审查修复）
      const where: Prisma.ProductWhereInput = {}
      if (filter.q) {
        where.OR = [{ code: { contains: filter.q } }, { name: { contains: filter.q } }]
      }
      const products = await prisma.product.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { plans: true },
      })
      return { items: products.map(toProductAdminView) }
    },
  }
}

import { router } from './core/trpc/init.js'
import { workspaceRouter } from './core/workspace/router.js'
import { citationRouter } from './modules/citation-monitor/router.js'
import { contentRouter } from './modules/content-optimizer/router.js'
import { taskRouter } from './modules/content-optimizer/task-router.js'
import { schemaRouter } from './modules/schema-generator/router.js'
import { kgRouter } from './modules/knowledge-graph/router.js'
import { diagnosticRouter } from './modules/diagnostic/router.js'
import { authRouter, adminUserRouter } from './platform/identity/router.js'
import { auditRouter } from './platform/audit/router.js'
import { adminWorkspaceRouter } from './platform/tenancy/workspace-router.js'
import { orgRouter } from './platform/org/router.js'
import { catalogRouter, adminCatalogRouter } from './platform/catalog/router.js'
import { orderRouter } from './platform/commerce/order-router.js'
import { adminOrderRouter } from './platform/commerce/admin-order-router.js'
import { adminPaymentRouter } from './platform/commerce/admin-payment-router.js'
import { adminRefundRouter } from './platform/commerce/refund-router.js'
import { orgInvoicesRouter, adminInvoicesRouter } from './platform/commerce/invoice-router.js'
import { billingRouter } from './platform/billing/billing-router.js'

export const appRouter = router({
  auth: authRouter,
  admin: router({
    user: adminUserRouter,
    audit: auditRouter,
    workspace: adminWorkspaceRouter,
    catalog: adminCatalogRouter,
    orders: adminOrderRouter,
    payments: adminPaymentRouter,
    refunds: adminRefundRouter,
    invoices: adminInvoicesRouter,
  }),
  // 任务 13：org 命名空间加 invoices 子树（保持 orgRouter 单一来源——展开其
  // procedures 后追加子树，等价于在 org/router.ts 内挂载，路径为 org.invoices.*）
  org: router({
    ...orgRouter._def.procedures,
    invoices: orgInvoicesRouter,
  }),
  orders: orderRouter,
  // 任务 14：客户侧"我的服务"轻查询（订阅投影 + 配额/当月用量汇总）
  billing: billingRouter,
  workspace: workspaceRouter,
  catalog: catalogRouter,
  citation: citationRouter,
  content: contentRouter,
  tasks: taskRouter,
  schema: schemaRouter,
  kg: kgRouter,
  diagnostic: diagnosticRouter,
})

export type AppRouter = typeof appRouter

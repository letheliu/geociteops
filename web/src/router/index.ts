import { createRouter, createWebHistory } from 'vue-router'
import { useSessionStore } from '../stores/session'
import { workspaceIdHeader } from '../stores/workspace-header'

/**
 * 路由树：
 * - /login、/change-password、/403：公开页（不要求会话）；
 * - /admin：平台管理区（requires: 'platform'，仅 PLATFORM 用户）；
 * - /console：客户控制台区（requires: 'customer'，仅 CUSTOMER 用户——console-home 我的 Workspace），
 *   w/:workspaceId 下挂工作台全部子路由（平台用户"进入工作区"也复用此树）。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/Login.vue'),
      meta: { public: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('../views/auth/Register.vue'),
      meta: { public: true },
    },
    {
      path: '/change-password',
      name: 'change-password',
      component: () => import('../views/ChangePassword.vue'),
      meta: { public: true },
    },
    {
      path: '/403',
      name: 'forbidden',
      component: () => import('../views/Forbidden.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      redirect: '/admin',
    },
    {
      path: '/admin',
      component: () => import('../layouts/AdminLayout.vue'),
      meta: { requires: 'platform' },
      children: [
        {
          path: '',
          name: 'admin-overview',
          component: () => import('../views/admin/Overview.vue'),
        },
        {
          path: 'workspaces',
          name: 'admin-workspaces',
          component: () => import('../views/admin/Workspaces.vue'),
        },
        {
          path: 'workspaces/:id',
          name: 'admin-workspace-detail',
          component: () => import('../views/admin/WorkspaceDetail.vue'),
        },
        {
          path: 'users',
          name: 'admin-users',
          component: () => import('../views/admin/Users.vue'),
        },
        {
          path: 'audit',
          name: 'admin-audit-log',
          component: () => import('../views/admin/AuditLog.vue'),
        },
        // 商业域六页（任务 15）：meta.requires 由 /admin 父路由覆盖；
        // 页内更细的角色可见性（订单写操作 / 目录管理 / 财务工作台）由各页按
        // session.me.platformRole 自行处理，数据面后端权限点判
        {
          path: 'orders',
          name: 'admin-orders',
          component: () => import('../views/admin/AdminOrders.vue'),
        },
        {
          path: 'orders/:id',
          name: 'admin-order-detail',
          component: () => import('../views/admin/OrderDetail.vue'),
        },
        {
          path: 'payments',
          name: 'admin-payments',
          component: () => import('../views/admin/Payments.vue'),
        },
        {
          path: 'refunds',
          name: 'admin-refunds',
          component: () => import('../views/admin/Refunds.vue'),
        },
        {
          path: 'invoices',
          name: 'admin-invoices',
          component: () => import('../views/admin/Invoices.vue'),
        },
        {
          path: 'catalog',
          name: 'admin-catalog',
          component: () => import('../views/admin/Catalog.vue'),
        },
      ],
    },
    {
      path: '/console',
      component: () => import('../layouts/ConsoleLayout.vue'),
      children: [
        // 客户控制台首页（我的 Workspace，任务 8）：仅 CUSTOMER 可入（守卫 requires）；
        // 平台用户登录落点恒 /admin，进入工作区走 admin 的 enterWorkspace，不经此路由
        {
          path: '',
          name: 'console-home',
          component: () => import('../views/console/Home.vue'),
          meta: { requires: 'customer' },
        },
        // 企业设置三页（任务 9）：仅 CUSTOMER 可入（越权 /403）；
        // 页内更细的只读降级（MEMBER/VIEWER）由各页按 sessionStore.isOrgOwner 自行处理
        {
          path: 'settings/organization',
          name: 'console-org-info',
          component: () => import('../views/console/OrgInfo.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'settings/members',
          name: 'console-members',
          component: () => import('../views/console/Members.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'settings/credentials',
          name: 'console-credentials',
          component: () => import('../views/console/Credentials.vue'),
          meta: { requires: 'customer' },
        },
        // 服务与购买四页（任务 14）：仅 CUSTOMER 可入（越权 /403）；
        // 页内下单按钮按 session.me.orgRole 隐藏（ORG_MEMBER 无 order.create，
        // 数据面后端判）；订单列表/详情 order.view 对 ORG_VIEWER 恒拒——
        // 菜单入口已对 VIEWER 隐藏，Orders 页对 VIEWER 直接空态不调接口；
        // 商城浏览（catalog.list authed）与 Billing/Invoices（orgProcedure）
        // 对任意客户角色开放
        {
          path: 'services',
          name: 'console-services',
          component: () => import('../views/console/Marketplace.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'orders',
          name: 'console-orders',
          component: () => import('../views/console/Orders.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'orders/:id',
          name: 'console-order-detail',
          component: () => import('../views/console/OrderDetail.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'billing',
          name: 'console-billing',
          component: () => import('../views/console/Billing.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'invoices',
          name: 'console-invoices',
          component: () => import('../views/console/Invoices.vue'),
          meta: { requires: 'customer' },
        },
        {
          path: 'w/:workspaceId',
          component: () => import('../layouts/WorkspaceLayout.vue'),
          children: [
            {
              path: '',
              name: 'dashboard',
              component: () => import('../views/Dashboard.vue'),
            },
            {
              path: 'citation/queries',
              name: 'citation-queries',
              component: () => import('../views/citation/QueryLibrary.vue'),
            },
            {
              path: 'citation/reports',
              name: 'citation-reports',
              component: () => import('../views/citation/Reports.vue'),
            },
            {
              path: 'citation/sov',
              name: 'citation-sov',
              component: () => import('../views/citation/SovAnalytics.vue'),
            },
            // 引用覆盖矩阵:页面 × 平台被引、盲区、意图落空(见 docs/METRICS.md)
            {
              path: 'citation/coverage',
              name: 'citation-coverage',
              component: () => import('../views/citation/CoverageMatrix.vue'),
            },
            {
              path: 'citation/effect',
              name: 'citation-effect',
              component: () => import('../views/citation/EffectComparison.vue'),
            },
            // M2 §3.3 闭环看板：薄弱点 → 建议 → 发布 → 回填 → Δ
            {
              path: 'loop',
              name: 'citation-loop',
              component: () => import('../views/citation/LoopBoard.vue'),
            },
            {
              path: 'content/pages',
              name: 'content-pages',
              component: () => import('../views/content/Pages.vue'),
            },
            {
              path: 'content/pages/:id',
              name: 'content-page-detail',
              component: () => import('../views/content/PageDetail.vue'),
            },
            {
              path: 'content/tasks',
              name: 'content-tasks',
              component: () => import('../views/content/Tasks.vue'),
            },
            {
              path: 'schema/records',
              name: 'schema-records',
              component: () => import('../views/schema/Records.vue'),
            },
            {
              path: 'schema/generate',
              name: 'schema-generate',
              component: () => import('../views/schema/Generate.vue'),
            },
            {
              path: 'schema/llms-txt',
              name: 'schema-llms-txt',
              component: () => import('../views/schema/LlmsTxt.vue'),
            },
            {
              path: 'kg/entities',
              name: 'kg-entities',
              component: () => import('../views/kg/Entities.vue'),
            },
            {
              path: 'kg/relations',
              name: 'kg-relations',
              component: () => import('../views/kg/Relations.vue'),
            },
            {
              path: 'kg/graph',
              name: 'kg-graph',
              component: () => import('../views/kg/Graph.vue'),
            },
            {
              path: 'diagnostic/projects',
              name: 'diagnostic-projects',
              component: () => import('../views/diagnostic/Projects.vue'),
            },
            {
              path: 'diagnostic/projects/create',
              name: 'diagnostic-project-create',
              component: () => import('../views/diagnostic/ProjectCreate.vue'),
            },
            {
              path: 'diagnostic/projects/:id',
              name: 'diagnostic-project-detail',
              component: () => import('../views/diagnostic/ProjectDetail.vue'),
            },
            {
              path: 'diagnostic/projects/:id/queries',
              name: 'diagnostic-query-planner',
              component: () => import('../views/diagnostic/QueryPlanner.vue'),
            },
            {
              path: 'diagnostic/runs/:projectId/create',
              name: 'diagnostic-run-create',
              component: () => import('../views/diagnostic/RunCreate.vue'),
            },
            {
              path: 'diagnostic/runs/:runId/progress',
              name: 'diagnostic-run-progress',
              component: () => import('../views/diagnostic/RunProgress.vue'),
            },
            {
              path: 'diagnostic/reports/:runId',
              name: 'diagnostic-report',
              component: () => import('../views/diagnostic/Report.vue'),
            },
            {
              path: 'diagnostic/comparison/:baselineRunId/:retestRunId',
              name: 'diagnostic-comparison',
              component: () => import('../views/diagnostic/Comparison.vue'),
            },
            {
              path: 'diagnostic/actions',
              name: 'diagnostic-actions',
              component: () => import('../views/diagnostic/Actions.vue'),
            },
            {
              path: 'settings',
              name: 'settings',
              component: () => import('../views/Settings.vue'),
            },
          ],
        },
      ],
    },
  ],
})

/**
 * 会话守卫：
 * 1. 公开页直放；
 * 2. 本次启动首次进入受保护页时探测会话（fetchMe 只在 !ready 时执行一次）；
 * 3. 未登录 → /login?redirect=<原路径>；
 * 4. mustChangePassword 且目标非改密页 → 强制改密；
 * 5. requires: 'platform' 仅 PLATFORM 用户可入、requires: 'customer' 仅 CUSTOMER 用户可入
 *    （console-home，任务 8 挂载；任务 9 的企业设置页同模式），越界 → /403；
 *    /console/w/* 子路由不加 requires——平台用户经"进入工作区"也走此树，授权由后端判，前端不做 access 拦截。
 */
router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const session = useSessionStore()
  if (!session.ready) {
    try {
      await session.fetchMe()
    } catch {
      // fetchMe 内部已兜底置 me=null；此处防御网络/渲染层异常
      session.me = null
      session.ready = true
    }
  }
  if (!session.me) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  if (session.me.mustChangePassword && to.name !== 'change-password') {
    return { path: '/change-password', query: { redirect: to.fullPath } }
  }
  if (to.meta.requires === 'platform' && session.me.userType !== 'PLATFORM') {
    return { path: '/403' }
  }
  if (to.meta.requires === 'customer' && session.me.userType !== 'CUSTOMER') {
    return { path: '/403' }
  }
  return true
})

const TITLE_MAP: Record<string, string> = {
  login: '登录',
  register: '注册试用',
  'change-password': '修改密码',
  forbidden: '无权限',
  'console-home': '我的 Workspace',
  'console-org-info': '企业信息',
  'console-members': '成员管理',
  'console-credentials': 'API 凭证',
  'console-services': '服务商城',
  'console-orders': '我的订单',
  'console-order-detail': '订单详情',
  'console-billing': '我的服务',
  'console-invoices': '发票管理',
  'admin-overview': '平台管理',
  'admin-workspaces': 'Workspace 管理',
  'admin-workspace-detail': 'Workspace 详情',
  'admin-users': '员工账号',
  'admin-audit-log': '审计日志',
  'admin-orders': '订单中心',
  'admin-order-detail': '订单详情',
  'admin-payments': '收款确认',
  'admin-refunds': '退款管理',
  'admin-invoices': '发票管理',
  'admin-catalog': '服务目录',
  dashboard: '概览',
  'citation-queries': '查询库',
  'citation-reports': '引用报告',
  'citation-sov': 'SOV 分析',
  'citation-coverage': '引用覆盖',
  'citation-effect': '效果对比',
  'citation-loop': '闭环看板',
  'content-pages': '内容页面',
  'content-page-detail': '内容详情',
  'content-tasks': '优化任务',
  'schema-records': 'Schema 记录',
  'schema-generate': '生成 JSON-LD',
  'schema-llms-txt': 'llms.txt 编辑器',
  'kg-entities': '实体管理',
  'kg-relations': '关系管理',
  'kg-graph': '图谱可视化',
  settings: '设置',
  'diagnostic-projects': '诊断项目',
  'diagnostic-project-create': '新建项目',
  'diagnostic-project-detail': '项目详情',
  'diagnostic-query-planner': '问题规划',
  'diagnostic-run-create': '创建诊断运行',
  'diagnostic-run-progress': '运行进度',
  'diagnostic-report': '诊断报告',
  'diagnostic-comparison': '复测对比',
  'diagnostic-actions': '行动中心',
}

router.afterEach((to) => {
  // 进入 /console/w/:workspaceId 时让 tRPC 客户端带上 x-workspace-id，离开时清除
  workspaceIdHeader.value = (to.params.workspaceId as string) ?? null

  const suffix = ' · GEO Console'
  const label = TITLE_MAP[to.name as string]
  document.title = label ? `${label}${suffix}` : `GeoCiteOps${suffix}`
})

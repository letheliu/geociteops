import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cors from '@fastify/cors'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { appRouter } from './router.js'
import { createContext } from './core/trpc/context.js'
import { getPrismaClient } from './core/db/client.js'
import { createQueue } from './core/queue/boss.js'
import { createSessionService } from './core/auth/session.js'
import { createAuditService } from './platform/audit/service.js'
import { createIdentityService } from './platform/identity/service.js'
import { createLoginRateLimiter } from './platform/identity/rate-limiter.js'
import { createRegistrationService } from './platform/identity/registration-service.js'
import { createApiCredentialService } from './platform/tenancy/api-credentials.js'
import { createMemberService } from './platform/tenancy/member-service.js'
import { createWorkspaceAdminService } from './platform/tenancy/workspace-admin.js'
import { createOrgService } from './platform/org/service.js'
import { createCatalogService } from './platform/catalog/service.js'
import { createOrderService } from './platform/commerce/order-service.js'
import { createRefundService } from './platform/commerce/refund-service.js'
import { createInvoiceService } from './platform/commerce/invoice-service.js'
import { createEntitlementService } from './platform/billing/entitlement-service.js'
import { createEntitlementGuard } from './platform/billing/entitlement-guard.js'
import { createUsageMeter } from './platform/billing/usage-meter.js'
import { createFilesService, FILE_CONTENT_TYPES, FILE_KEY_PATTERN } from './platform/commerce/files.js'
import { canAccessFile } from './platform/commerce/file-authz.js'
import { assertMockChannelConfigured, createChannelRegistry } from './platform/commerce/payment/channel.js'
import {
  handlePaymentCallback,
  mapWebhookError,
  parseWebhookChannelParam,
  reconcilePendingPayments,
} from './platform/commerce/payment/webhook.js'
import { createAdapterRegistry } from './modules/citation-monitor/platform-adapters/registry.js'
import { DeepSeekAdapter } from './modules/citation-monitor/platform-adapters/deepseek.js'
import { DoubaoAdapter } from './modules/citation-monitor/platform-adapters/doubao.js'
import { QwenAdapter } from './modules/citation-monitor/platform-adapters/qwen.js'
import { ErnieAdapter } from './modules/citation-monitor/platform-adapters/ernie.js'
import { PerplexityAdapter } from './modules/citation-monitor/platform-adapters/perplexity.js'
import { ChatGptSearchAdapter } from './modules/citation-monitor/platform-adapters/chatgpt.js'
import { GeminiAdapter } from './modules/citation-monitor/platform-adapters/gemini.js'
import { createQueryLibraryService } from './modules/citation-monitor/query-library.js'
import { createClosedLoopService } from './modules/citation-monitor/closed-loop-service.js'
import { createMonitor } from './modules/citation-monitor/monitor.js'
import { startCitationScheduler } from './workers/citation-scheduler.js'
import { startOrderActivateWorker } from './workers/order-activate.js'
import { startBillingCrons } from './workers/billing-crons.js'
import { loadMasterKey } from './core/crypto/envelope.js'
import { createCredentialResolver } from './platform/tenancy/credential-resolver.js'
import { getLlmProvider } from './core/llm/index.js'
import { getVectorStore } from './core/vector/index.js'
import { createProjectService } from './modules/diagnostic/project-service.js'
import { createQueryPlanner } from './modules/diagnostic/query-planner.js'
import { createRunService } from './modules/diagnostic/run-service.js'
import { createSampleExecutor } from './modules/diagnostic/executor.js'
import { createReportService } from './modules/diagnostic/report-service.js'
import { createActionService } from './modules/diagnostic/action-service.js'
import { analyzeCitation } from './modules/citation-monitor/analyzer.js'
import { startDiagnosticWorkers } from './workers/diagnostic-workers.js'
import { createAtomizer } from './modules/content-optimizer/atomizer.js'
import { createScoringEngine } from './modules/content-optimizer/scoring.js'
import { createCitabilityEngine } from './modules/content-optimizer/citability.js'
import { createEeatEngine } from './modules/content-optimizer/eeat.js'
import { createRewriter } from './modules/content-optimizer/rewriter.js'
import { createFaqGenerator } from './modules/content-optimizer/faq-generator.js'
import { createTaskService } from './modules/content-optimizer/task-service.js'
import { createPageService } from './modules/content-optimizer/page-service.js'
import { createOrchestrator } from './modules/content-optimizer/orchestrator.js'
import { createEntityExtractor } from './core/extract/entity-extractor.js'
import { createSchemaAdapter } from './core/extract/adapters/schema-adapter.js'
import { createKgAdapter } from './core/extract/adapters/kg-adapter.js'
import { createSchemaRegistry } from './modules/schema-generator/schema-registry.js'
import { createJsonLdBuilder } from './modules/schema-generator/jsonld-builder.js'
import { createLlmsTxtBuilder } from './modules/schema-generator/llms-txt-builder.js'
import { createSchemaValidator } from './modules/schema-generator/validator.js'
import { createDeprecationService } from './modules/schema-generator/deprecated-types.js'
import { createAutoSections } from './modules/schema-generator/auto-sections.js'
import { createSchemaService } from './modules/schema-generator/service.js'
import { createKgRepository } from './modules/knowledge-graph/repository.js'
import { createKgExtractor } from './modules/knowledge-graph/extractor.js'
import { createGraphExporter } from './modules/knowledge-graph/exporter.js'
import { createKgService } from './modules/knowledge-graph/service.js'

async function main() {
  const port = Number(process.env.PORT || 4000)
  const prisma = getPrismaClient()
  const llm = getLlmProvider()
  const vector = getVectorStore()

  // 组装 adapter registry（国内平台）
  const registry = createAdapterRegistry()
  registry.register(new DeepSeekAdapter())
  registry.register(new DoubaoAdapter())
  registry.register(new QwenAdapter())
  registry.register(new ErnieAdapter())
  registry.register(new PerplexityAdapter())
  registry.register(new ChatGptSearchAdapter())
  registry.register(new GeminiAdapter())

  // 信封主密钥启动即校验：缺失/格式错误直接终止启动
  const credentialMasterKey = loadMasterKey()
  // 任务 6 修复（审查 Important-1）：mock 支付密钥 fail-closed——PAY_MOCK_SECRET 缺失
  // 启动即终止（模式照 loadMasterKey）。默认密钥源码公开，静默回落等于持 channelOrderNo
  // 者可自造合法回调签名免付置 PAID；dev/生产均须显式设置（README 任务 17 统一补）
  assertMockChannelConfigured(process.env)
  const resolver = createCredentialResolver({ prisma, registry, masterKey: credentialMasterKey })

  // 任务 9：用量计量 + 配额守卫（工厂参数注入各业务服务 deps，不依赖 ctx.services）。
  // audit 前移创建（guard 的软限告警要用）；BILLING_ENFORCEMENT 开关在 guard 内部判定。
  const usageMeter = createUsageMeter({ prisma })
  const auditService = createAuditService(prisma)
  const entitlementGuard = createEntitlementGuard({
    prisma,
    meter: usageMeter,
    audit: auditService,
  })
  const billing = { guard: entitlementGuard, meter: usageMeter }

  const queryLibrary = createQueryLibraryService(prisma, llm, vector, billing)
  const monitor = createMonitor({
    prisma,
    registry,
    queryLibrary,
    competitors: [], // 生产环境从配置加载
    resolveConfig: resolver.resolveConfig,
    billing,
  })

  // 组装 content-optimizer 组件
  const atomizer = createAtomizer(llm)
  const citability = createCitabilityEngine()
  const scoring = createScoringEngine(citability)
  const rewriter = createRewriter(llm)
  const faqGenerator = createFaqGenerator(llm, prisma, vector)
  const eeat = createEeatEngine()

  // 共享层
  const entityExtractor = createEntityExtractor(llm)
  const schemaRegistry = createSchemaRegistry()
  const schemaAdapter = createSchemaAdapter(schemaRegistry)
  const kgAdapter = createKgAdapter()

  // Schema Generator
  const jsonLdBuilder = createJsonLdBuilder()
  const llmsTxtBuilder = createLlmsTxtBuilder()
  const validator = createSchemaValidator(schemaRegistry, createDeprecationService())
  const autoSections = createAutoSections({ prisma })
  const schemaService = createSchemaService({
    prisma, extractor: entityExtractor, schemaAdapter,
    jsonLdBuilder, llmsTxtBuilder, validator, autoSections, schemaRegistry,
  })

  // Knowledge Graph
  const kgRepository = createKgRepository(prisma, vector)
  const kgExtractorService = createKgExtractor({ prisma, extractor: entityExtractor, kgAdapter, billing })
  const kgExporter = createGraphExporter(prisma)
  const kgService = createKgService({
    prisma, repository: kgRepository, extractor: kgExtractorService, exporter: kgExporter, llm,
  })

  // taskService 增加回调钩子（驱动阶段 3 联动）
  // 任务 9：content 页服务（pages.upsert 挂 maxPages 软限 + PAGE_CREATED 计量）
  const pageService = createPageService({ prisma, billing })
  const taskService = createTaskService({
    prisma,
    billing,
    onPublished: async (task) => {
      // 内容类任务发布后自动重新生成 Schema
      if (task.pageId && (task.type === 'REWRITE_CONTENT' || task.type === 'OPTIMIZE_FOR_QUERY')) {
        try {
          await schemaService.regenerateForPage(task.pageId)
        } catch (err) {
          console.error('[onPublished] schemaService.regenerateForPage failed:', err)
        }
      }
      // UPDATE_KG 任务发布后持久化提案
      if (task.extractionProposals) {
        try {
          const proposals = task.extractionProposals as any
          await kgService.persistProposals(task.workspaceId, proposals)
        } catch (err) {
          console.error('[onPublished] kgService.persistProposals failed:', err)
        }
      }
    },
  })

  const orchestrator = createOrchestrator({
    atomizer, scoring, rewriter, faqGenerator, taskService, pages: pageService, eeat, citability, prisma, llm, vector,
  })

  // 诊断模块
  const projectService = createProjectService({ prisma })
  const queryPlanner = createQueryPlanner({ prisma })
  const sampleExecutor = createSampleExecutor({ prisma, registry, analyzeCitation, getCredentials: resolver.getCredentials })
  // M2 §3.3：注入 billing 以启用 actions.convert 的优化门禁前置断言
  const actionService = createActionService({ prisma, taskService: taskService as any, billing })
  const reportService = createReportService({ prisma })
  const dispatchRun = async (runId: string) => {
    const { createDispatcher } = await import('./workers/diagnostic-dispatcher.js')
    const dispatcher = createDispatcher({ boss, prisma })
    await dispatcher.dispatch(runId)
  }
  const runService = createRunService({ prisma, registry, dispatchRun, billing })

  // 平台安全基线服务（任务 8/11 实现，这里统一装配注入；router 内惰性默认不再触发）
  // pg-boss 前移：order service 依赖它投递 order.activate（收款确认/账期开通）
  const boss = await createQueue()
  const sessionService = createSessionService(prisma)
  const loginRateLimiter = createLoginRateLimiter()
  const memberService = createMemberService(prisma)
  const identityService = createIdentityService({
    prisma,
    sessions: sessionService,
    audit: auditService,
    loginRateLimiter,
    members: memberService,
  })
  const apiCredentialService = createApiCredentialService(prisma)
  const workspaceAdminService = createWorkspaceAdminService({
    prisma,
    credentials: apiCredentialService,
    audit: auditService,
    members: memberService,
    envelopeKey: credentialMasterKey,
    getSummary: (workspaceId) => resolver.getSummary(workspaceId),
    billing,
  })
  const orgService = createOrgService({
    prisma,
    identity: identityService,
    members: memberService,
    audit: auditService,
    credentials: apiCredentialService,
    workspaceAdmin: workspaceAdminService,
  })
  // 任务 2（P2）：服务目录（catalog.list 与 admin.catalog.* 后端）
  const catalogService = createCatalogService({ prisma, audit: auditService })
  // 任务 5（P2）：files 服务（回单落盘，目录 env GEO_UPLOAD_DIR）+ 订单服务注入
  // files/boss（uploadVoucher 写盘、confirmPayment/openOnCredit 投递 order.activate）
  const filesService = createFilesService({})
  // 任务 6 修复（审查 Minor-5）：装配级渠道注册表——createPayment（下单注册）/
  // webhook（回调验签）/ payment.reconcile（对账查单）共享同一 mock 实例内存注册表；
  // 逐调用 resolveChannel 新建实例互不可见，mock 下对账补单路径不可达
  const payChannels = createChannelRegistry(process.env)
  const orderService = createOrderService({
    prisma,
    files: filesService,
    boss,
    channelFactory: payChannels,
  })
  // 任务 8：企业配额重算服务（开通 worker 末步统一调用，§6.4）
  const entitlementService = createEntitlementService({ prisma })
  // M2 §3.0：自助注册服务（auth.register 五件套试用开通 + 双开关闸）
  const registrationService = createRegistrationService({
    prisma,
    sessions: sessionService,
    audit: auditService,
    entitlements: entitlementService,
    envelopeKey: credentialMasterKey,
  })
  // 任务 12：退款服务（申请/审批执行/配额回收）——渠道退款复用装配级 payChannels
  // 注册表（createPayment 与 refund 共享同一 mock 内存注册表，见 Minor-5 修复注释）
  const refundService = createRefundService({
    prisma,
    orders: orderService,
    channelResolver: payChannels,
    entitlements: entitlementService,
    audit: auditService,
  })
  // 任务 13：手工发票服务（申请/登记签发/驳回）——PDF 落盘复用 filesService
  // （与回单同一 GEO_UPLOAD_DIR，下载同走 GET /files/:key）
  const invoiceService = createInvoiceService({
    prisma,
    files: filesService,
    audit: auditService,
  })

  // 注入到 tRPC context 的 services
  const services = {
    prisma, monitor, queryLibrary,
    orchestrator, taskService, atomizer, faqGenerator,
    // M2 §3.3 闭环建议生成单入口（依赖 rewriter/atomizer/citability，与 ctx 无关的纯装配）
    closedLoop: createClosedLoopService({
      prisma, taskService, rewriter, atomizer, citability,
    }),
    pages: pageService,
    schema: schemaService,
    kg: kgService,
    vector,
    diagnostic: {
      projectService,
      queryPlanner,
      runService,
      reportService,
      actionService,
    },
    // 任务 12：identity/session/audit/workspaceAdmin/loginRateLimiter/getWorkspaceSummary
    identity: identityService,
    registration: registrationService,
    billing,
    session: sessionService,
    audit: auditService,
    workspaceAdmin: workspaceAdminService,
    org: orgService,
    catalog: catalogService,
    orders: orderService,
    refunds: refundService,
    invoices: invoiceService,
    loginRateLimiter,
    getWorkspaceSummary: (workspaceId: string) => resolver.getSummary(workspaceId),
  }

  // requestId 用 UUID：审计日志（requestId 来源）可跨日志关联
  // maxParamLength：tRPC batch 会把多个 procedure 拼进 /trpc/:path，默认 100 字符会让长批次直接 404
  const fastify = Fastify({ logger: true, genReqId: () => randomUUID(), maxParamLength: 5000 })
  await fastify.register(cookie)
  // 安全响应头（默认配置）
  await fastify.register(helmet)
  // 全局粗粒度兜底限流（细粒度如登录限流在 identity service 内）
  await fastify.register(rateLimit, { max: 300, timeWindow: '1 minute' })
  // CORS：CORS_ORIGINS（逗号分隔）非空才启用；空 = 同源部署，不注册
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (corsOrigins.length > 0) {
    await fastify.register(cors, { origin: corsOrigins, credentials: true })
  }
  await fastify.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async (opts: any) => {
        // fastify adapter 传入的 res 是 Fastify Reply（无 setHeader）；
        // 业务路由按 Node ServerResponse 风格 ctx.res.setHeader('Set-Cookie', …) 写会话 Cookie，
        // 这里透传 reply.raw（Node 会把 setHeader 的头与 fastify writeHead 的显式头合并，互不覆盖）。
        const ctx = await createContext({ ...opts, res: opts.res?.raw ?? opts.res })
        return { ...ctx, services } as any
      },
    },
  })

  // 轻量存活探针：不主动 ping DB，避免 DB 抖动导致容器误杀
  fastify.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }))

  // 回单/发票文件下载（任务 5 + 遗留 A1）：geo_sid 会话鉴权（与 context.ts 同名逻辑）
  // + key 白名单二次校验 + 归属校验（能力 URL 不再"任意会话持 key 即可下载"——回单含
  // 银行账户信息）+ 流式回传。路径穿越防御在 files service（resolvePath 形态校验）。
  fastify.get('/files/:key', async (req, reply) => {
    // 1) 会话鉴权：无有效 geo_sid 一律 401（不落入 tRPC context，此处自行解析）
    const cookieName = process.env.GEO_COOKIE_NAME || '__Host-geo_sid'
    const token = req.cookies?.[cookieName]
    const resolved = token ? await sessionService.resolve(token) : null
    if (!resolved) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '无有效会话，禁止访问文件' })
    }
    // 2) key 白名单在路由参数上再做一次（形态非法与文件不存在统一 404，不泄露差异）
    const key = (req.params as { key?: string }).key ?? ''
    if (!FILE_KEY_PATTERN.test(key)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '文件不存在' })
    }
    // 2') 归属校验（遗留 A1）：回单经订单 organizationId / 发票自带 organizationId
    //     与用户比对，PLATFORM 员工放行；不匹配与"文件不存在"统一 404（不泄露存在性）
    const allowed = await canAccessFile(prisma, resolved.user.id, key)
    if (!allowed) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '文件不存在' })
    }
    const filePath = filesService.resolvePath(key)
    try {
      await fsStat(filePath)
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '文件不存在' })
    }
    // 3) 按扩展回 Content-Type，流式回传（pipe 原始响应，不经 fastify 序列化）；
    //    Content-Disposition: attachment（遗留 A1）——下载语义，浏览器不内联渲染
    const ext = key.endsWith('.png') ? 'png' : key.endsWith('.jpg') ? 'jpg' : 'pdf'
    reply.header('Content-Type', FILE_CONTENT_TYPES[ext])
    reply.header('Content-Disposition', `attachment; filename="${key}"`)
    const stream = createReadStream(filePath)
    stream.on('error', (err) => {
      req.log.error(err, '[files] 回单流式读取失败')
      reply.raw.destroy()
    })
    stream.pipe(reply.raw)
    return reply
  })

  // 在线支付回调（任务 6，微信/支付宝 mock）：渠道 → 验签 → 幂等回调处理（四步）。
  // 验签对象裁定：fastify 默认 JSON 解析后以 JSON.stringify(request.body) 规范化串
  // 为准（mock 渠道按同规范生成签名）；真实 SDK 对接时改为真 raw body，
  // PaymentChannel.verifyCallback 接口不变。
  fastify.post('/webhooks/pay/:channel', async (req, reply) => {
    const channelName = (req.params as { channel?: string }).channel ?? ''
    const method = parseWebhookChannelParam(channelName)
    if (!method) {
      return reply.code(400).send({ ok: false, error: `未知支付渠道：${channelName}` })
    }
    if (req.body == null || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return reply.code(400).send({ ok: false, error: '回调 body 必须为 JSON 对象' })
    }
    // Node 入站 header 名统一小写；只透传单值头（数组头不参与验签）
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v
    }
    try {
      const result = await handlePaymentCallback(
        payChannels(method),
        JSON.stringify(req.body),
        headers,
        { prisma, orders: orderService },
      )
      return reply.code(200).send({ ok: true, duplicate: result.duplicate })
    } catch (err) {
      const mapped = mapWebhookError(err)
      req.log.warn({ err, status: mapped.status }, '[webhooks/pay] 支付回调处理被拒')
      return reply.code(mapped.status).send({ ok: false, error: mapped.message })
    }
  })

  // 启动定时任务（pg-boss 实例已在服务装配前创建）
  // 会话清理：每日 04:00 清掉过期/吊销超保留期的会话行（模式同 startCitationScheduler，内联）
  {
    const jobName = 'session.purge'
    await boss.createQueue(jobName)
    await boss.schedule(jobName, '0 4 * * *', {})
    await boss.work(jobName, async () => {
      try {
        const purged = await sessionService.purge()
        fastify.log.info(`[session.purge] 清理过期/吊销会话 ${purged} 行`)
      } catch (err) {
        // 清理失败不影响服务：下次 cron 重试
        fastify.log.error(err, '[session.purge] 会话清理失败（忽略，等待下次调度）')
      }
    })
  }

  // 任务 6：支付对账——每日 04:30 扫线上（微信/支付宝）PENDING 流水主动查单（§6.3），
  // SUCCESS 走回调等价补单（同 channelTxnNo 幂等锚）；内联注册（模式同 session.purge），
  // 任务 8 建 billing-crons.ts 时迁移合并
  {
    const jobName = 'payment.reconcile'
    await boss.createQueue(jobName)
    await boss.schedule(jobName, '30 4 * * *', {})
    await boss.work(jobName, async () => {
      try {
        const result = await reconcilePendingPayments({
          prisma,
          orders: orderService,
          channelFor: payChannels,
          log: (err, note) => fastify.log.error(err, note),
        })
        fastify.log.info(
          `[payment.reconcile] 扫描 ${result.scanned} 笔线上 PENDING：补单 ${result.confirmed}，重复 ${result.duplicates}，失败 ${result.failed}`,
        )
      } catch (err) {
        fastify.log.error(err, '[payment.reconcile] 支付对账失败（忽略，等待下次调度）')
      }
    })
  }

  // 任务 8：订单开通 worker（消费 order.activate：PAID→订阅/交付单/加购→无 SERVICE
  // 即 fulfill.complete→配额重算→首个 workspace 自动创建；幂等两道闸可重试）
  await startOrderActivateWorker({
    boss,
    prisma,
    orders: orderService,
    entitlements: entitlementService,
    audit: auditService,
  })

  // 任务 8：订单对账/超时 cron（billing-crons.ts 聚合注册——payment.reconcile
  // 保持上方内联，不迁移）：order.reconcile 每日 04:05 告警、order.expire 04:10 超时取消；
  // 任务 11：subscription.expire-check 04:15 到期检查（entitlements 供过期后配额重算）。
  // 遗留 B9：注入 fastify.log（cron 告警/异常进结构化日志通道，缺省回退 console）
  await startBillingCrons({
    boss,
    prisma,
    orders: orderService,
    audit: auditService,
    entitlements: entitlementService,
    logger: fastify.log,
  })

  await startCitationScheduler({
    boss,
    prisma,
    monitor,
    resolveActivePlatforms: resolver.listActivePlatforms,
  })
  await startDiagnosticWorkers({ boss, prisma, registry, analyzeCitation, getCredentials: resolver.getCredentials })

  await fastify.listen({ port, host: '0.0.0.0' })
  fastify.log.info(`geo-service listening on :${port}`)

  // 任务 9：usage meter 定时落库（≤1 分钟延迟；裁定用 interval 而非 pg-boss 每分钟
  // job，避免队列噪声）+ 优雅关闭 flush——SIGINT/SIGTERM 先冲缓冲再退出，不丢尾部用量
  const usageFlushTimer = setInterval(() => {
    usageMeter.flush().catch((err) => {
      fastify.log.error(err, '[usage-meter] 定时 flush 失败（缓冲保留待下周期重试）')
    })
  }, 60_000)
  usageFlushTimer.unref?.()

  async function shutdown(signal: string) {
    fastify.log.info(`[shutdown] 收到 ${signal}：flush 用量缓冲后关闭`)
    clearInterval(usageFlushTimer)
    try {
      const flushed = await usageMeter.flush()
      fastify.log.info(`[shutdown] usage meter 冲刷 ${flushed} 条`)
    } catch (err) {
      fastify.log.error(err, '[shutdown] usage meter flush 失败（尽力而为）')
    }
    await fastify.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('Failed to start geo-service:', err)
  process.exit(1)
})

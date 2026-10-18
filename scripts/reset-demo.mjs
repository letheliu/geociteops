// 演示环境每日重置脚本 —— M1 规格 §3.6 职责①
// 用法: pnpm demo:reset   （= tsx scripts/reset-demo.mjs）
//
// 职责三条（缺一不可，别拆散到别处——这部分一度是 tribal knowledge）：
//   ① 幂等确保演示企业 + 演示工作区 + 演示账号（ORG_VIEWER）存在。
//      seed-demo.mjs 是 findFirst 复用已有 workspace 的脚本，它**不建**企业/账号；
//      全新 compose 栈里没有 workspace，它会以「找不到 ZoomerAI workspace」直接退出，
//      所以「谁来创建演示租户」必须落在本脚本上。
//   ② 清空演示企业数据后重跑 seed-demo.mjs（seed 自身不清脏数据，重置需先清再种）。
//   ③ 为种子的 KG 实体向 zvec upsert 确定性伪向量（零 LLM 依赖），
//      让「向量库非空」可真实验收，副产物是演示站的相似实体检索能返回真实结果。
//
// zvec 写入的三个对齐点（错任何一个都表现为「静默检索不命中」）：
//   - collection 名必须是 entities   → 用 ZvecStore.COLLECTIONS.entities，不写字面量
//   - metadata 必须带 workspaceId    → searchSimilarEntities 按它过滤（repository.ts）
//   - 维度 = ZVEC_DIM 且 L2 归一化   → 集合 metric 是 COSINE（zvec-store.ts buildSchema）

import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { hashPassword, generateTempPassword } from '../src/core/auth/password.js'
import { loadMasterKey } from '../src/core/crypto/envelope.js'
import { ZvecStore } from '../src/core/vector/zvec-store.js'
import { deterministicVector, resolveVectorDim } from './lib/deterministic-vector.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// 演示租户标识。三者都做成常量而非散落字面量：seed-demo.mjs 按 defaultBrandName
// 含 'ZoomerAI' 反查工作区，改了名字两端就对不上。
const ORG_NAME = process.env.DEMO_ORG_NAME ?? 'ZoomerAI 演示企业'
const WS_NAME = process.env.DEMO_WORKSPACE_NAME ?? 'ZoomerAI 演示工作区'
const WS_BRAND = process.env.DEMO_BRAND_NAME ?? 'ZoomerAI'
const WS_DOMAIN = process.env.DEMO_WORKSPACE_DOMAIN ?? 'zoomer.top'
const DEMO_USERNAME = process.env.DEMO_USERNAME ?? 'demo-viewer'

const prisma = new PrismaClient()

/** 演示数据清空范围：与 seed-demo.mjs 的清理步骤对齐（含经实体间接归属的 KG）。 */
async function truncateDemoData(workspaceId) {
  await prisma.optimizationTask.deleteMany({ where: { workspaceId } })
  await prisma.schemaRecord.deleteMany({ where: { workspaceId } })
  await prisma.citationEvent.deleteMany({ where: { workspaceId } })
  // 监测运行（M2 §3.1）：Run 删除 Cascade 掉其采样行；显式删除保证重置后不留孤儿 Run
  await prisma.citationRun.deleteMany({ where: { workspaceId } })
  await prisma.citationQuery.deleteMany({ where: { workspaceId } })
  await prisma.contentPage.deleteMany({ where: { workspaceId } })
  // KgRelation 无 workspaceId，通过实体间接归属：先删关系再删实体
  const entities = await prisma.kgEntity.findMany({
    where: { workspaceId },
    select: { id: true },
  })
  if (entities.length > 0) {
    const ids = entities.map((e) => e.id)
    await prisma.kgRelation.deleteMany({ where: { fromEntityId: { in: ids } } })
    await prisma.kgRelation.deleteMany({ where: { toEntityId: { in: ids } } })
    await prisma.kgEntity.deleteMany({ where: { workspaceId } })
  }
}

/** 重跑种子：seed-demo.mjs 依赖 TS 源码里的信封加解密，只能经 tsx 跑。 */
function runSeed() {
  const seedPath = join(ROOT, 'scripts', 'seed-demo.mjs')
  const result = spawnSync('tsx', [seedPath], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    // Windows 上 node_modules/.bin 下的 tsx 是 .cmd 包装，必须走 shell 才能解析
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`seed-demo.mjs 执行失败（exit=${result.status}）`)
  }
}

async function main() {
  // 信封主密钥缺失时提前失败并给出可操作提示，而不是让 seed 抛一句栈
  try {
    loadMasterKey()
  } catch (e) {
    console.error('❌ CREDENTIAL_MASTER_KEY 未配置或格式非法：', e.message)
    console.error('   生成命令：node -e "console.log(require(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
    process.exitCode = 1
    return
  }

  // ===== ① 幂等确保演示企业 / 工作区 / 账号 =====
  let org = await prisma.organization.findFirst({ where: { name: ORG_NAME } })
  if (org) {
    console.log(`✅ 演示企业已存在：${org.name} (${org.id})`)
  } else {
    org = await prisma.organization.create({
      data: { name: ORG_NAME, industry: '软件服务' },
    })
    console.log(`✅ 演示企业已创建：${org.name} (${org.id})`)
  }

  // 工作区按企业维度复用（findFirst 而非 unique：同企业下可能存在多个工作区）
  let ws = await prisma.workspace.findFirst({ where: { organizationId: org.id } })
  if (ws) {
    console.log(`✅ 演示工作区已存在：${ws.name} (${ws.id})`)
  } else {
    ws = await prisma.workspace.create({
      data: {
        name: WS_NAME,
        domain: WS_DOMAIN,
        defaultBrandName: WS_BRAND,
        organizationId: org.id,
      },
    })
    console.log(`✅ 演示工作区已创建：${ws.name} (${ws.id})`)
  }
  const WS_ID = ws.id

  // 演示账号：ORG_VIEWER 在现有授权模型下恒只读（min(企业角色上限, 成员授权)），
  // 写操作在服务端被拒，因此演示站无需任何新代码即可保证只读。
  const existingUser = await prisma.user.findUnique({ where: { username: DEMO_USERNAME } })
  let demoUser = existingUser
  if (existingUser) {
    console.log(`✅ 演示账号已存在：${existingUser.username}（orgRole=${existingUser.orgRole}）`)
    console.log('   密码不在库中明文保存，无法二次打印；需要重置请设 DEMO_ACCOUNT_PASSWORD 后删号重建')
  } else {
    const plain = process.env.DEMO_ACCOUNT_PASSWORD || generateTempPassword()
    const passwordHash = await hashPassword(plain)
    const user = await prisma.user.create({
      data: {
        username: DEMO_USERNAME,
        displayName: '演示访客（只读）',
        passwordHash,
        userType: 'CUSTOMER',
        organizationId: org.id,
        orgRole: 'ORG_VIEWER',
        // 演示账号是一次性给访客用的，不强制改密，否则访客一登录就被拦在改密页
        mustChangePassword: false,
      },
    })
    demoUser = user
    console.log('='.repeat(52))
    console.log('🔑 演示账号已创建（密码仅打印这一次，请立即记录）')
    console.log(`   用户名：${user.username}`)
    console.log(`   密  码：${plain}`)
    console.log('='.repeat(52))
  }
  if (!demoUser) throw new Error('演示账号不存在且创建失败')

  // 工作区成员分配：CUSTOMER+VIEWER 的 resolveAccess 要求 WorkspaceMember 记录
  // （member-service：ORG_VIEWER 无记录 → null → ctx.workspace 解析失败 401）。
  // M1 期漏造此记录，演示账号只能登录、进不了工作区——2026-10-18 趋势端点验证暴露。
  // 幂等 upsert：账号已存在的重置路径同样补齐。
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: WS_ID, userId: demoUser.id } },
    create: { workspaceId: WS_ID, userId: demoUser.id, access: 'VIEW' },
    update: { access: 'VIEW' },
  })
  console.log('✅ 演示账号工作区成员记录就绪（access=VIEW）')

  // ===== ② 清空演示数据后重跑 seed =====
  console.log('\n🧹 清空演示工作区数据…')
  await truncateDemoData(WS_ID)
  console.log('   已清空')

  console.log('🌱 重跑 seed-demo.mjs…')
  runSeed()

  // ===== ③ 为种子 KG 实体 upsert 确定性向量 =====
  const entities = await prisma.kgEntity.findMany({ where: { workspaceId: WS_ID } })
  if (entities.length === 0) {
    console.error('❌ seed 后仍无 KgEntity，向量无从写入；请检查 seed 输出')
    process.exitCode = 1
    return
  }

  const dim = resolveVectorDim()
  const store = new ZvecStore()
  try {
    // 关键：collection 名取自 COLLECTIONS，不写字面量；metadata 必须带 workspaceId
    await store.upsert(store.COLLECTIONS.entities, entities.map((e) => ({
      id: e.id,
      vector: deterministicVector(e.id, dim),
      metadata: {
        workspaceId: e.workspaceId,
        sourceType: e.type,
        name: e.name,
      },
    })))

    // 非空验证：用第一个实体的向量反查，命中即说明维度/归一化/过滤三处都对齐了
    const probe = deterministicVector(entities[0].id, dim)
    const hits = await store.search(store.COLLECTIONS.entities, probe, 5, {
      workspaceId: WS_ID,
    })
    console.log(`✅ zvec 已写入 ${entities.length} 个实体向量（维度 ${dim}，L2 归一化）`)
    if (hits.length === 0) {
      console.error('❌ 反查未命中：集合名 / workspaceId 过滤 / 维度 三者存在不对齐')
      process.exitCode = 1
      return
    }
    console.log(`✅ 反查自检通过（命中 ${hits.length} 条）`)
  } finally {
    store.closeAll()
  }

  console.log('\n🎉 演示环境重置完成')
  console.log(`   企业：${org.name} / 工作区：${ws.name}（${WS_ID}）`)
  console.log(`   实体向量：${entities.length} 条 @ ${dim} 维`)
}

try {
  await main()
} catch (e) {
  console.error('重置失败：', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}

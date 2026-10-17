// ToB 平台 P0 数据迁移脚本（规格 §9.1 步骤 2/3/4），可重复执行（幂等）：
//   步骤 2：每个无 organizationId 的存量 Workspace 生成同名 Organization 并回填
//   步骤 3：Workspace.apiKeyHash 平移到 ApiCredential（keyHash 值不变，SDK 集成不中断）；
//           任务 4 删除该列后此步骤自动变为空操作（列不存在即返回 0）
//   步骤 4：明文 platformConfig 原地加密为 AES-256-GCM 信封
//
// 幂等判定：已有 organizationId / 已存在该 workspace 的 credential / isEncryptedConfig。
// 第二遍运行三步数量均应为 0。
//
// 用法: pnpm tsx scripts/migrate-tob-p0.ts
// 依赖: .env 中 DATABASE_URL 与 CREDENTIAL_MASTER_KEY（64 位 hex）

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'
import {
  encryptConfig,
  isEncryptedConfig,
  loadMasterKey,
} from '../src/core/crypto/envelope.js'

/** 迁移写入的固定操作者 ID（ApiCredential.createdById 必填，脚本执行时无真人 actor） */
const MIGRATION_ACTOR_ID = 'system-migration'

/** 平移出的 Key 展示名（规格 §9.1 步骤 3） */
const MIGRATED_KEY_NAME = '迁移的默认 Key'

/**
 * 步骤 2：为每个无 organizationId 的 Workspace 生成同名 Organization 并回填。
 * 已有 organizationId 的 workspace 跳过（幂等）。
 */
export async function backfillOrganizations(prisma: PrismaClient): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true, organizationId: true },
  })
  let created = 0
  for (const ws of workspaces) {
    if (ws.organizationId) continue // 幂等：已回填的跳过
    const org = await prisma.organization.create({ data: { name: ws.name } })
    await prisma.workspace.update({
      where: { id: ws.id },
      data: { organizationId: org.id },
    })
    created += 1
  }
  return created
}

/**
 * 步骤 3：把 Workspace.apiKeyHash 平移到 ApiCredential。
 * keyHash 值不变（现有 SDK 集成不中断）；存量 Key 无前缀（keyPrefix: null）。
 * 该 workspace 已存在 credential 时跳过（幂等）。
 * 任务 4 起 apiKeyHash 列已从 schema 删除：列不存在时本步骤无事可做，返回 0。
 */
export async function migrateApiKeys(prisma: PrismaClient): Promise<number> {
  const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'Workspace' AND column_name = 'apiKeyHash'`,
  )
  if (columns.length === 0) return 0 // 任务 4 已删列：key 均已平移或无需平移
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, apiKeyHash: true },
  })
  let migrated = 0
  for (const ws of workspaces) {
    if (!ws.apiKeyHash) continue
    const existing = await prisma.apiCredential.findFirst({
      where: { workspaceId: ws.id },
      select: { id: true },
    })
    if (existing) continue // 幂等：该 workspace 已有 credential
    await prisma.apiCredential.create({
      data: {
        workspaceId: ws.id,
        name: MIGRATED_KEY_NAME,
        keyPrefix: null,
        keyHash: ws.apiKeyHash,
        scopes: ['*'],
        createdById: MIGRATION_ACTOR_ID,
      },
    })
    migrated += 1
  }
  return migrated
}

/**
 * 步骤 4：把明文 platformConfig 原地加密为信封格式。
 * 已是信封格式（isEncryptedConfig）的跳过（幂等，防二次加密损坏数据）。
 */
export async function encryptExistingConfigs(
  prisma: PrismaClient,
  keyHex: string
): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, platformConfig: true },
  })
  let encrypted = 0
  for (const ws of workspaces) {
    // Json 列读出的值可能是字符串（已序列化）或对象（如默认 {}），统一成字符串再判断
    const raw =
      typeof ws.platformConfig === 'string'
        ? ws.platformConfig
        : JSON.stringify(ws.platformConfig ?? {})
    if (isEncryptedConfig(raw)) continue // 幂等：已是信封的跳过
    await prisma.workspace.update({
      where: { id: ws.id },
      data: { platformConfig: encryptConfig(raw, keyHex) },
    })
    encrypted += 1
  }
  return encrypted
}

/** 串联三步并打印各步数量（第二遍运行应全为 0）。 */
export async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const keyHex = loadMasterKey()
    const orgs = await backfillOrganizations(prisma)
    console.log(`[migrate-tob-p0] 步骤 2/4 Organization 回填: ${orgs} 条`)
    const keys = await migrateApiKeys(prisma)
    console.log(`[migrate-tob-p0] 步骤 3/4 apiKeyHash 平移到 ApiCredential: ${keys} 条`)
    const configs = await encryptExistingConfigs(prisma, keyHex)
    console.log(`[migrate-tob-p0] 步骤 4/4 platformConfig 原地加密: ${configs} 条`)
    console.log('[migrate-tob-p0] 完成（脚本可重入，重复执行各步应为 0）')
  } finally {
    await prisma.$disconnect()
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[migrate-tob-p0] 失败:', err)
    process.exitCode = 1
  })
}

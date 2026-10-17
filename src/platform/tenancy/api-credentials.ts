import { createHash, randomBytes } from 'node:crypto'
import type { ApiCredential, Prisma, PrismaClient, Workspace } from '@prisma/client'

/** lastUsedAt 更新节流阈值：距上次使用 ≤60s 不触发 update（与会话 lastSeenAt 同规则） */
const LAST_USED_THROTTLE_MS = 60 * 1000

/** 明文 key 前缀（品牌标识） */
const KEY_HEADER = 'geo_'
/** 随机段长度：24 字节 → 48 位 hex */
const KEY_RANDOM_BYTES = 24
/** 展示用前缀长度：`geo_ab12` 共 8 字符 */
const KEY_PREFIX_DISPLAY_LENGTH = 8

export interface ApiCredentialHit {
  credential: ApiCredential
  /** credential 绑定的工作区（status 任意——是否放行由 procedure 层矩阵判定） */
  workspace: Workspace
}

export interface IssuedCredential {
  credential: ApiCredential
  /** 一次性明文 key（仅签发瞬间返回，此后不可再取） */
  plaintext: string
}

/** 凭证脱敏视图（列表展示用，不含 keyHash） */
export type ApiCredentialSummary = Pick<
  ApiCredential,
  'id' | 'name' | 'keyPrefix' | 'lastUsedAt' | 'scopes' | 'revokedAt'
>

/**
 * 凭证不存在或已吊销错误（revoke 的 updateMany 命中 0 行时抛出）：
 * name 固定为 API_CREDENTIAL_NOT_REVOKABLE（命名错误风格同 workspace-admin）。
 */
export class ApiCredentialNotRevokableError extends Error {
  constructor(credentialId: string) {
    super(`凭证不存在或已吊销：${credentialId}`)
    this.name = 'API_CREDENTIAL_NOT_REVOKABLE'
  }
}

export interface ApiCredentialService {
  /**
   * 按明文 key 查询有效凭证：
   * - 按 sha256(key) 命中 keyHash；
   * - 已吊销（revokedAt 非空）或已过期（expiresAt 到期）视为不存在；
   * - 命中则节流更新 lastUsedAt（距上次 >60s 才写库）。
   */
  findByKey(key: string): Promise<ApiCredentialHit | null>
  /**
   * 签发新凭证：明文 `geo_` + 24 字节随机 hex；库内只存 sha256(key)、
   * keyPrefix 取明文前 8 字符（展示 `geo_ab12••••`）、scopes ["*"]。
   */
  issue(workspaceId: string, name: string, createdById: string): Promise<IssuedCredential>
  /** 按工作区列出凭证（脱敏视图，不含 keyHash），createdAt 倒序 */
  list(workspaceId: string): Promise<ApiCredentialSummary[]>
  /**
   * 吊销凭证：updateMany 乐观并发（where 含 revokedAt: null，已吊销/不存在命中 0 行），
   * 命中 0 行抛 ApiCredentialNotRevokableError；返回命中行数（成功恒 1）。
   * actorId 仅作调用方语义记录（审计由 org 层完成，本服务无 audit 依赖——与 issue 一致）。
   */
  revoke(credentialId: string, actorId: string): Promise<number>
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 程序接入凭证（SDK 通道）查询与签发服务。
 * 明文 key 仅签发瞬间可见，库内只存哈希；哈希细节收敛在本模块内。
 */
export function createApiCredentialService(prisma: PrismaClient): ApiCredentialService {
  return {
    async findByKey(key) {
      const credential = await prisma.apiCredential.findUnique({
        where: { keyHash: sha256Hex(key) },
      })
      if (!credential) return null

      const now = Date.now()
      if (credential.revokedAt !== null) return null
      if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now) return null

      // ApiCredential 无 workspace 关系字段（仅 workspaceId 标量），单独取工作区
      const workspace = await prisma.workspace.findUnique({
        where: { id: credential.workspaceId },
      })
      if (!workspace) return null

      const lastUsedMs = credential.lastUsedAt?.getTime()
      if (lastUsedMs === undefined || now - lastUsedMs > LAST_USED_THROTTLE_MS) {
        await prisma.apiCredential.update({
          where: { id: credential.id },
          data: { lastUsedAt: new Date(now) },
        })
      }

      return { credential, workspace }
    },

    async issue(workspaceId, name, createdById) {
      const plaintext = KEY_HEADER + randomBytes(KEY_RANDOM_BYTES).toString('hex')
      const credential = await prisma.apiCredential.create({
        data: {
          workspaceId,
          name,
          keyHash: sha256Hex(plaintext),
          keyPrefix: plaintext.slice(0, KEY_PREFIX_DISPLAY_LENGTH),
          scopes: ['*'] as unknown as Prisma.InputJsonValue,
          createdById,
        },
      })
      return { credential, plaintext }
    },

    async list(workspaceId) {
      return prisma.apiCredential.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          lastUsedAt: true,
          scopes: true,
          revokedAt: true,
        },
      })
    },

    async revoke(credentialId, _actorId) {
      const result = await prisma.apiCredential.updateMany({
        where: { id: credentialId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (result.count === 0) {
        throw new ApiCredentialNotRevokableError(credentialId)
      }
      return result.count
    },
  }
}

import type { PrismaClient } from '@prisma/client'
import {
  decryptConfig,
  isEncryptedConfig,
  loadMasterKey,
} from '../../core/crypto/envelope.js'

/**
 * 各平台判定"已配置"所需的凭证键（精确契约，scheduler/summary 共用）。
 * 修复存量缺陷：旧调度器只认前 4 个国内平台，Perplexity/ChatGPT/Gemini 从不被定时监测。
 */
export const REQUIRED_KEYS: Record<string, string[]> = {
  deepseek: ['DEEPSEEK_API_KEY'],
  doubao: ['DOUBAO_API_KEY'],
  qwen: ['QWEN_API_KEY'],
  ernie: ['ERNIE_API_KEY', 'ERNIE_SECRET_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  chatgpt: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
}

export interface CredentialResolverDeps {
  prisma: PrismaClient
  registry: {
    getRegisteredPlatforms: () => string[]
  }
  /** 信封主密钥；缺省时从 CREDENTIAL_MASTER_KEY 读取 */
  masterKey?: string
}

export interface CredentialResolver {
  /** 读取并解密 workspace.platformConfig，统一返回明文配置对象 */
  resolveConfig(workspaceId: string): Promise<Record<string, any>>
  /** 指定平台的凭证（未配置返回空对象） */
  getCredentials(workspaceId: string, platform: string): Promise<Record<string, string>>
  /** 平台配置概况（configured/hint）+ 竞品列表 */
  getSummary(workspaceId: string): Promise<{
    competitors: string[]
    platforms: Record<string, { configured: boolean; hint: string }>
  }>
  /** 已注册且必需键配齐的平台（定时监测范围） */
  listActivePlatforms(workspaceId: string): Promise<string[]>
}

function hasAllKeys(platformCfg: unknown, keys: string[]): boolean {
  if (platformCfg === null || typeof platformCfg !== 'object') return false
  const record = platformCfg as Record<string, unknown>
  return keys.every((k) => {
    const v = record[k]
    return typeof v === 'string' && v.length > 0
  })
}

/**
 * 凭证解析服务：统一处理 workspace.platformConfig 的信封解密，
 * 为 monitor / scheduler / executor 提供明文凭证视图。
 */
export function createCredentialResolver(deps: CredentialResolverDeps): CredentialResolver {
  const { prisma, registry } = deps
  const masterKey = deps.masterKey ?? loadMasterKey()

  async function resolveConfig(workspaceId: string): Promise<Record<string, any>> {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
    if (!workspace) {
      throw new Error(`workspace 不存在：${workspaceId}`)
    }
    const raw = workspace.platformConfig
    if (typeof raw === 'string' && isEncryptedConfig(raw)) {
      try {
        const plain = decryptConfig(raw, masterKey)
        return JSON.parse(plain) as Record<string, any>
      } catch (err) {
        throw new Error(
          `workspace ${workspaceId} platformConfig 解密/解析失败：${(err as Error).message}`
        )
      }
    }
    // 旧明文数据（对象或字符串）原样返回，null 归一为空对象
    return (raw ?? {}) as Record<string, any>
  }

  return {
    resolveConfig,

    async getCredentials(workspaceId, platform) {
      const config = await resolveConfig(workspaceId)
      const platformCfg = config[platform]
      if (platformCfg === null || typeof platformCfg !== 'object') return {}
      return platformCfg as Record<string, string>
    },

    async getSummary(workspaceId) {
      const config = await resolveConfig(workspaceId)
      const platforms: Record<string, { configured: boolean; hint: string }> = {}
      for (const [platform, keys] of Object.entries(REQUIRED_KEYS)) {
        const platformCfg = config[platform]
        const configured = hasAllKeys(platformCfg, keys)
        const firstValue =
          configured && typeof (platformCfg as Record<string, unknown>)[keys[0]] === 'string'
            ? ((platformCfg as Record<string, string>)[keys[0]] as string)
            : ''
        platforms[platform] = {
          configured,
          hint: configured ? firstValue.slice(-4) : '',
        }
      }
      const competitors = Array.isArray(config.competitors) ? config.competitors : []
      return { competitors: competitors as string[], platforms }
    },

    async listActivePlatforms(workspaceId) {
      const config = await resolveConfig(workspaceId)
      const registered = registry.getRegisteredPlatforms()
      return registered.filter(
        (platform) =>
          REQUIRED_KEYS[platform] !== undefined && hasAllKeys(config[platform], REQUIRED_KEYS[platform])
      )
    },
  }
}

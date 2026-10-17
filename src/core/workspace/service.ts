import type { PrismaClient, Workspace } from '@prisma/client'

export interface CreateWorkspaceInput {
  name: string
  defaultBrandName: string
  domain?: string
  llmsTxtUrl?: string
  platformConfig?: Record<string, unknown>
}

/**
 * Workspace.apiKeyHash 列已于 P0 任务 4 下线。
 * workspace 注册与 SDK key 认证将由任务 9/11 基于 Organization/ApiCredential 重写，
 * 在此之前相关通道一律显式抛错，避免静默失效。
 */
export const API_KEY_CHANNEL_ERROR =
  'P0 任务 9/11 重写中：apiKey 通道暂不可用（apiKeyHash 已于任务 4 下线）'

export interface WorkspaceService {
  create(input: CreateWorkspaceInput): Promise<{ workspace: Workspace; apiKey: string }>
  findByApiKey(apiKey: string): Promise<Workspace | null>
  getById(id: string): Promise<Workspace | null>
  updatePlatformConfig(id: string, config: Record<string, unknown>): Promise<Workspace>
}

export function createWorkspaceService(prisma: PrismaClient): WorkspaceService {
  return {
    // 抛错占位：真实实现（Organization + ApiCredential 签发）在任务 9/11
    async create(_input) {
      throw new Error(API_KEY_CHANNEL_ERROR)
    },

    // 抛错占位：真实实现（ApiCredential.keyHash 查询）在任务 9/11
    async findByApiKey(_apiKey) {
      throw new Error(API_KEY_CHANNEL_ERROR)
    },

    async getById(id) {
      return prisma.workspace.findUnique({ where: { id } })
    },

    async updatePlatformConfig(id, config) {
      return prisma.workspace.update({
        where: { id },
        data: { platformConfig: config as any },
      })
    },
  }
}

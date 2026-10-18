import { z } from 'zod'

/**
 * 用户名字段校验：identity router 与注册流程共用的唯一来源。
 * 提取到独立模块是为了让自助注册（publicProcedure）与登录/后台建号共用同一口径，
 * 避免两处各写一份规则悄悄漂移。
 */
export const usernameSchema = z.string().min(3).max(64)

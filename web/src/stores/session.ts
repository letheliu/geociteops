import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { trpc } from '../api/client'
import { router } from '../router'

/** auth.me 返回的工作区引用（与后端 src/platform/identity/service.ts 的 MeWorkspaceRef 对齐） */
export interface MeWorkspaceRef {
  id: string
  name: string
  /** 该用户对此 workspace 的最终权限（已合成，取值同 Prisma WorkspaceAccess 枚举） */
  access: 'MANAGE' | 'OPERATE' | 'VIEW'
}

/** auth.me 返回的当前用户信息（类型由 tRPC 客户端推导，与服务端 MeResult 对齐） */
export type MePayload = Awaited<ReturnType<typeof trpc.auth.me.query>>

/**
 * 会话 store：持有 auth.me 结果与"本次启动是否已探测过会话"标记。
 * ready 用于路由守卫——只在不 ready 时发一次 fetchMe，避免每路由一次请求。
 */
export const useSessionStore = defineStore('session', () => {
  const me = ref<MePayload | null>(null)
  const ready = ref(false)

  /** 客户用户（userType === 'CUSTOMER'）：控制台区（/console）的目标人群 */
  const isCustomer = computed(() => me.value?.userType === 'CUSTOMER')
  /** 企业管理员（orgRole === 'ORG_OWNER'）：平台用户/无角色恒 false */
  const isOrgOwner = computed(() => me.value?.orgRole === 'ORG_OWNER')
  /** 企业只读账号（orgRole === 'ORG_VIEWER'）：后端权限点恒空集（无 order.view 等），
   *  前端据此隐藏"我的订单"等入口并空态拦截直连 URL */
  const isOrgViewer = computed(() => me.value?.orgRole === 'ORG_VIEWER')

  /** 拉取当前会话用户；未登录（401 等）时置 null，无论成败都标记 ready */
  async function fetchMe(): Promise<MePayload | null> {
    try {
      me.value = await trpc.auth.me.query()
    } catch {
      me.value = null
    } finally {
      ready.value = true
    }
    return me.value
  }

  /** 登录：mutation 成功（服务端 Set-Cookie）后刷新 me */
  async function login(username: string, password: string): Promise<void> {
    await trpc.auth.login.mutate({ username, password })
    await fetchMe()
  }

  /** 登出：吊销服务端会话并清 Cookie，清空本地态后跳登录页 */
  async function logout(): Promise<void> {
    try {
      await trpc.auth.logout.mutate()
    } catch {
      // 会话已失效/网络异常也继续本地登出
    }
    me.value = null
    // 登出后状态确知（无需再探测），保持 ready=true 避免下次导航多发一次 me 请求
    ready.value = true
    router.push({ name: 'login' })
  }

  return { me, ready, isCustomer, isOrgOwner, isOrgViewer, fetchMe, login, logout }
})

import { trpc } from '../api/client'
import { router } from '../router'

/**
 * 平台管理员"进入工作区"：
 * 1. 调 admin.workspace.enter（审计 workspace.enter，platformProcedure('workspace.enter')）；
 * 2. 显式携带 params.workspaceId 跳 dashboard——此处位于 /admin 路由树，
 *    不带 params 的命名路由跳转解析不出 /console/w/:workspaceId（规格 §8.5 实测结论）。
 */
export async function enterWorkspace(id: string): Promise<void> {
  await trpc.admin.workspace.enter.mutate({ workspaceId: id })
  await router.push({ name: 'dashboard', params: { workspaceId: id } })
}

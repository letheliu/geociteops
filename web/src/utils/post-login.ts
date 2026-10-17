import type { MePayload } from '../stores/session'

/**
 * 登录/改密成功后的落点（规格 §4.1，redirect 优先级最高）：
 * 1. redirect 参数存在 → 原样返回（守卫写入的站内相对路径）；
 * 2. PLATFORM → /admin（平台管理区）；
 * 3. CUSTOMER → 恰有 1 个可用 Workspace 时直达该工作台，否则 /console（Workspace 列表，任务 8 填充）。
 *
 * me 为 null（登录成功但会话探测失败等）时兜底 /admin，由路由守卫重判会话并弹回登录页。
 * mustChangePassword 场景不在此处理：先 push 到落点，守卫强制改密时会带上 ?redirect=<落点>。
 */
export function postLoginTarget(me: MePayload | null, redirect?: string): string {
  if (redirect) return redirect
  if (!me || me.userType === 'PLATFORM') return '/admin'
  const items = me.workspaces.items
  return items.length === 1 ? `/console/w/${items[0].id}` : '/console'
}

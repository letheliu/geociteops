import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { GeoAppRouter } from '@geociteops/sdk'
import { workspaceIdHeader } from '../stores/workspace-header'

/**
 * tRPC 浏览器客户端（会话 Cookie 通道）：
 * - credentials: 'include'：携带/接收 __Host-geo_sid 会话 Cookie；
 * - x-geo-csrf：服务端 CSRF 守卫要求所有 mutation 携带（query 放行）；
 * - x-workspace-id：进入 /console/w/:workspaceId 后由路由 afterEach 写入
 *   workspaceIdHeader，服务端据此为平台用户解析目标工作区。
 */
export const trpc = createTRPCProxyClient<GeoAppRouter>({
  links: [
    httpBatchLink({
      url: `${import.meta.env.VITE_GEO_API_URL || ''}/trpc`,
      fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
      headers: () => {
        const h: Record<string, string> = { 'x-geo-csrf': '1' }
        if (workspaceIdHeader.value) h['x-workspace-id'] = workspaceIdHeader.value
        return h
      },
    }),
  ],
})

import { ref } from 'vue'

/**
 * 当前请求应携带的 x-workspace-id 头（vue ref，模块级单例）。
 *
 * 刻意不用 pinia：api/client.ts 需要读取它来构造请求头，若挂在 pinia store
 * 上会引入 client ↔ pinia（↔ router）的循环依赖。路由 afterEach 依据
 * /console/w/:workspaceId 参数写入；离开工作区路由时置 null。
 */
export const workspaceIdHeader = ref<string | null>(null)

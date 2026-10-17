import type { VectorStore } from './store.js'
import { ZvecStore } from './zvec-store.js'

let store: VectorStore | null = null

/**
 * 获取进程级单例向量存储。首次调用惰性创建 ZvecStore。
 * 业务代码统一通过此函数获取，便于测试用 setVectorStore 注入 mock。
 */
export function getVectorStore(): VectorStore {
  if (!store) {
    store = new ZvecStore()
  }
  return store
}

/** 测试钩子：注入 mock 或替换实现。 */
export function setVectorStore(s: VectorStore): void {
  store = s
}

/** 测试钩子：重置单例。若当前实例存在，先关闭已打开的资源。 */
export function resetVectorStore(): void {
  if (store) {
    store.closeAll()
  }
  store = null
}

export type { VectorStore, VectorRecord, SearchHit, SearchFilter } from './store.js'

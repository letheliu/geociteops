import type { PlatformAdapter } from './types.js'

export interface AdapterRegistry {
  register(adapter: PlatformAdapter): void
  get(name: string): PlatformAdapter | undefined
  list(): string[]
  /** list 的语义化别名：当前已注册的平台名集合 */
  getRegisteredPlatforms(): string[]
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, PlatformAdapter>()
  function names(): string[] {
    return Array.from(adapters.keys())
  }
  return {
    register(adapter) {
      adapters.set(adapter.name, adapter)
    },
    get(name) {
      return adapters.get(name)
    },
    list: names,
    getRegisteredPlatforms: names,
  }
}

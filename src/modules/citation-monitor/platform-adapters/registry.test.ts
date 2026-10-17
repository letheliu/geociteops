import { describe, it, expect, beforeEach } from 'vitest'
import { createAdapterRegistry } from './registry.js'
import type { PlatformAdapter } from './types.js'

function fakeAdapter(name: string): PlatformAdapter {
  return {
    name,
    async query() {
      return { answer: '', citations: [], mentionedBrands: [] }
    },
  }
}

describe('adapter registry', () => {
  let registry: ReturnType<typeof createAdapterRegistry>
  beforeEach(() => {
    registry = createAdapterRegistry()
  })

  it('注册并按名称获取', () => {
    const adapter = fakeAdapter('openai')
    registry.register(adapter)
    expect(registry.get('openai')).toBe(adapter)
  })

  it('获取未注册的返回 undefined', () => {
    expect(registry.get('nope')).toBeUndefined()
  })

  it('list 返回所有名称', () => {
    registry.register(fakeAdapter('openai'))
    registry.register(fakeAdapter('perplexity'))
    expect(registry.list().sort()).toEqual(['openai', 'perplexity'])
  })

  it('getRegisteredPlatforms 与 list 一致', () => {
    registry.register(fakeAdapter('openai'))
    registry.register(fakeAdapter('perplexity'))
    expect(registry.getRegisteredPlatforms().sort()).toEqual(['openai', 'perplexity'])
  })
})

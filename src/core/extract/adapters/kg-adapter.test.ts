import { describe, it, expect } from 'vitest'
import { createKgAdapter } from './kg-adapter.js'
import type { RawEntity } from '../types.js'

describe('KgTypeAdapter', () => {
  const adapter = createKgAdapter()

  it('保留所有 RawEntity 直接转换为 KgEntityDraft', () => {
    const result = adapter.adapt([
      { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { url: 'https://x.com' } },
      { name: 'Notion', rawType: '笔记软件', properties: { founded: 2016 } },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'zoomer AI',
      type: 'AI 设计工具',
      properties: { url: 'https://x.com' },
    })
    expect(result[1].type).toBe('笔记软件')
  })

  it('不丢弃未匹配的 rawType（KG 类型不受限）', () => {
    const result = adapter.adapt([
      { name: '奇怪实体', rawType: '无法识别的类型', properties: { foo: 'bar' } },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('无法识别的类型')
  })

  it('properties 字段全部保留', () => {
    const result = adapter.adapt([
      {
        name: 'x',
        rawType: 't',
        properties: { a: 1, b: true, c: 'str', d: [1, 2], e: { nested: true } },
      },
    ])
    expect(result[0].properties).toEqual({ a: 1, b: true, c: 'str', d: [1, 2], e: { nested: true } })
  })

  it('空数组输入返回空数组', () => {
    expect(adapter.adapt([])).toEqual([])
  })
})

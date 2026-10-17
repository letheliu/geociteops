import { describe, it, expect } from 'vitest'
import { getPrismaClient, resetPrismaClient } from './client.js'

describe('db client', () => {
  it('返回单例 PrismaClient 实例', () => {
    const a = getPrismaClient()
    const b = getPrismaClient()
    expect(a).toBe(b)
  })

  it('reset 后返回新实例', () => {
    const before = getPrismaClient()
    resetPrismaClient()
    const after = getPrismaClient()
    expect(after).not.toBe(before)
  })
})

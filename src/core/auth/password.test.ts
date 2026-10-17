import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, validatePasswordPolicy, generateTempPassword } from './password.js'

describe('password', () => {
  it('hashPassword/verifyPassword roundtrip', async () => {
    const hash = await hashPassword('geotest12345')
    expect(await verifyPassword(hash, 'geotest12345')).toBe(true)
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false)
  })
  it('策略：长度 <10、与用户名相同均拒绝', () => {
    expect(validatePasswordPolicy('short1', 'alice')).toEqual({ ok: false, reason: expect.any(String) })
    expect(validatePasswordPolicy('alicealice1', 'alice')).toEqual({ ok: false, reason: expect.any(String) })
    expect(validatePasswordPolicy('alicealice1', 'alice-x')).toEqual({ ok: true })
  })
  it('generateTempPassword 满足策略且每次不同', async () => {
    const p1 = generateTempPassword(), p2 = generateTempPassword()
    expect(validatePasswordPolicy(p1, 'x').ok).toBe(true)
    expect(p1).not.toBe(p2)
  })
})

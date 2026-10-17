import { describe, expect, it } from 'vitest'
import { billingEnforcementEnabled } from './enforcement.js'

describe('billingEnforcementEnabled', () => {
  it('BILLING_ENFORCEMENT=on / true → 开启', () => {
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: 'on' })).toBe(true)
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: 'true' })).toBe(true)
  })

  it('缺省 / off / false / 其他值 → 关闭', () => {
    expect(billingEnforcementEnabled({})).toBe(false)
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: undefined })).toBe(false)
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: 'off' })).toBe(false)
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: 'false' })).toBe(false)
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: 'ON' })).toBe(false)
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: '1' })).toBe(false)
  })

  it('显式 env 对象优先于 process.env（不污染全局）', () => {
    expect(billingEnforcementEnabled({ BILLING_ENFORCEMENT: 'on' })).toBe(true)
    // process.env 未设置时（测试环境），缺省调用读全局
    const prev = process.env.BILLING_ENFORCEMENT
    process.env.BILLING_ENFORCEMENT = 'on'
    try {
      expect(billingEnforcementEnabled()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENFORCEMENT
      else process.env.BILLING_ENFORCEMENT = prev
    }
  })
})

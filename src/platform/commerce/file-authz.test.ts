import { describe, expect, it, vi } from 'vitest'
import { canAccessFile } from './file-authz.js'

// ---------------------------------------------------------------------------
// 遗留 A1：/files/:key 归属校验。mock prisma 有状态（user /
// paymentTransaction / invoice 各自内存表），验证四类路径：
// 平台员工放行 / 本 org 回单放行 / 他 org 回单拒 / 发票同理 / 无主 key 拒。
// ---------------------------------------------------------------------------

const KEY = '0123456789abcdef0123456789abcdef.png'

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    userType: 'CUSTOMER',
    organizationId: 'org-a',
    ...overrides,
  }
}

interface DbState {
  users?: Record<string, unknown>[]
  payments?: Record<string, unknown>[]
  invoices?: Record<string, unknown>[]
}

function makeDb(state: DbState = {}) {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        (state.users ?? [makeUser()]).find((u) => u.id === where.id) ?? null,
      ),
    },
    paymentTransaction: {
      findFirst: vi.fn(async ({ where }: { where: { voucherFileKey?: string } }) =>
        (state.payments ?? []).find((p) => p.voucherFileKey === where.voucherFileKey) ?? null,
      ),
    },
    invoice: {
      findFirst: vi.fn(async ({ where }: { where: { fileKey?: string } }) =>
        (state.invoices ?? []).find((i) => i.fileKey === where.fileKey) ?? null,
      ),
    },
  }
}

describe('canAccessFile：回单（PaymentTransaction.voucherFileKey）', () => {
  it('本 org 客户成员下载本 org 回单 → true（经订单 organizationId 比对）', async () => {
    const db = makeDb({
      payments: [{ voucherFileKey: KEY, order: { organizationId: 'org-a' } }],
    })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(true)
  })

  it('org A 成员取 org B 回单 → false（key 是能力 URL，不泄露存在性——路由侧统一 404）', async () => {
    const db = makeDb({
      payments: [{ voucherFileKey: KEY, order: { organizationId: 'org-b' } }],
    })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(false)
  })

  it('无 organizationId 的客户用户（数据异常）→ false（=== 比对 null 不等于任何 org）', async () => {
    const db = makeDb({
      users: [makeUser({ organizationId: null })],
      payments: [{ voucherFileKey: KEY, order: { organizationId: 'org-a' } }],
    })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(false)
  })
})

describe('canAccessFile：发票（Invoice.fileKey）', () => {
  it('本 org 发票 → true（发票自带 organizationId 列，不经订单）', async () => {
    const db = makeDb({
      invoices: [{ fileKey: KEY, organizationId: 'org-a' }],
    })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(true)
  })

  it('他 org 发票 → false', async () => {
    const db = makeDb({
      invoices: [{ fileKey: KEY, organizationId: 'org-b' }],
    })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(false)
  })
})

describe('canAccessFile：平台员工与边界', () => {
  it('PLATFORM 员工跨企业放行 → true（运营/财务下载回单与发票的路径，不查两表）', async () => {
    const db = makeDb({
      users: [makeUser({ id: 'fin-1', userType: 'PLATFORM', organizationId: null })],
    })
    await expect(canAccessFile(db as never, 'fin-1', KEY)).resolves.toBe(true)
    expect(db.paymentTransaction.findFirst).not.toHaveBeenCalled()
    expect(db.invoice.findFirst).not.toHaveBeenCalled()
  })

  it('无主 key（两表都不命中）→ false', async () => {
    const db = makeDb({ payments: [], invoices: [] })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(false)
  })

  it('用户不存在（会话指向已删用户）→ false（防御，不抛错）', async () => {
    const db = makeDb({ users: [] })
    await expect(canAccessFile(db as never, 'u-gone', KEY)).resolves.toBe(false)
    expect(db.paymentTransaction.findFirst).not.toHaveBeenCalled()
  })

  it('回单他 org 但发票本 org → true（两锚独立判定，任一命中即放行）', async () => {
    const db = makeDb({
      payments: [{ voucherFileKey: KEY, order: { organizationId: 'org-b' } }],
      invoices: [{ fileKey: KEY, organizationId: 'org-a' }],
    })
    await expect(canAccessFile(db as never, 'u1', KEY)).resolves.toBe(true)
  })
})

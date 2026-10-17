import { describe, expect, it, vi } from 'vitest'
import { auditRouter } from './router.js'

function makeAuditService() {
  return { record: vi.fn(), list: vi.fn(async () => ({ items: [], total: 0 })) }
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const audit = makeAuditService()
  return {
    ctx: {
      actor: {
        kind: 'user',
        user: {
          id: 'user-1',
          userType: 'PLATFORM',
          platformRole: 'SUPER_ADMIN',
          mustChangePassword: false,
        },
        session: { id: 'sess-1' },
      },
      requestMeta: {
        ip: '1.2.3.4',
        requestId: 'req-1',
        headers: { 'x-geo-csrf': 'test' },
      },
      services: { audit },
      ...overrides,
    } as any,
    audit,
  }
}

describe('auditRouter（createCaller）', () => {
  it('list：service 从 ctx.services.audit 取，透传过滤与分页', async () => {
    const { ctx, audit } = makeCtx()
    const caller = auditRouter.createCaller(ctx)
    await caller.list({ page: 2, pageSize: 50, action: 'user.login' })
    expect(audit.list).toHaveBeenCalledWith({
      page: 2,
      pageSize: 50,
      action: 'user.login',
    })
  })

  it('list：无入参走默认分页', async () => {
    const { ctx, audit } = makeCtx()
    const caller = auditRouter.createCaller(ctx)
    await caller.list()
    expect(audit.list).toHaveBeenCalledWith({})
  })

  it('无 platformRole → FORBIDDEN（platformProcedure 拦截）', async () => {
    const { ctx } = makeCtx({
      actor: {
        kind: 'user',
        user: { id: 'u9', userType: 'PLATFORM', platformRole: null, mustChangePassword: false },
        session: { id: 's' },
      },
    })
    const caller = auditRouter.createCaller(ctx)
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('OPERATOR 具备 audit.view → 放行', async () => {
    const { ctx } = makeCtx({
      actor: {
        kind: 'user',
        user: { id: 'u9', userType: 'PLATFORM', platformRole: 'OPERATOR', mustChangePassword: false },
        session: { id: 's' },
      },
    })
    const caller = auditRouter.createCaller(ctx)
    await expect(caller.list()).resolves.toEqual({ items: [], total: 0 })
  })
})

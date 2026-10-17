import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { VOUCHER_MAX_BYTES } from './order-service.js'
import type { FilesService } from './files.js'
import {
  createInvoiceService,
  InvoiceNoConflictError,
  InvoiceNotFoundError,
  InvoiceStateError,
  InvalidInvoiceFileError,
  OrderNotPaidError,
} from './invoice-service.js'

/**
 * 任务 13：手工发票服务（§6.3 发票 P2=手工）。
 * 模式照 refund-service.test.ts：mock prisma + mock files + mock audit，
 * 真实 InvoiceService（建在 mock 之上）。
 */

const NOW = new Date('2026-10-15T12:00:00.000Z')

const BILLING_PROFILE = {
  title: '杭州某某科技有限公司',
  taxNo: '91330100MA27X8888X',
  address: '杭州市余杭区文一西路 998 号',
  phone: '0571-88888888',
  bank: '招商银行杭州分行',
  account: '571908888666',
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNo: 'GEO261015ab12cd34',
    organizationId: 'org-1',
    status: 'COMPLETED',
    totalCents: 30000,
    discountCents: 0,
    payableCents: 30000,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: 'WECHAT',
    dueAt: null,
    paidAt: new Date('2026-10-05T12:00:00.000Z'),
    remark: null,
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    ...overrides,
  }
}

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    name: '杭州某某科技有限公司',
    creditCode: '91330100MA27X8888X',
    industry: null,
    status: 'ACTIVE',
    billingProfile: BILLING_PROFILE,
    ownerOperatorId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    organizationId: 'org-1',
    orderIds: ['o1'],
    titleSnapshot: BILLING_PROFILE,
    amountCents: 30000,
    currency: 'CNY',
    status: 'PENDING',
    invoiceNo: null,
    fileKey: null,
    requestedById: 'u1',
    issuedById: null,
    remark: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

interface PrismaOpts {
  orders?: Record<string, unknown>[]
  org?: Record<string, unknown> | null
  invoice?: Record<string, unknown> | null
  /** invoiceNo 预查命中行（非 null = 冲突） */
  invoiceNoTaken?: Record<string, unknown> | null
}

function makePrisma(opts: PrismaOpts = {}) {
  // updateMany 落库回读模拟（遗留 C12：issue/reject 事务后 findUnique 回读真实行态）：
  // 按 id 记录已应用的 data 覆盖层，后续 findUnique(id) 合并返回"更新后"的行
  const applied = new Map<string, Record<string, unknown>>()
  const prisma: any = {
    order: {
      findMany: vi.fn(async () => opts.orders ?? [makeOrder()]),
    },
    organization: {
      findUnique: vi.fn(async () => (opts.org === undefined ? makeOrg() : opts.org)),
    },
    invoice: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.invoiceNo !== undefined) {
          return opts.invoiceNoTaken === undefined ? null : opts.invoiceNoTaken
        }
        // id 读取缺省返回 inv-1/PENDING（issue/reject 主路径）；不存在用例传 invoice: null
        const base = opts.invoice === undefined ? makeInvoice() : opts.invoice
        if (!base) return base
        const overlay = applied.get(String(where.id))
        return overlay ? { ...base, ...overlay } : base
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv-new-1',
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          applied.set(where.id, { ...(applied.get(where.id) ?? {}), ...data })
          return { count: 1 }
        },
      ),
    },
  }
  return prisma as PrismaClient & any
}

function makeFiles(putResult = '0123456789abcdef0123456789abcdef.pdf') {
  return {
    put: vi.fn(async () => putResult),
    remove: vi.fn(async () => {}),
    resolvePath: vi.fn(),
  } as unknown as FilesService & {
    put: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }
}

function makeAudit() {
  return { record: vi.fn(async () => {}), list: vi.fn() }
}

let prisma: ReturnType<typeof makePrisma>
let files: ReturnType<typeof makeFiles>
let audit: ReturnType<typeof makeAudit>

beforeEach(() => {
  prisma = makePrisma()
  files = makeFiles()
  audit = makeAudit()
})

function buildService() {
  return createInvoiceService({
    prisma,
    files,
    audit: audit as never,
  })
}

// ---------------------------------------------------------------------------
// request（客户申请）
// ---------------------------------------------------------------------------

describe('InvoiceService.request', () => {
  it('两张已支付订单合并申请：amountCents=Σ payableCents + titleSnapshot=billingProfile 快照 + PENDING + audit', async () => {
    prisma.order.findMany.mockResolvedValue([
      makeOrder(),
      makeOrder({ id: 'o2', payableCents: 12000 }),
    ])

    const result = await buildService().request({ orderIds: ['o1', 'o2'] }, 'u1', 'org-1')

    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        orderIds: ['o1', 'o2'],
        titleSnapshot: BILLING_PROFILE,
        amountCents: 42000,
        currency: 'CNY',
        status: 'PENDING',
        requestedById: 'u1',
      },
    })
    expect(result.invoice).toMatchObject({ status: 'PENDING', amountCents: 42000 })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'USER',
        actorId: 'u1',
        action: 'invoice.request',
        organizationId: 'org-1',
        target: 'Invoice:inv-new-1',
      }),
    )
  })

  it('orderIds 去重：同订单重复传入金额只计一次、落库去重', async () => {
    await buildService().request({ orderIds: ['o1', 'o1', 'o1'] }, 'u1', 'org-1')

    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderIds: ['o1'], amountCents: 30000 }),
    })
  })

  it('未支付订单（paidAt=null）→ OrderNotPaidError 含违规 orderId 列表，不建行不审计', async () => {
    prisma.order.findMany.mockResolvedValue([
      makeOrder(),
      makeOrder({ id: 'o2', paidAt: null }),
    ])

    await expect(
      buildService().request({ orderIds: ['o1', 'o2'] }, 'u1', 'org-1'),
    ).rejects.toMatchObject({ name: 'ORDER_NOT_PAID', orderIds: ['o2'] })
    expect(prisma.invoice.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('越权 / 不存在：属他企业（org-2）与不存在的订单同入违规列表（不泄露存在性差异）', async () => {
    prisma.order.findMany.mockResolvedValue([makeOrder({ id: 'o9', organizationId: 'org-2' })])

    await expect(
      buildService().request({ orderIds: ['o9', 'o-x'] }, 'u1', 'org-1'),
    ).rejects.toMatchObject({ name: 'ORDER_NOT_PAID', orderIds: ['o9', 'o-x'] })
    expect(prisma.invoice.create).not.toHaveBeenCalled()
  })

  it('全额退款订单（REFUNDED，paidAt 仍在）→ OrderNotPaidError（遗留 A4：分文未留不可开票）', async () => {
    prisma.order.findMany.mockResolvedValue([
      makeOrder(),
      makeOrder({ id: 'o3', status: 'REFUNDED', refundedCents: 30000 }),
    ])

    await expect(
      buildService().request({ orderIds: ['o1', 'o3'] }, 'u1', 'org-1'),
    ).rejects.toMatchObject({ name: 'ORDER_NOT_PAID', orderIds: ['o3'] })
    expect(prisma.invoice.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('部分退款订单（PARTIALLY_REFUNDED）保留可开票（裁定：大部分款项已收，金额语义由财务把握）', async () => {
    prisma.order.findMany.mockResolvedValue([
      makeOrder({ status: 'PARTIALLY_REFUNDED', refundedCents: 12000 }),
    ])

    const result = await buildService().request({ orderIds: ['o1'] }, 'u1', 'org-1')

    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderIds: ['o1'], amountCents: 30000, status: 'PENDING' }),
    })
    expect(result.invoice.status).toBe('PENDING')
  })

  it('空 billingProfile（默认 {}）→ titleSnapshot 原样存空对象（客户可后补抬头）', async () => {
    prisma.organization.findUnique.mockResolvedValue(makeOrg({ billingProfile: {} }))

    await buildService().request({ orderIds: ['o1'] }, 'u1', 'org-1')

    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ titleSnapshot: {} }),
    })
  })

  it('同一订单已有 PENDING 发票未处理时再次申请：放行（裁定：P2 手工流程财务人工把关，不防重）', async () => {
    const result = await buildService().request({ orderIds: ['o1'] }, 'u1', 'org-1')

    expect(prisma.invoice.create).toHaveBeenCalledTimes(1)
    expect(result.invoice.status).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// issue（财务签发登记）
// ---------------------------------------------------------------------------

describe('InvoiceService.issue', () => {
  it('签发含 PDF：files.put → fileKey + ISSUED + invoiceNo + issuedById + audit invoice.issue；返回值为事务后回读行（遗留 C12）', async () => {
    const contentBase64 = Buffer.from('%PDF-1.4 fake invoice', 'utf8').toString('base64')

    const result = await buildService().issue(
      'inv-1',
      { invoiceNo: 'INV-20261015-001', fileName: '发票.pdf', contentBase64 },
      'fin-1',
    )

    expect(files.put).toHaveBeenCalledTimes(1)
    const [buffer, ext] = files.put.mock.calls[0]
    expect(buffer.toString('utf8')).toBe('%PDF-1.4 fake invoice')
    expect(ext).toBe('pdf')
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: {
        status: 'ISSUED',
        invoiceNo: 'INV-20261015-001',
        fileKey: '0123456789abcdef0123456789abcdef.pdf',
        issuedById: 'fin-1',
      },
    })
    expect(result.invoice).toMatchObject({
      status: 'ISSUED',
      invoiceNo: 'INV-20261015-001',
      fileKey: '0123456789abcdef0123456789abcdef.pdf',
      issuedById: 'fin-1',
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invoice.issue',
        actorId: 'fin-1',
        organizationId: 'org-1',
        target: 'Invoice:inv-1',
      }),
    )
  })

  it('纯登记（无 contentBase64）：fileKey 保持 null；返回值为回读行（status=ISSUED 落库后形态）', async () => {
    const result = await buildService().issue(
      'inv-1',
      { invoiceNo: 'INV-20261015-002' },
      'fin-1',
    )

    expect(files.put).not.toHaveBeenCalled()
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: expect.objectContaining({ fileKey: null }),
    })
    expect(result.invoice).toMatchObject({ status: 'ISSUED', invoiceNo: 'INV-20261015-002' })
    expect(result.invoice.fileKey).toBeNull()
  })

  it('并发失闸（updateMany count=0，遗留 C7）→ InvoiceStateError 整体拒绝：不回读不审计', async () => {
    prisma.invoice.updateMany.mockReturnValueOnce(Promise.resolve({ count: 0 }))

    await expect(
      buildService().issue('inv-1', { invoiceNo: 'INV-20261015-003' }, 'fin-1'),
    ).rejects.toMatchObject({ name: 'INVOICE_STATE' })
    expect(prisma.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(audit.record).not.toHaveBeenCalled()
    // 回读未发生：findUnique 仅两次（主路径行读取 + invoiceNo 预查），无第三次
    expect(prisma.invoice.findUnique).toHaveBeenCalledTimes(2)
  })

  // ----- 遗留 D6：落库失败后的孤儿 PDF 清理（unlink 尽力而为） -----

  it('遗留 D6：写盘后落库失败（并发失闸 count=0）且已上传 PDF → InvoiceStateError + 孤儿文件被清理（remove 收 put 产出的 key）', async () => {
    prisma.invoice.updateMany.mockReturnValueOnce(Promise.resolve({ count: 0 }))
    const contentBase64 = Buffer.from('%PDF-1.4 fake invoice', 'utf8').toString('base64')

    await expect(
      buildService().issue(
        'inv-1',
        { invoiceNo: 'INV-20261015-004', fileName: '发票.pdf', contentBase64 },
        'fin-1',
      ),
    ).rejects.toMatchObject({ name: 'INVOICE_STATE' })
    expect(files.put).toHaveBeenCalledTimes(1)
    expect(files.remove).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef.pdf')
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('遗留 D6：P2002 唯一冲突且已上传 PDF → InvoiceNoConflictError + 孤儿文件被清理', async () => {
    prisma.invoice.updateMany.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed on the fields: (`invoiceNo`)'), {
        code: 'P2002',
      }),
    )
    const contentBase64 = Buffer.from('%PDF-1.4 fake invoice', 'utf8').toString('base64')

    await expect(
      buildService().issue(
        'inv-1',
        { invoiceNo: 'INV-20261015-005', fileName: '发票.pdf', contentBase64 },
        'fin-1',
      ),
    ).rejects.toMatchObject({ name: 'INVOICE_NO_CONFLICT' })
    expect(files.remove).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef.pdf')
  })

  it('遗留 D6：清理自身失败（remove 抛错）仅日志，原 InvoiceStateError 照常上抛不被掩盖', async () => {
    prisma.invoice.updateMany.mockReturnValueOnce(Promise.resolve({ count: 0 }))
    files.remove.mockRejectedValueOnce(new Error('EPERM: operation not permitted'))
    const contentBase64 = Buffer.from('%PDF-1.4 fake invoice', 'utf8').toString('base64')

    await expect(
      buildService().issue(
        'inv-1',
        { invoiceNo: 'INV-20261015-006', fileName: '发票.pdf', contentBase64 },
        'fin-1',
      ),
    ).rejects.toMatchObject({ name: 'INVOICE_STATE' })
  })

  it('遗留 D6：纯登记（无 PDF）失闸 → 不触 files.remove；成功路径同样不清理', async () => {
    prisma.invoice.updateMany.mockReturnValueOnce(Promise.resolve({ count: 0 }))
    await expect(
      buildService().issue('inv-1', { invoiceNo: 'INV-20261015-007' }, 'fin-1'),
    ).rejects.toMatchObject({ name: 'INVOICE_STATE' })
    expect(files.remove).not.toHaveBeenCalled()

    const ok = await buildService().issue('inv-1', { invoiceNo: 'INV-20261015-008' }, 'fin-1')
    expect(ok.invoice.status).toBe('ISSUED')
    expect(files.remove).not.toHaveBeenCalled()
  })

  it('invoiceNo 已被占用（预查命中）→ InvoiceNoConflictError，不写库不传文件', async () => {
    prisma.invoice.findUnique.mockImplementation(async ({ where }: never) =>
      where?.invoiceNo !== undefined
        ? makeInvoice({ id: 'inv-other', invoiceNo: 'INV-20261015-001', status: 'ISSUED' })
        : makeInvoice(),
    )

    await expect(
      buildService().issue('inv-1', { invoiceNo: 'INV-20261015-001' }, 'fin-1'),
    ).rejects.toMatchObject({ name: 'INVOICE_NO_CONFLICT' })
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled()
    expect(files.put).not.toHaveBeenCalled()
  })

  it('invoiceNo 唯一冲突竞态（P2002）→ InvoiceNoConflictError', async () => {
    prisma.invoice.findUnique.mockImplementation(async ({ where }: never) =>
      where?.invoiceNo !== undefined ? null : makeInvoice(),
    )
    prisma.invoice.updateMany.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed on the fields: (`invoiceNo`)'), {
        code: 'P2002',
      }),
    )

    await expect(
      buildService().issue('inv-1', { invoiceNo: 'INV-20261015-001' }, 'fin-1'),
    ).rejects.toMatchObject({ name: 'INVOICE_NO_CONFLICT' })
  })

  it('非 PENDING（已签发）→ InvoiceStateError，不触 files.put', async () => {
    prisma.invoice.findUnique.mockImplementation(async ({ where }: never) =>
      where?.invoiceNo !== undefined
        ? null
        : makeInvoice({ status: 'ISSUED', invoiceNo: 'INV-OLD-1', issuedById: 'fin-0' }),
    )

    await expect(
      buildService().issue('inv-1', { invoiceNo: 'INV-20261015-001' }, 'fin-1'),
    ).rejects.toMatchObject({ name: 'INVOICE_STATE' })
    expect(files.put).not.toHaveBeenCalled()
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled()
  })

  it('发票不存在 → InvoiceNotFoundError', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null)
    await expect(
      buildService().issue('inv-x', { invoiceNo: 'INV-1' }, 'fin-1'),
    ).rejects.toMatchObject({ name: 'INVOICE_NOT_FOUND' })
  })

  it('扩展名白名单外（exe）→ InvalidInvoiceFileError，不触 files.put', async () => {
    await expect(
      buildService().issue(
        'inv-1',
        {
          invoiceNo: 'INV-1',
          fileName: '发票.exe',
          contentBase64: Buffer.from('x').toString('base64'),
        },
        'fin-1',
      ),
    ).rejects.toMatchObject({ name: 'INVALID_INVOICE_FILE' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('contentBase64 非法（不是 base64）→ InvalidInvoiceFileError', async () => {
    await expect(
      buildService().issue(
        'inv-1',
        { invoiceNo: 'INV-1', fileName: '发票.pdf', contentBase64: '不是base64！！' },
        'fin-1',
      ),
    ).rejects.toMatchObject({ name: 'INVALID_INVOICE_FILE' })
  })

  it('解码后超 7MB → InvalidInvoiceFileError', async () => {
    await expect(
      buildService().issue(
        'inv-1',
        {
          invoiceNo: 'INV-1',
          fileName: '发票.pdf',
          contentBase64: Buffer.alloc(VOUCHER_MAX_BYTES + 1, 1).toString('base64'),
        },
        'fin-1',
      ),
    ).rejects.toMatchObject({ name: 'INVALID_INVOICE_FILE' })
  })
})

// ---------------------------------------------------------------------------
// reject（财务驳回）
// ---------------------------------------------------------------------------

describe('InvoiceService.reject', () => {
  it('驳回：REJECTED + remark=reason + audit invoice.reject；返回值为事务后回读行（遗留 C12）', async () => {
    const result = await buildService().reject('inv-1', '抬头信息不全，请补充后重新申请', 'fin-1')

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: { status: 'REJECTED', remark: '抬头信息不全，请补充后重新申请' },
    })
    expect(result.invoice).toMatchObject({ status: 'REJECTED', remark: '抬头信息不全，请补充后重新申请' })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invoice.reject',
        actorId: 'fin-1',
        organizationId: 'org-1',
        target: 'Invoice:inv-1',
      }),
    )
  })

  it('并发失闸（updateMany count=0，遗留 C7）→ InvoiceStateError 整体拒绝：不回读不审计', async () => {
    prisma.invoice.updateMany.mockReturnValueOnce(Promise.resolve({ count: 0 }))

    await expect(buildService().reject('inv-1', 'x', 'fin-1')).rejects.toMatchObject({
      name: 'INVOICE_STATE',
    })
    expect(audit.record).not.toHaveBeenCalled()
    // 回读未发生：findUnique 仅主路径一次
    expect(prisma.invoice.findUnique).toHaveBeenCalledTimes(1)
  })

  it('非 PENDING → InvoiceStateError', async () => {
    prisma.invoice.findUnique.mockResolvedValue(makeInvoice({ status: 'ISSUED' }))

    await expect(buildService().reject('inv-1', 'x', 'fin-1')).rejects.toMatchObject({
      name: 'INVOICE_STATE',
    })
  })

  it('不存在 → InvoiceNotFoundError', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null)
    await expect(buildService().reject('inv-x', 'x', 'fin-1')).rejects.toMatchObject({
      name: 'INVOICE_NOT_FOUND',
    })
  })
})

// ---------------------------------------------------------------------------
// list / listAll
// ---------------------------------------------------------------------------

describe('InvoiceService.list / listAll', () => {
  it('list：按企业 + status 筛选 + 分页，createdAt desc', async () => {
    prisma.invoice.findMany.mockResolvedValue([makeInvoice()])
    prisma.invoice.count.mockResolvedValue(1)

    const result = await buildService().list('org-1', { status: 'PENDING', page: 2, pageSize: 50 })

    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      skip: 50,
      take: 50,
    })
    expect(result).toMatchObject({ total: 1 })
    expect(result.items[0]).toMatchObject({ id: 'inv-1', organizationId: 'org-1' })
  })

  it('list 缺省：全状态 + page 1 / pageSize 20', async () => {
    await buildService().list('org-1')

    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    })
  })

  it('listAll：平台侧不按企业过滤，status 可选', async () => {
    await buildService().listAll({ status: 'ISSUED' })

    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { status: 'ISSUED' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    })
  })
})

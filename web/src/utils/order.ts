/**
 * 订单展示辅助（任务 14）：9 态状态标签色阶与支付方式中文文案，
 * Orders 列表页与 OrderDetail 详情页共用（单一来源防两处漂移）。
 */
export interface StatusMeta {
  type: 'success' | 'info' | 'warning' | 'error' | 'default'
  label: string
}

/** OrderStatus（9 态）→ NTag type + 中文标签 */
export const ORDER_STATUS_META: Record<string, StatusMeta> = {
  PENDING_PAYMENT: { type: 'warning', label: '待支付' },
  PENDING_CONFIRMATION: { type: 'info', label: '待确认收款' },
  PAID: { type: 'success', label: '已支付' },
  FULFILLING: { type: 'info', label: '服务履行中' },
  COMPLETED: { type: 'success', label: '已完成' },
  CANCELLED: { type: 'default', label: '已取消' },
  REFUNDING: { type: 'warning', label: '退款审批中' },
  REFUNDED: { type: 'error', label: '已退款' },
  PARTIALLY_REFUNDED: { type: 'warning', label: '部分退款' },
}

export function orderStatusMeta(status: string): StatusMeta {
  return ORDER_STATUS_META[status] ?? { type: 'default', label: status }
}

/** PaymentMethod → 中文文案 */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  BANK_TRANSFER: '对公转账',
  CONTRACT_CREDIT: '合同账期',
  WECHAT: '微信支付',
  ALIPAY: '支付宝',
}

export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return '—'
  return PAYMENT_METHOD_LABEL[method] ?? method
}

/** PaymentStatus → 中文文案（支付流水状态，平台侧订单详情/收款工作台用） */
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待确认',
  SUCCEEDED: '已到账',
  FAILED: '已失败',
  REFUNDED: '已退款',
}

export function paymentStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return PAYMENT_STATUS_LABEL[status] ?? status
}

/** OrderEvent.event → 中文标签（客户侧/平台侧订单详情时间线共用） */
export const ORDER_EVENT_LABEL: Record<string, string> = {
  create: '订单创建',
  cancel: '取消订单',
  'voucher.upload': '回单上传',
  'finance.reject': '财务驳回回单',
  'payment.confirmed': '收款确认',
  'credit.open': '合同账期开通',
  'activate.start': '服务开通处理',
  'fulfill.complete': '履行完成',
  'refund.request': '申请退款',
  'refund.full': '全额退款',
  'refund.partial': '部分退款',
  'refund.reopen': '再次申请退款',
  'refund.reject': '退款驳回',
}

export function orderEventLabel(event: string): string {
  return ORDER_EVENT_LABEL[event] ?? event
}

/** RefundStatus → NTag type + 中文标签（平台侧退款工作台） */
export function refundStatusMeta(status: string): StatusMeta {
  const map: Record<string, StatusMeta> = {
    PENDING: { type: 'warning', label: '待审批' },
    EXECUTED: { type: 'success', label: '已执行' },
    REJECTED: { type: 'error', label: '已驳回' },
  }
  return map[status] ?? { type: 'default', label: status }
}

/** InvoiceStatus → NTag type + 中文标签（客户侧/平台侧发票页共用） */
export function invoiceStatusMeta(status: string): StatusMeta {
  const map: Record<string, StatusMeta> = {
    PENDING: { type: 'warning', label: '待开具' },
    ISSUED: { type: 'success', label: '已开具' },
    REJECTED: { type: 'error', label: '已驳回' },
  }
  return map[status] ?? { type: 'default', label: status }
}

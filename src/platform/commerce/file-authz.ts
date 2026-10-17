import type { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// 文件下载归属校验（遗留 A1）：/files/:key 能力 URL 的越权面收口。
// 回单（PaymentTransaction.voucherFileKey）含银行账户信息，发票 PDF
// （Invoice.fileKey）同理——任意有效会话持 key 即可下载不可接受。
// 规则：平台员工（userType=PLATFORM）放行；客户用户（CUSTOMER）仅当
// key 命中的回单/发票归属其 organizationId 才放行；无主 key 一律 false。
// 返回布尔而非抛错：路由侧与"文件不存在"统一 404（不泄露存在性差异）。
// ---------------------------------------------------------------------------

/** canAccessFile 的 prisma 查询端（全客户端或任意携带两模型的部分客户端） */
export type FileAuthzDb = Pick<PrismaClient, 'user' | 'paymentTransaction' | 'invoice'>

/**
 * key 是否属于该用户可见范围：
 * 1. 用户不存在 → false（防御：会话刚被删等）；
 * 2. PLATFORM → true（平台员工跨企业可见，运营/财务下载回单与发票的路径）；
 * 3. CUSTOMER → 回单（voucherFileKey）经订单 organizationId 比对，或
 *    发票（fileKey）直接 organizationId 比对，任一命中 → true；
 * 4. 两处都不匹配（他人 key / 无主 key）→ false。
 */
export async function canAccessFile(
  db: FileAuthzDb,
  userId: string,
  key: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { userType: true, organizationId: true },
  })
  if (!user) return false
  if (user.userType === 'PLATFORM') return true

  // 回单：voucherFileKey → 订单归属。key 形态 32 位十六进制（files service 产出），
  // @unique 级不撞——findFirst 足够（无并发写同一 key 的多行语义）
  const voucher = await db.paymentTransaction.findFirst({
    where: { voucherFileKey: key },
    select: { order: { select: { organizationId: true } } },
  })
  if (voucher?.order.organizationId === user.organizationId) return true

  // 发票：fileKey → 发票归属（发票自带 organizationId 列，无需经订单）
  const invoice = await db.invoice.findFirst({
    where: { fileKey: key },
    select: { organizationId: true },
  })
  if (invoice?.organizationId === user.organizationId) return true

  return false
}

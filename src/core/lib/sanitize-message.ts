/**
 * 失败信息脱敏（规格 §10）：CitationEvent.failureReason / analysis.error 与
 * CitationRun.failureReason 都要经过它，避免平台报错原文里的凭证落库。
 *
 * 实现自 `src/modules/diagnostic/executor.ts` 的私有函数**原样提炼**——
 * 诊断模块改为从这里 re-export，两边行为完全一致，不引入第二套脱敏规则。
 */

/** 遮蔽 ≥20 字符的字母数字串（API key / 长令牌 / URL 路径里的长段），并截断到 500 字符 */
export function sanitizeMessage(err: string | unknown): string {
  const msg = typeof err === 'string' ? err : ((err as { message?: unknown })?.message ?? String(err))
  return String(msg).replace(/[A-Za-z0-9-_]{20,}/g, '[REDACTED]').slice(0, 500)
}

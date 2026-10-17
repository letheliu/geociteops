// ---------------------------------------------------------------------------
// 计费 enforcement 总开关（Ruling 1）：BILLING_ENFORCEMENT === 'on' | 'true' 时
// 硬检查/平台检查/软检查告警生效；其余值（含缺省）一律关闭——guard 全放行。
// 业务代码不感知开关：判定收敛在 guard 内部（off 时 meter.record 仍照记）。
// ---------------------------------------------------------------------------

/** 计费 enforcement 是否开启（缺省读 process.env，可注入 env 便于测试） */
export function billingEnforcementEnabled(
  env: { BILLING_ENFORCEMENT?: string } = process.env,
): boolean {
  const value = env.BILLING_ENFORCEMENT
  return value === 'on' || value === 'true'
}

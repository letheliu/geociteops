import { randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

/** 密码最小长度 */
const MIN_LENGTH = 10

/** 参与包含性检查的最短用户名长度（平台用户名下限为 3，见 identity 路由 zod 校验） */
const CONTAINMENT_MIN_USERNAME_LENGTH = 3

/** 临时密码长度 */
const TEMP_PASSWORD_LENGTH = 12

/** 临时密码字符集 */
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const ALL_CHARS = LOWERCASE + UPPERCASE + DIGITS

export interface PasswordPolicyResult {
  ok: boolean
  reason?: string
}

/**
 * 用 argon2id 哈希密码（@node-rs/argon2 默认算法即 argon2id，默认参数）。
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain)
}

/**
 * 校验密码与 argon2id 哈希是否匹配。
 *
 * 注意：畸形/损坏的 hash 字符串会让底层解码失败并抛错（而非返回 true），
 * 调用方应将其视为校验失败的异常路径处理。
 */
export function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  return verify(passwordHash, plain)
}

/**
 * 密码策略校验：长度 ≥10，且不得与用户名相同、不得包含用户名。
 *
 * 包含性检查对长度 <3 的用户名跳过（过短的用户名——如单字符——会命中
 * 几乎所有正常密码，检查失去意义；平台用户名本身要求 ≥3 字符）。
 */
export function validatePasswordPolicy(plain: string, username: string): PasswordPolicyResult {
  if (plain.length < MIN_LENGTH) {
    return { ok: false, reason: `密码长度不足，至少 ${MIN_LENGTH} 位` }
  }
  if (plain === username) {
    return { ok: false, reason: '密码不能与用户名相同' }
  }
  if (
    username.length >= CONTAINMENT_MIN_USERNAME_LENGTH &&
    plain.toLowerCase().includes(username.toLowerCase())
  ) {
    return { ok: false, reason: '密码不能包含用户名' }
  }
  return { ok: true }
}

/**
 * 生成 12 位临时密码：构造上保证同时含有小写、大写、数字各至少一个
 * （先各取其一，再从全字符集补齐，最后洗牌打散位置），随机源为 CSPRNG。
 *
 * 满足长度与字符类策略；每次随机生成，两次输出相同的概率可忽略不计。
 */
export function generateTempPassword(): string {
  const chars: string[] = [
    LOWERCASE[randomInt(0, LOWERCASE.length)],
    UPPERCASE[randomInt(0, UPPERCASE.length)],
    DIGITS[randomInt(0, DIGITS.length)],
  ]
  while (chars.length < TEMP_PASSWORD_LENGTH) {
    chars.push(ALL_CHARS[randomInt(0, ALL_CHARS.length)])
  }
  // Fisher–Yates 洗牌，避免前三类字符位置固定
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

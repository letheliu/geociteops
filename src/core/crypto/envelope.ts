import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 信封格式版本 */
const ENVELOPE_VERSION = 1

/** GCM 推荐 iv 长度：12 字节 */
const IV_LENGTH = 12

/** 主密钥 env 变量名 */
const MASTER_KEY_ENV = 'CREDENTIAL_MASTER_KEY'

/** 主密钥格式：64 位 hex（= 32 字节，AES-256） */
const MASTER_KEY_PATTERN = /^[0-9a-fA-F]{64}$/

interface SealedEnvelope {
  __v: number
  iv: string
  tag: string
  ct: string
}

/** 校验密钥格式并转为 32 字节 Buffer */
function toKeyBuffer(keyHex: string): Buffer {
  if (!MASTER_KEY_PATTERN.test(keyHex)) {
    throw new Error(
      `密钥格式错误：需要 64 位 hex 字符串（32 字节，AES-256），实际长度 ${keyHex.length}`
    )
  }
  return Buffer.from(keyHex, 'hex')
}

/** 解析并校验信封 JSON 结构 */
function parseEnvelope(sealedJson: string): SealedEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(sealedJson)
  } catch {
    throw new Error('信封格式错误：不是合法 JSON')
  }
  const record = parsed as Record<string, unknown> | null
  if (
    record === null ||
    typeof record !== 'object' ||
    record.__v !== ENVELOPE_VERSION ||
    typeof record.iv !== 'string' ||
    typeof record.tag !== 'string' ||
    typeof record.ct !== 'string'
  ) {
    throw new Error(
      `信封格式错误：期望 { __v: ${ENVELOPE_VERSION}, iv, tag, ct }（均 base64）`
    )
  }
  return record as unknown as SealedEnvelope
}

/**
 * 加密配置 JSON 字符串：AES-256-GCM，随机 12 字节 iv，
 * 返回信封 JSON 字符串 `{ __v: 1, iv, tag, ct }`（均 base64）。
 */
export function encryptConfig(plainJson: string, keyHex: string): string {
  const key = toKeyBuffer(keyHex)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()])
  const envelope: SealedEnvelope = {
    __v: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
  return JSON.stringify(envelope)
}

/**
 * 解密信封 JSON 字符串，还原原始 JSON 字符串。
 * 版本不符、结构缺失、密文被篡改或密钥不正确时抛错。
 */
export function decryptConfig(sealedJson: string, keyHex: string): string {
  const envelope = parseEnvelope(sealedJson)
  const key = toKeyBuffer(keyHex)
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64')
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  try {
    const ct = Buffer.from(envelope.ct, 'base64')
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('信封解密失败：密文被篡改或密钥不正确')
  }
}

/**
 * 判断值是否为已加密信封（对旧明文 JSON 返回 false，作为迁移幂等依据）。
 */
export function isEncryptedConfig(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object') return false
    const record = parsed as Record<string, unknown>
    return (
      record.__v === ENVELOPE_VERSION &&
      typeof record.iv === 'string' &&
      typeof record.tag === 'string' &&
      typeof record.ct === 'string'
    )
  } catch {
    return false
  }
}

/**
 * 从 `CREDENTIAL_MASTER_KEY` 读取主密钥。
 * 缺失或非 64 位 hex（32 字节）时抛出带 env 名与期望格式的错误。
 */
export function loadMasterKey(): string {
  const value = process.env[MASTER_KEY_ENV]
  if (!value || !MASTER_KEY_PATTERN.test(value)) {
    throw new Error(
      `环境变量 ${MASTER_KEY_ENV} 缺失或格式错误：` +
        `需要 64 位 hex 字符串（32 字节，AES-256 主密钥），例如 openssl rand -hex 32 生成`
    )
  }
  return value
}

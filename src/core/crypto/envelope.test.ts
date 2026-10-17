import { describe, it, expect } from 'vitest'
import { encryptConfig, decryptConfig, isEncryptedConfig } from './envelope.js'

const KEY = 'a'.repeat(64) // 32 字节 hex

describe('envelope', () => {
  it('roundtrip：加密后可解密还原', () => {
    const plain = JSON.stringify({ deepseek: { DEEPSEEK_API_KEY: 'sk-1' } })
    const sealed = encryptConfig(plain, KEY)
    expect(isEncryptedConfig(sealed)).toBe(true)
    expect(decryptConfig(sealed, KEY)).toBe(plain)
  })
  it('密文结构为 { __v: 1, iv, tag, ct } 且不包含明文', () => {
    const sealed = JSON.parse(encryptConfig(JSON.stringify({ k: 'sk-secret' }), KEY))
    expect(sealed.__v).toBe(1)
    expect(JSON.stringify(sealed)).not.toContain('sk-secret')
  })
  it('篡改 ct 解密失败抛错', () => {
    const sealed = JSON.parse(encryptConfig('{}', KEY))
    sealed.ct = sealed.ct.slice(0, -4) + 'AAAA'
    expect(() => decryptConfig(JSON.stringify(sealed), KEY)).toThrow()
  })
  it('错误密钥解密失败抛错', () => {
    const sealed = encryptConfig('{}', KEY)
    expect(() => decryptConfig(sealed, 'b'.repeat(64))).toThrow()
  })
  it('isEncryptedConfig 对旧明文 JSON 返回 false（迁移幂等依据）', () => {
    expect(isEncryptedConfig('{"deepseek":{}}')).toBe(false)
    expect(isEncryptedConfig('{}')).toBe(false)
  })
})

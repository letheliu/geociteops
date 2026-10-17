import { describe, it, expect, vi } from 'vitest'
import {
  createCredentialResolver,
  REQUIRED_KEYS,
  type CredentialResolver,
} from './credential-resolver.js'
import { encryptConfig } from '../../core/crypto/envelope.js'

const KEY = 'a'.repeat(64)

const ALL_PLATFORMS = [
  'deepseek',
  'doubao',
  'qwen',
  'ernie',
  'perplexity',
  'chatgpt',
  'gemini',
]

/** 7 平台全配齐的明文配置 */
function fullConfig() {
  return {
    deepseek: { DEEPSEEK_API_KEY: 'sk-deep-ab12' },
    doubao: { DOUBAO_API_KEY: 'sk-doubao-cd34' },
    qwen: { QWEN_API_KEY: 'sk-qwen-ef56' },
    ernie: { ERNIE_API_KEY: 'sk-ernie-gh78', ERNIE_SECRET_KEY: 'sec-ernie-ij90' },
    perplexity: { PERPLEXITY_API_KEY: 'sk-pplx-kl12' },
    chatgpt: { OPENAI_API_KEY: 'sk-oai-mn34' },
    gemini: { GEMINI_API_KEY: 'sk-gem-op56' },
  }
}

function makeResolver(opts: {
  platformConfig: unknown
  registered?: string[]
  masterKey?: string
}): { resolver: CredentialResolver; findUnique: ReturnType<typeof vi.fn> } {
  const findUnique = vi.fn().mockResolvedValue({ id: 'w1', platformConfig: opts.platformConfig })
  const prisma = { workspace: { findUnique } } as any
  const registry = {
    getRegisteredPlatforms: () => opts.registered ?? ALL_PLATFORMS,
  } as any
  const resolver = createCredentialResolver({
    prisma,
    registry,
    masterKey: opts.masterKey ?? KEY,
  })
  return { resolver, findUnique }
}

describe('REQUIRED_KEYS', () => {
  it('精确锁定 7 平台必需键', () => {
    expect(REQUIRED_KEYS).toEqual({
      deepseek: ['DEEPSEEK_API_KEY'],
      doubao: ['DOUBAO_API_KEY'],
      qwen: ['QWEN_API_KEY'],
      ernie: ['ERNIE_API_KEY', 'ERNIE_SECRET_KEY'],
      perplexity: ['PERPLEXITY_API_KEY'],
      chatgpt: ['OPENAI_API_KEY'],
      gemini: ['GEMINI_API_KEY'],
    })
  })
})

describe('resolveConfig', () => {
  it('信封密文 → 解密并返回对象', async () => {
    const plain = { deepseek: { DEEPSEEK_API_KEY: 'sk-plain' }, competitors: ['figma'] }
    const sealed = encryptConfig(JSON.stringify(plain), KEY)
    const { resolver } = makeResolver({ platformConfig: sealed })
    await expect(resolver.resolveConfig('w1')).resolves.toEqual(plain)
  })

  it('旧明文对象 → 原样返回（防御旧数据）', async () => {
    const plain = { deepseek: { DEEPSEEK_API_KEY: 'sk-legacy' } }
    const { resolver } = makeResolver({ platformConfig: plain })
    await expect(resolver.resolveConfig('w1')).resolves.toEqual(plain)
  })

  it('null platformConfig → 返回空对象', async () => {
    const { resolver } = makeResolver({ platformConfig: null })
    await expect(resolver.resolveConfig('w1')).resolves.toEqual({})
  })

  it('workspace 不存在 → 抛错带 workspaceId', async () => {
    const prisma = { workspace: { findUnique: vi.fn().mockResolvedValue(null) } } as any
    const resolver = createCredentialResolver({
      prisma,
      registry: { getRegisteredPlatforms: () => [] } as any,
      masterKey: KEY,
    })
    await expect(resolver.resolveConfig('w-missing')).rejects.toThrow('w-missing')
  })

  it('解密失败（密钥不正确）→ 抛错带 workspaceId', async () => {
    const sealed = encryptConfig(JSON.stringify({ a: 1 }), KEY)
    const { resolver } = makeResolver({
      platformConfig: sealed,
      masterKey: 'b'.repeat(64), // 错误密钥
    })
    await expect(resolver.resolveConfig('w1')).rejects.toThrow('w1')
  })
})

describe('getCredentials', () => {
  it('返回指定平台的凭证（信封解密后）', async () => {
    const cfg = { deepseek: { DEEPSEEK_API_KEY: 'sk-deep' }, ernie: {} }
    const sealed = encryptConfig(JSON.stringify(cfg), KEY)
    const { resolver } = makeResolver({ platformConfig: sealed })
    await expect(resolver.getCredentials('w1', 'deepseek')).resolves.toEqual({
      DEEPSEEK_API_KEY: 'sk-deep',
    })
  })

  it('平台未配置 → 空对象', async () => {
    const { resolver } = makeResolver({ platformConfig: { deepseek: {} } })
    await expect(resolver.getCredentials('w1', 'perplexity')).resolves.toEqual({})
  })
})

describe('getSummary', () => {
  it('已配置平台 configured=true 且 hint 为首个必需键末 4 位；未配置为 false/空串', async () => {
    const cfg = {
      deepseek: { DEEPSEEK_API_KEY: 'sk-deepseek-ab12' }, // hint: ab12
      ernie: { ERNIE_API_KEY: 'x' }, // 缺 ERNIE_SECRET_KEY
      doubao: { DOUBAO_API_KEY: '' }, // 空串视为未配置
      competitors: ['figma', 'notion'],
    }
    const sealed = encryptConfig(JSON.stringify(cfg), KEY)
    const { resolver } = makeResolver({ platformConfig: sealed })

    const summary = await resolver.getSummary('w1')
    expect(summary.competitors).toEqual(['figma', 'notion'])
    expect(summary.platforms.deepseek).toEqual({ configured: true, hint: 'ab12' })
    expect(summary.platforms.ernie).toEqual({ configured: false, hint: '' })
    expect(summary.platforms.doubao).toEqual({ configured: false, hint: '' })
    expect(summary.platforms.perplexity).toEqual({ configured: false, hint: '' })
    expect(summary.platforms.chatgpt).toEqual({ configured: false, hint: '' })
    expect(summary.platforms.gemini).toEqual({ configured: false, hint: '' })
  })

  it('ernie 双键全齐才 configured，hint 取第一个必需键末 4 位', async () => {
    const cfg = {
      ernie: { ERNIE_API_KEY: 'ak-ernie-wxyz', ERNIE_SECRET_KEY: 'sec' },
    }
    const { resolver } = makeResolver({ platformConfig: cfg })
    const summary = await resolver.getSummary('w1')
    expect(summary.platforms.ernie).toEqual({ configured: true, hint: 'wxyz' })
  })

  it('competitors 缺失 → 空数组', async () => {
    const { resolver } = makeResolver({ platformConfig: {} })
    const summary = await resolver.getSummary('w1')
    expect(summary.competitors).toEqual([])
  })
})

describe('listActivePlatforms', () => {
  it('7 平台注册且全配齐 → 全部返回（修复 perplexity/chatgpt/gemini 被漏掉的缺陷）', async () => {
    const sealed = encryptConfig(JSON.stringify(fullConfig()), KEY)
    const { resolver } = makeResolver({ platformConfig: sealed, registered: ALL_PLATFORMS })
    const active = await resolver.listActivePlatforms('w1')
    expect(active.slice().sort()).toEqual([...ALL_PLATFORMS].sort())
  })

  it('缺任一必需键 → 不含该平台', async () => {
    const cfg = fullConfig()
    delete (cfg.ernie as any).ERNIE_SECRET_KEY
    const { resolver } = makeResolver({ platformConfig: cfg })
    const active = await resolver.listActivePlatforms('w1')
    expect(active).not.toContain('ernie')
    expect(active).toContain('deepseek')
    expect(active).toContain('perplexity')
  })

  it('registry 未注册的平台 → 不含（即使凭证配齐）', async () => {
    const { resolver } = makeResolver({
      platformConfig: fullConfig(),
      registered: ['deepseek', 'doubao', 'qwen', 'ernie'], // 旧 scheduler 的 4 平台
    })
    const active = await resolver.listActivePlatforms('w1')
    expect(active.slice().sort()).toEqual(['deepseek', 'doubao', 'ernie', 'qwen'])
    expect(active).not.toContain('perplexity')
    expect(active).not.toContain('chatgpt')
    expect(active).not.toContain('gemini')
  })
})

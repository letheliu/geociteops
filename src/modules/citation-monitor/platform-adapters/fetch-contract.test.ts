import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAiAdapter } from './openai.js'
import { ChatGptSearchAdapter } from './chatgpt.js'
import { DeepSeekAdapter } from './deepseek.js'
import { DoubaoAdapter } from './doubao.js'
import { QwenAdapter } from './qwen.js'
import { ErnieAdapter } from './ernie.js'
import { PerplexityAdapter } from './perplexity.js'
import { GeminiAdapter } from './gemini.js'
import { AnthropicAdapter } from './anthropic.js'
import type { PlatformAdapter } from './types.js'

/**
 * 全部 adapter 的公共契约（规格 §6 / §11）：
 * - 走 fetchWithTimeout：平台挂起时能被超时掐断
 * - 请求体不传 temperature：监测采样的方差来源是平台检索与模型非确定性，
 *   把温度钉成 0 等于把 N 次采样退化成同一份确定性答案，N 次采样就白做了
 */
const ADAPTERS: Array<{ name: string; make: () => PlatformAdapter; creds: Record<string, string> }> = [
  { name: 'openai', make: () => new OpenAiAdapter(), creds: { OPENAI_API_KEY: 'sk-test' } },
  { name: 'chatgpt', make: () => new ChatGptSearchAdapter(), creds: { OPENAI_API_KEY: 'sk-test' } },
  { name: 'deepseek', make: () => new DeepSeekAdapter(), creds: { DEEPSEEK_API_KEY: 'ds-test' } },
  { name: 'doubao', make: () => new DoubaoAdapter(), creds: { DOUBAO_API_KEY: 'db-test' } },
  { name: 'qwen', make: () => new QwenAdapter(), creds: { QWEN_API_KEY: 'qw-test' } },
  { name: 'ernie', make: () => new ErnieAdapter(), creds: { ERNIE_API_KEY: 'e1', ERNIE_SECRET_KEY: 's1' } },
  { name: 'perplexity', make: () => new PerplexityAdapter(), creds: { PERPLEXITY_API_KEY: 'px-test' } },
  { name: 'gemini', make: () => new GeminiAdapter(), creds: { GEMINI_API_KEY: 'gm-test' } },
  { name: 'anthropic', make: () => new AnthropicAdapter(), creds: { ANTHROPIC_API_KEY: 'an-test' } },
]

/** 能让每个 adapter 走完解析逻辑的假响应（按平台返回体形状） */
function okResponse(adapterName: string): Response {
  const bodies: Record<string, unknown> = {
    openai: { choices: [{ message: { content: 'a' } }] },
    chatgpt: { choices: [{ message: { content: 'a' } }] },
    deepseek: { choices: [{ message: { content: 'a' } }] },
    doubao: { choices: [{ message: { content: 'a' } }] },
    qwen: { choices: [{ message: { content: 'a' } }] },
    perplexity: { choices: [{ message: { content: 'a' } }] },
    anthropic: { content: [{ type: 'text', text: 'a' }] },
    gemini: { candidates: [{ content: { parts: [{ text: 'a' }] } }] },
    ernie: { result: 'a' }, // 第二次调用（第一次是取 token）
  }
  return new Response(JSON.stringify(bodies[adapterName]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('adapter fetch 契约', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.CITATION_FETCH_TIMEOUT_MS
  })

  for (const { name, make, creds } of ADAPTERS) {
    it(`${name}：请求体不含 temperature`, async () => {
      const fetchMock = vi.fn(async () => {
        if (name === 'ernie' && (fetchMock as any).mock.calls.length === 1) {
          // ernie 第一次调用是取 access_token
          return new Response(JSON.stringify({ access_token: 'tok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return okResponse(name)
      })
      vi.stubGlobal('fetch', fetchMock)

      await make().query('测试查询', creds)

      const bodies = (fetchMock.mock.calls as Array<[string, RequestInit?]>).map(([, init]) => {
        try {
          return JSON.parse(String(init?.body ?? '{}'))
        } catch {
          return {}
        }
      })
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        expect(body).not.toHaveProperty('temperature')
      }
    })

    it(`${name}：平台挂起时按超时抛错（可被 deadline 掐断）`, async () => {
      process.env.CITATION_FETCH_TIMEOUT_MS = '30'
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }),
        ),
      )

      await expect(make().query('测试查询', creds)).rejects.toThrow(/timeout/i)
    })
  }
})

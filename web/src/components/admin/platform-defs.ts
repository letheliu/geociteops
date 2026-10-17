/**
 * 平台凭证字段定义（平台管理/工作区设置共用）。
 * 自旧 Settings.vue 的 platforms 数组抽取；key 对齐服务端
 * credential-resolver REQUIRED_KEYS / platformSummary 的键
 * （chatgpt 平台的 envKey 沿用 OPENAI_*，OpenAI 兼容协议）。
 */

/** 单个凭证字段定义（envKey = platformConfig 内的平台配置键） */
export interface CredentialFieldDef {
  envKey: string
  label: string
  /** 必填：缺省则平台判为未配置（对应服务端 REQUIRED_KEYS） */
  required?: boolean
}

/** 平台定义 */
export interface PlatformDef {
  key: string
  label: string
  fields: CredentialFieldDef[]
}

export const DEFAULT_PLATFORMS: PlatformDef[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    fields: [
      { envKey: 'DEEPSEEK_API_KEY', label: 'API Key', required: true },
      { envKey: 'DEEPSEEK_BASE_URL', label: 'Base URL（可选）' },
      { envKey: 'DEEPSEEK_MODEL', label: 'Model（可选）' },
    ],
  },
  {
    key: 'doubao',
    label: '豆包（火山引擎）',
    fields: [
      { envKey: 'DOUBAO_API_KEY', label: 'API Key', required: true },
      { envKey: 'DOUBAO_BASE_URL', label: 'Base URL（可选）' },
      { envKey: 'DOUBAO_MODEL', label: 'Model（可选）' },
    ],
  },
  {
    key: 'qwen',
    label: '通义千问（阿里云）',
    fields: [
      { envKey: 'QWEN_API_KEY', label: 'API Key', required: true },
      { envKey: 'QWEN_BASE_URL', label: 'Base URL（可选）' },
      { envKey: 'QWEN_MODEL', label: 'Model（可选）' },
    ],
  },
  {
    key: 'ernie',
    label: '文心一言（百度）',
    fields: [
      { envKey: 'ERNIE_API_KEY', label: 'API Key', required: true },
      { envKey: 'ERNIE_SECRET_KEY', label: 'Secret Key', required: true },
      { envKey: 'ERNIE_MODEL', label: 'Model（可选）' },
    ],
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    fields: [
      { envKey: 'PERPLEXITY_API_KEY', label: 'API Key', required: true },
      { envKey: 'PERPLEXITY_MODEL', label: 'Model（可选）' },
    ],
  },
  {
    key: 'chatgpt',
    label: 'ChatGPT Search（OpenAI 兼容）',
    fields: [
      { envKey: 'OPENAI_API_KEY', label: 'API Key', required: true },
      { envKey: 'OPENAI_SEARCH_MODEL', label: 'Search Model（可选）' },
      { envKey: 'OPENAI_BASE_URL', label: 'Base URL（可选）' },
    ],
  },
  {
    key: 'gemini',
    label: 'Gemini',
    fields: [
      { envKey: 'GEMINI_API_KEY', label: 'API Key', required: true },
      { envKey: 'GEMINI_MODEL', label: 'Model（可选）' },
    ],
  },
]

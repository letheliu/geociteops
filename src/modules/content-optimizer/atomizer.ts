import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom } from './types.js'

const SYSTEM_PROMPT = `你是一个 GEO 优化专家。把用户提供的内容做语义切分（原子化），每段提取以下字段：
- text: 段落原文
- subject: 这段在说谁（实体名）
- predicate: 说了什么（动词短语）
- object: 对象
- anchors: 数据锚点数组（具体数字、时间、机构名）
- definition: 定义句（"X 是 Y" 格式），可选

要求：
1. 每段必须含具体数字、时间或机构名
2. 把形容词替换为可验证的事实
3. 在开头给出定义句

只输出 JSON，格式：{ "atoms": [{ "text": "...", "subject": "...", "predicate": "...", "object": "...", "anchors": ["..."], "definition": "..." }] }`

export interface AtomizerService {
  atomize(text: string): Promise<Atom[]>
}

export function createAtomizer(llm: LlmProvider): AtomizerService {
  return {
    async atomize(text) {
      if (!text || text.trim().length === 0) return []

      const res = await llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        { temperature: 0 },
      )

      return parseAtoms(res.text)
    },
  }
}

function parseAtoms(raw: string): Atom[] {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.atoms)) {
      return parsed.atoms.map((a: any) => ({
        text: String(a.text || ''),
        subject: String(a.subject || ''),
        predicate: String(a.predicate || ''),
        object: String(a.object || ''),
        anchors: Array.isArray(a.anchors) ? a.anchors.map(String) : [],
        definition: a.definition ? String(a.definition) : undefined,
      }))
    }
  } catch {
    // JSON 解析失败，兜底
  }

  // 兜底：按双换行分段
  return raw
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      subject: '',
      predicate: '',
      object: '',
      anchors: [],
    }))
}

import type { LlmProvider } from '../llm/types.js'
import type { ExtractionResult, RawEntity, RawRelation } from './types.js'

const SYSTEM_PROMPT = `你是一个实体抽取专家。从用户给的内容中抽取所有命名实体和实体之间的关系。

实体字段：
- name: 实体名（产品名、公司名、人名等）
- rawType: 实体的原始类型描述，如 "AI 设计工具"、"SaaS 公司"、"笔记软件"
- properties: 实体的关键属性（URL、描述、数字等），保持 JSON 结构

关系字段：
- fromName: 起始实体名
- toName: 目标实体名
- relationType: 关系类型，如 "competitor"、"hasFeature"、"belongsTo"
- properties: 关系的附加属性（可选）

要求：
1. 抽取所有有意义的命名实体（包括产品、公司、人物、概念）
2. 推断实体间的关系（同行业、上下游、包含等）
3. 不要抽取泛指词（如"工具"、"产品"作为单独实体）

只输出 JSON，格式：{ "entities": [...], "relations": [...] }`

export interface EntityExtractorService {
  extract(content: string): Promise<ExtractionResult>
}

export function createEntityExtractor(llm: LlmProvider): EntityExtractorService {
  return {
    async extract(content) {
      if (!content || content.trim().length === 0) {
        return { entities: [], relations: [], extractionNotes: 'empty_input' }
      }

      const res = await llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        { temperature: 0 },
      )

      return parseExtraction(res.text)
    },
  }
}

function parseExtraction(raw: string): ExtractionResult {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.entities) && Array.isArray(parsed.relations)) {
      const entities: RawEntity[] = parsed.entities.map((e: any) => ({
        name: String(e.name || ''),
        rawType: String(e.rawType || ''),
        properties: typeof e.properties === 'object' && e.properties !== null ? e.properties : {},
        sourceSpan: e.sourceSpan,
      }))
      const relations: RawRelation[] = parsed.relations.map((r: any) => ({
        fromName: String(r.fromName || ''),
        toName: String(r.toName || ''),
        relationType: String(r.relationType || ''),
        properties: typeof r.properties === 'object' && r.properties !== null ? r.properties : undefined,
      }))
      return { entities, relations, extractionNotes: parsed.extractionNotes }
    }
  } catch {
    // 兜底
  }

  return { entities: [], relations: [], extractionNotes: 'parse_failed' }
}

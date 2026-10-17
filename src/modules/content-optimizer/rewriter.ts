import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom, ScoredAtom, AtomScore } from './types.js'
import { createScoringEngine } from './scoring.js'

const SYSTEM_PROMPT = `你是一个 GEO 优化专家。重写以下内容段落，使其更易被 AI 搜索引擎引用。

改进方向（根据缺失维度补充）：
1. 补充具体数字、时间、统计数据
2. 补充机构名、专有名词等实体锚点
3. 确保段落可以独立理解（包含明确的主语）
4. 在开头添加定义句（"X 是 Y" 格式）

只输出 JSON：{ "text": "...", "subject": "...", "predicate": "...", "object": "...", "anchors": ["..."], "definition": "..." }`

function buildUserPrompt(atom: Atom, score: AtomScore): string {
  const missing: string[] = []
  if (!score.hasNumericAnchor) missing.push('数字/时间锚点')
  if (!score.hasEntityAnchor) missing.push('实体锚点（机构名/专有名词）')
  if (!score.isSelfContained) missing.push('独立可理解性（主语/谓语/宾语）')
  if (!score.hasDefinition) missing.push('定义句')

  return `原文：${atom.text}

当前缺失：${missing.join('、') || '无'}
请重写这段内容，补全缺失的维度。`
}

function parseRewritten(raw: string): Partial<Atom> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.text === 'string') {
      return {
        text: String(parsed.text),
        subject: String(parsed.subject || ''),
        predicate: String(parsed.predicate || ''),
        object: String(parsed.object || ''),
        anchors: Array.isArray(parsed.anchors) ? parsed.anchors.map(String) : [],
        definition: parsed.definition ? String(parsed.definition) : undefined,
      }
    }
  } catch {
    // 兜底
  }
  return null
}

export interface RewriterService {
  rewrite(atom: Atom, score: AtomScore): Promise<Atom>
  rewriteBatch(atoms: ScoredAtom[], threshold?: number): Promise<ScoredAtom[]>
}

export function createRewriter(llm: LlmProvider): RewriterService {
  const scoring = createScoringEngine()

  return {
    async rewrite(atom, score) {
      const res = await llm.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(atom, score) },
        ],
        { temperature: 0.3 },
      )
      const rewritten = parseRewritten(res.text)
      if (rewritten) {
        return {
          text: rewritten.text ?? atom.text,
          subject: rewritten.subject ?? atom.subject,
          predicate: rewritten.predicate ?? atom.predicate,
          object: rewritten.object ?? atom.object,
          anchors: rewritten.anchors ?? atom.anchors,
          definition: rewritten.definition ?? atom.definition,
        }
      }
      return atom
    },

    async rewriteBatch(atoms, threshold = 70) {
      const results: ScoredAtom[] = []

      for (const atom of atoms) {
        if (atom.score.total >= threshold) {
          results.push(atom)
          continue
        }

        const rewritten = await this.rewrite(atom, atom.score)
        // 重新评分
        const [rescored] = scoring.scoreAtoms([rewritten])
        results.push(rescored)
      }

      return results
    },
  }
}

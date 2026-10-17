import type { LlmsTxtInput, LlmsTxtSection } from './types.js'

export interface LlmsTxtBuildResult {
  content: string
  warnings: string[]
}

export interface LlmsTxtBuilderService {
  build(input: LlmsTxtInput): LlmsTxtBuildResult
  buildRaw(input: LlmsTxtInput): string
  parseMarkdown(md: string): LlmsTxtInput | null
}

const LLMS_TXT_WARNING =
  'No major AI search system (Google AI Overviews, ChatGPT Search, Perplexity) has confirmed consuming /llms.txt as of May 2026. Ship for optionality, not for citation ranking.'

export function createLlmsTxtBuilder(): LlmsTxtBuilderService {
  return {
    build(input) {
      const raw = this.buildRaw(input)
      return {
        content: raw,
        warnings: [LLMS_TXT_WARNING],
      }
    },

    buildRaw(input) {
      const lines: string[] = []
      lines.push(`# ${input.brandName}`)
      lines.push(`> ${input.tagline}`)
      lines.push('')

      for (const section of input.sections) {
        lines.push(`## ${section.title}`)
        for (const item of section.items) {
          lines.push(`- [${item.label}](${item.url}): ${item.description}`)
        }
        lines.push('')
      }

      if (input.updateFrequency) {
        lines.push('## 更新频率')
        if (input.updateFrequency.docs) {
          lines.push(`- 文档：${input.updateFrequency.docs}`)
        }
        if (input.updateFrequency.blog) {
          lines.push(`- 博客：${input.updateFrequency.blog}`)
        }
        lines.push('')
      }

      return lines.join('\n').trimEnd() + '\n'
    },

    parseMarkdown(md) {
      const trimmed = md.trim()
      if (!trimmed.startsWith('# ')) return null

      const lines = trimmed.split('\n')
      const brandName = lines[0].slice(2).trim()
      const taglineLine = lines.find((l) => l.startsWith('> '))
      if (!taglineLine) return null
      const tagline = taglineLine.slice(2).trim()

      const sections: LlmsTxtSection[] = []
      let currentSection: LlmsTxtSection | null = null
      let updateFrequency: { docs?: string; blog?: string } | undefined

      for (const line of lines.slice(1)) {
        if (line.startsWith('## ')) {
          const title = line.slice(3).trim()
          if (title === '更新频率') {
            currentSection = null
            updateFrequency = {}
          } else {
            currentSection = { title, items: [] }
            sections.push(currentSection)
          }
        } else if (line.startsWith('- ') && currentSection) {
          const m = line.slice(2).match(/^\[([^\]]+)\]\(([^)]+)\):\s*(.+)$/)
          if (m) {
            currentSection.items.push({ label: m[1], url: m[2], description: m[3] })
          }
        } else if (line.startsWith('- ') && updateFrequency) {
          const m = line.slice(2).match(/^(文档|博客)：(.+)$/)
          if (m) {
            if (m[1] === '文档') updateFrequency.docs = m[2]
            if (m[1] === '博客') updateFrequency.blog = m[2]
          }
        }
      }

      return { brandName, tagline, sections, updateFrequency }
    },
  }
}

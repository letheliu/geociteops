import { describe, it, expect } from 'vitest'
import { createLlmsTxtBuilder } from './llms-txt-builder.js'

describe('LlmsTxtBuilder', () => {
  const builder = createLlmsTxtBuilder()

  it('build 返回 content 和 warnings', () => {
    const result = builder.build({
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [
        {
          title: '核心产品',
          items: [
            { label: '白模生图', url: 'https://example.com/feature-1', description: '一键生成白模线稿' },
          ],
        },
      ],
    })

    expect(result.content).toContain('# zoomer AI')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('No major AI search system')
  })

  it('buildRaw 输出标准 markdown 格式', () => {
    const md = builder.buildRaw({
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [
        {
          title: '核心产品',
          items: [
            { label: '白模生图', url: 'https://example.com/feature-1', description: '一键生成白模线稿' },
            { label: '智能填充', url: 'https://example.com/feature-2', description: 'AI 智能填充内容' },
          ],
        },
        {
          title: '常见问答',
          items: [
            { label: 'Q1: 什么是 zoomer AI?', url: '#', description: 'A: 是一款 AI 设计工具' },
          ],
        },
      ],
      updateFrequency: { docs: '每周', blog: '每周 2 篇' },
    })

    expect(md).toContain('# zoomer AI')
    expect(md).toContain('> AI 设计工具')
    expect(md).toContain('## 核心产品')
    expect(md).toContain('- [白模生图](https://example.com/feature-1): 一键生成白模线稿')
    expect(md).toContain('## 常见问答')
    expect(md).toContain('## 更新频率')
    expect(md).toContain('- 文档：每周')
    expect(md).toContain('- 博客：每周 2 篇')
  })

  it('buildRaw 不传 updateFrequency 时跳过该 section', () => {
    const md = builder.buildRaw({
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [{ title: '核心产品', items: [] }],
    })
    expect(md).not.toContain('## 更新频率')
  })

  it('buildRaw 空 sections 时仍输出品牌行', () => {
    const md = builder.buildRaw({
      brandName: 'zoomer',
      tagline: 't',
      sections: [],
    })
    expect(md).toContain('# zoomer')
    expect(md).toContain('> t')
  })

  it('parseMarkdown 回读 buildRaw 结果', () => {
    const original = {
      brandName: 'zoomer AI',
      tagline: 'AI 设计工具',
      sections: [
        {
          title: '核心产品',
          items: [{ label: '白模', url: 'https://x.com', description: 'desc' }],
        },
      ],
    }
    const md = builder.buildRaw(original)
    const parsed = builder.parseMarkdown(md)
    expect(parsed).not.toBeNull()
    expect(parsed!.brandName).toBe('zoomer AI')
    expect(parsed!.tagline).toBe('AI 设计工具')
    expect(parsed!.sections[0].items[0].url).toBe('https://x.com')
  })

  it('parseMarkdown 对非法输入返回 null', () => {
    expect(builder.parseMarkdown('')).toBeNull()
    expect(builder.parseMarkdown('random text')).toBeNull()
  })

  it('warning 提到 llms.txt 不被主流AI搜索消费', () => {
    const result = builder.build({
      brandName: 'test',
      tagline: 'test',
      sections: [],
    })
    expect(result.warnings[0]).toContain('llms.txt')
    expect(result.warnings[0]).toContain('optionality')
  })
})

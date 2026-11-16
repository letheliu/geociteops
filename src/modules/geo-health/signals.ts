import type { AgentReadinessReport } from '../agent-readiness/types.js'
import { tx } from '../agent-readiness/types.js'
import { createJsonLdBuilder } from '../schema-generator/jsonld-builder.js'
import { createLlmsTxtBuilder } from '../schema-generator/llms-txt-builder.js'
import { publicError } from './errors.js'
import { resolveLanguage } from './queries.js'
import { structuredSignalScore } from './score.js'
import type { GeoHealthRunInput } from './run-input.js'
import type { SignalCheckStatus, StructuredSignalsPillar } from './types.js'

const llmsBuilder = createLlmsTxtBuilder()
const jsonLdBuilder = createJsonLdBuilder()

export function buildDownloads(input: GeoHealthRunInput): { llmsTxt: string; jsonLd: string } {
  const language = resolveLanguage(input)
  const tagline = input.industry
    ? (language === 'zh' ? `${input.industry}。官网：${input.siteUrl}` : `${input.industry}. Official site: ${input.siteUrl}`)
    : (language === 'zh' ? `${input.brandName} 的官方站点` : `Official site of ${input.brandName}`)
  const llms = llmsBuilder.build({
    brandName: input.brandName,
    tagline,
    sections: [{
      title: language === 'zh' ? '核心页面' : 'Key pages',
      items: [{
        label: input.brandName,
        url: input.siteUrl,
        description: input.industry ?? tagline,
      }],
    }],
  })
  const organization = jsonLdBuilder.build({
    type: 'Organization',
    fields: {
      name: input.brandName,
      url: input.siteUrl,
      ...(input.industry ? { description: input.industry } : {}),
    },
  })
  const website = jsonLdBuilder.build({
    type: 'WebSite',
    fields: { name: input.brandName, url: input.siteUrl },
  })
  return {
    llmsTxt: llms.content,
    jsonLd: JSON.stringify([organization, website], null, 2),
  }
}

export function runStructuredSignals(input: GeoHealthRunInput, report: AgentReadinessReport | null): StructuredSignalsPillar {
  let downloads = { llmsTxt: '', jsonLd: '' }
  try {
    downloads = buildDownloads(input)
  } catch (err) {
    return {
      status: 'FAILED',
      score: null,
      schemaTypes: [],
      jsonLdPresent: false,
      llmsTxtStatus: 'unknown',
      llmsFullStatus: 'unknown',
      generatedLlmsTxt: '',
      generatedJsonLd: '',
      note: tx('The generators could not build llms.txt or JSON-LD.', '生成器没有产出 llms.txt 或 JSON-LD。'),
      error: publicError(err),
    }
  }

  if (!report) {
    return {
      status: 'SKIPPED',
      score: null,
      schemaTypes: [],
      jsonLdPresent: false,
      llmsTxtStatus: 'unknown',
      llmsFullStatus: 'unknown',
      generatedLlmsTxt: downloads.llmsTxt,
      generatedJsonLd: downloads.jsonLd,
      note: tx(
        'Agent readiness did not finish, so Schema.org and llms.txt coverage is unknown. The generated files are still attached and do not add points.',
        'Agent 就绪没有完成，Schema.org 和 llms.txt 的覆盖情况未知。生成的文件仍可下载，它们不计分。',
      ),
      error: null,
    }
  }

  const jsonLd = statusOf(report, 'page.jsonld')
  const llms = statusOf(report, 'llms.txt')
  const full = statusOf(report, 'llms-full.txt')
  const types = schemaTypes(report)
  return {
    status: 'SUCCEEDED',
    score: structuredSignalScore(report.checks),
    schemaTypes: types,
    jsonLdPresent: jsonLd === 'pass' || jsonLd === 'warn',
    llmsTxtStatus: llms,
    llmsFullStatus: full,
    generatedLlmsTxt: downloads.llmsTxt,
    generatedJsonLd: downloads.jsonLd,
    note: tx(
      'Coverage comes from the embedded Agent Readiness checks (JSON-LD 50, llms.txt 35, llms-full.txt 15). The downloads are a starting file, not extra points.',
      '覆盖情况来自嵌入的 Agent 就绪检查（JSON-LD 50，llms.txt 35，llms-full.txt 15）。下载的文件是一份起步稿，不加分。',
    ),
    error: null,
  }
}

function statusOf(report: AgentReadinessReport, id: string): SignalCheckStatus {
  const check = report.checks.find((item) => item.id === id)
  if (!check) return 'unknown'
  return check.status
}

function schemaTypes(report: AgentReadinessReport): string[] {
  const check = report.checks.find((item) => item.id === 'page.jsonld')
  const value = check?.evidence?.types
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

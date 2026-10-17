/** 内容原子单元 */
export interface Atom {
  text: string
  subject: string
  predicate: string
  object: string
  anchors: string[]
  definition?: string
}

/** 原子评分明细 */
export interface AtomScore {
  total: number
  hasNumericAnchor: boolean
  hasEntityAnchor: boolean
  isSelfContained: boolean
  hasDefinition: boolean
}

/** 评分后的原子单元 */
export interface ScoredAtom extends Atom {
  score: AtomScore
}

/** 段落可引用性评分（GEO） */
export interface CitabilityScore {
  total: number
  lengthScore: number
  frontLoadBonus: boolean
  hasDefinitionPattern: boolean
  hasAttribution: boolean
  hasUniqueData: boolean
}

/** 段落可引用性输入 */
export interface CitabilityInput {
  text: string
  positionRatio: number
  hasAttribution?: boolean
  hasUniqueData?: boolean
}

/** E-E-A-T 评分 */
export interface EeatScore {
  total: number
  experience: number
  expertise: number
  authoritativeness: number
  trustworthiness: number
  whoHowWhyPassed: boolean
}

/** E-E-A-T 输入 */
export interface EeatInput {
  hasOriginalResearch: boolean
  hasCaseStudies: boolean
  hasAuthorByline: boolean
  hasAuthorCredentials: boolean
  hasExternalCitations: boolean
  hasBrandMentions: boolean
  hasContactInfo: boolean
  hasHttps: boolean
  hasDateStamps: boolean
  hasCorrectionsPolicy: boolean
}

/** 问答对 */
export interface FaqPair {
  question: string
  answer: string
  matchedQueryId?: string
  source: 'citation_query' | 'llm_generated'
}

/** 优化报告指标 */
export interface OptimizationReport {
  atomizationRate: number
  independenceRate: number
  faqCoverage: number
  citabilityScore?: number
  eeatScore?: number
}

/** 流水线最终输出 */
export interface OptimizationResult {
  atoms: ScoredAtom[]
  faqs: FaqPair[]
  overallScore: number
  rewrittenCount: number
  report: OptimizationReport
}

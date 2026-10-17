/** LLM 抽取的原始实体 */
export interface RawEntity {
  name: string
  rawType: string
  properties: Record<string, unknown>
  sourceSpan?: { start: number; end: number }
}

/** LLM 抽取的关系 */
export interface RawRelation {
  fromName: string
  toName: string
  relationType: string
  properties?: Record<string, unknown>
}

/** 单次抽取的完整结果 */
export interface ExtractionResult {
  entities: RawEntity[]
  relations: RawRelation[]
  extractionNotes?: string
}

/** 类型适配器接口：把原始实体映射到目标领域类型 */
export interface TypeAdapter<TOut> {
  adapt(raw: RawEntity[]): TOut[]
}

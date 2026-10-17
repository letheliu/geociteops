/** KG 待入库实体 */
export interface KgEntityDraft {
  name: string
  type: string
  properties: Record<string, unknown>
  sourceUrl?: string
}

/** KG 待入库关系 */
export interface KgRelationDraft {
  fromName: string
  toName: string
  relationType: string
  properties?: Record<string, unknown>
}

/** KG 提案（持久化到 OptimizationTask.result 用） */
export interface KgProposalSet {
  entities: KgEntityDraft[]
  relations: KgRelationDraft[]
  sourcePageUrl: string
  extractedAt: string
}

/** 导出格式 */
export type ExportFormat = 'jsonld' | 'turtle'

/** 导出选项 */
export interface ExportInput {
  workspaceId: string
  format: ExportFormat
  entityIds?: string[]
}

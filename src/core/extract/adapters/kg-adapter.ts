import type { RawEntity, TypeAdapter } from '../types.js'
import type { KgEntityDraft } from '../../../modules/knowledge-graph/types.js'

export interface KgAdapterService {
  adapt(raw: RawEntity[]): KgEntityDraft[]
}

export function createKgAdapter(): KgAdapterService & TypeAdapter<KgEntityDraft> {
  return {
    adapt(raw) {
      return raw.map((e) => ({
        name: e.name,
        type: e.rawType,
        properties: e.properties,
      }))
    },
  }
}

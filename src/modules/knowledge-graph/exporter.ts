import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'
import type { ExportInput } from './types.js'

const KG_VOCAB = 'https://your-domain.com/kg/'
const SCHEMA_VOCAB = 'https://schema.org/'

export interface GraphExporterService {
  export(input: ExportInput): Promise<string>
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
}

function escapeTtl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

export function createGraphExporter(prisma: PrismaClient): GraphExporterService {
  return {
    async export(input) {
      const where: any = { workspaceId: input.workspaceId }
      if (input.entityIds && input.entityIds.length > 0) {
        where.id = { in: input.entityIds }
      }
      const entities = await prisma.kgEntity.findMany({ where })
      const relations = await prisma.kgRelation.findMany({
        where: {
          OR: [
            { fromEntity: { workspaceId: input.workspaceId } },
            { toEntity: { workspaceId: input.workspaceId } },
          ],
        },
      })

      return input.format === 'jsonld' ? toJsonLd(entities, relations) : toTurtle(entities, relations)
    },
  }
}

function toJsonLd(entities: KgEntity[], relations: KgRelation[]): string {
  const entityIndex = new Map(entities.map((e) => [e.id, e]))
  const graph = entities.map((e) => {
    const props = (e.properties as Record<string, unknown>) ?? {}
    const node: Record<string, unknown> = {
      '@id': `kg:${slugify(e.name)}`,
      '@type': e.type,
      ...props,
    }
    return node
  })

  // 把 relations 附加到 from 节点的 kg:relationType 字段
  for (const rel of relations) {
    const from = entityIndex.get(rel.fromEntityId)
    const to = entityIndex.get(rel.toEntityId)
    if (!from || !to) continue
    const fromNode = graph.find((n) => (n as any)['@id'] === `kg:${slugify(from.name)}`)
    if (fromNode) {
      fromNode[`kg:${rel.relationType}`] = { '@id': `kg:${slugify(to.name)}` }
    }
  }

  return JSON.stringify({
    '@context': {
      '@vocab': SCHEMA_VOCAB,
      kg: KG_VOCAB,
    },
    '@graph': graph,
  }, null, 2)
}

function toTurtle(entities: KgEntity[], relations: KgRelation[]): string {
  const lines: string[] = []
  lines.push(`@prefix kg: <${KG_VOCAB}> .`)
  lines.push(`@prefix schema: <${SCHEMA_VOCAB}> .`)
  lines.push('')

  for (const e of entities) {
    const id = `kg:${slugify(e.name)}`
    lines.push(`${id} a schema:${e.type} ;`)
    const props = (e.properties as Record<string, unknown>) ?? {}
    const propKeys = Object.keys(props)
    propKeys.forEach((key, idx) => {
      const sep = idx === propKeys.length - 1 ? '.' : ';'
      const v = props[key]
      if (typeof v === 'string') {
        lines.push(`    schema:${key} "${escapeTtl(v)}"${sep}`)
      }
    })
    if (propKeys.length === 0) lines[lines.length - 1] = `${id} a schema:${e.type} .`
    lines.push('')
  }

  for (const rel of relations) {
    const fromEntity = entities.find((e) => e.id === rel.fromEntityId)
    const toEntity = entities.find((e) => e.id === rel.toEntityId)
    if (!fromEntity || !toEntity) continue
    lines.push(`kg:${slugify(fromEntity.name)} kg:${rel.relationType} kg:${slugify(toEntity.name)} .`)
  }

  return lines.join('\n').trim() + '\n'
}

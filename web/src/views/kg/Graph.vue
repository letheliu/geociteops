<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { NCard, NButton, NSpace, NSelect, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import { Network, type Node, type Edge, type Options } from 'vis-network'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const containerRef = ref<HTMLElement>()
let network: Network | null = null

const formatOptions = [
  { label: 'JSON-LD', value: 'jsonld' },
  { label: 'Turtle', value: 'turtle' },
]
const selectedFormat = ref<'jsonld' | 'turtle'>('jsonld')
const exportData = ref<string>('')

const typeColors: Record<string, string> = {
  SoftwareApplication: '#2080f0',
  Product: '#f0a020',
  Organization: '#18a058',
  Feature: '#d03050',
  default: '#909399',
}

async function loadData() {
  loading.value = true
  try {
    const [entities, relations] = await Promise.all([
      trpc.kg.listEntities.query(),
      trpc.kg.listRelations.query(),
    ])

    const nodes: Node[] = entities.map((e: any) => ({
      id: e.id,
      label: e.name,
      group: e.type,
      color: { background: typeColors[e.type] || typeColors.default },
      title: `${e.type}\n${JSON.stringify(e.properties, null, 2)}`,
      font: { size: 14 },
    }))

    const edges: Edge[] = relations.map((r: any) => ({
      from: r.fromEntityId,
      to: r.toEntityId,
      label: r.relationType,
      arrows: 'to',
      font: { size: 10, align: 'middle' },
    }))

    if (containerRef.value) {
      if (network) network.destroy()
      const options: Options = {
        physics: { stabilization: true, barnesHut: { gravitationalConstant: -3000 } },
        interaction: { hover: true, tooltipDelay: 200 },
      }
      network = new Network(containerRef.value, { nodes, edges }, options)
    }
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

async function handleExport() {
  try {
    const result = await trpc.kg.export.query({ format: selectedFormat.value })
    if (selectedFormat.value === 'jsonld') {
      exportData.value = JSON.stringify(result, null, 2)
    } else {
      exportData.value = String(result)
    }
  } catch (e: any) {
    message.error(e?.message || '导出失败')
  }
}

function downloadExport() {
  const ext = selectedFormat.value === 'jsonld' ? 'jsonld' : 'ttl'
  const blob = new Blob([exportData.value], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `knowledge-graph.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div>
    <PageHeader title="图谱可视化" subtitle="力导向网络图 + 导出" />

    <NSpace justify="space-between" style="margin-bottom: 16px">
      <NSpace>
        <NTag v-for="(color, type) in typeColors" :key="type" :style="{ '--n-color': color + '20', '--n-text-color': color, fontSize: '11px' }" size="small">
          {{ type }}
        </NTag>
      </NSpace>
      <NSpace>
        <NSelect v-model:value="selectedFormat" :options="formatOptions" style="width: 120px" />
        <NButton @click="handleExport">导出</NButton>
        <NButton v-if="exportData" quaternary @click="downloadExport">下载文件</NButton>
      </NSpace>
    </NSpace>

    <NCard>
      <NSpin :show="loading">
        <div ref="containerRef" style="height: 500px; min-height: 400px" />
      </NSpin>
    </NCard>

    <NCard v-if="exportData" title="导出结果" style="margin-top: 16px">
      <pre style="background: var(--code-color); padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; max-height: 400px; margin: 0">{{ exportData }}</pre>
    </NCard>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NDataTable, NTag, NSpace, NSelect, NButton, NModal, NCode, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const data = ref<any[]>([])

const typeFilter = ref<string | null>(null)
const typeOptions = [
  { label: '全部', value: '' },
  { label: 'SoftwareApplication', value: 'SoftwareApplication' },
  { label: 'Organization', value: 'Organization' },
  { label: 'Product', value: 'Product' },
  { label: 'FAQPage', value: 'FAQPage' },
  { label: 'Article', value: 'Article' },
  { label: 'BreadcrumbList', value: 'BreadcrumbList' },
  { label: 'LlmsTxt', value: 'LlmsTxt' },
]

const showDetail = ref(false)
const selected = ref<any>(null)

const typeColors: Record<string, string> = {
  SoftwareApplication: 'info',
  Organization: 'success',
  Product: 'warning',
  FAQPage: 'error',
  Article: 'default',
  BreadcrumbList: 'info',
  LlmsTxt: 'success',
}

async function loadData() {
  loading.value = true
  try {
    data.value = await trpc.schema.list.query(
      typeFilter.value ? { schemaType: typeFilter.value } : undefined,
    )
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

function showRow(row: any) {
  selected.value = row
  showDetail.value = true
}

const columns: DataTableColumns<any> = [
  {
    title: '类型',
    key: 'schemaType',
    width: 160,
    render(row) {
      return h(NTag, { size: 'small', type: (typeColors[row.schemaType] || 'default') as any }, { default: () => row.schemaType })
    },
  },
  { title: '页面 URL', key: 'pageUrl', ellipsis: { tooltip: true } },
  { title: '版本', key: 'version', width: 80, render(row) { return `v${row.version}` } },
  {
    title: '时间',
    key: 'createdAt',
    width: 160,
    render(row) { return new Date(row.createdAt).toLocaleString('zh-CN') },
  },
  {
    title: '',
    key: 'actions',
    width: 80,
    render(row) {
      return h(NButton, { size: 'small', quaternary: true, onClick: () => showRow(row) }, { default: () => '查看' })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="Schema 记录" subtitle="JSON-LD 与 llms.txt 生成历史" />

    <NSpace style="margin-bottom: 16px">
      <NSelect
        v-model:value="typeFilter"
        :options="typeOptions"
        style="width: 200px"
        @update:value="loadData"
      />
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="data"
        :loading="loading"
        :bordered="false"
        :row-key="(row: any) => row.id"
      />
    </NCard>

    <NModal v-model:show="showDetail" preset="card" :title="`${selected?.schemaType} - v${selected?.version}`" style="width: 640px">
      <div style="margin-bottom: 8px; font-size: 13px; color: var(--text-color-3)">{{ selected?.pageUrl }}</div>
      <pre style="background: var(--code-color); padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; max-height: 500px; margin: 0"><NCode :code="typeof selected?.content === 'string' ? selected.content : JSON.stringify(selected?.content, null, 2)" language="json" /></pre>
    </NModal>
  </div>
</template>

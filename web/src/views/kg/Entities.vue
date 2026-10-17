<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NSpace, NModal, NForm, NFormItem,
  NInput, NSelect, NPopconfirm, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import JsonViewer from '../../components/common/JsonViewer.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const data = ref<any[]>([])
const types = ref<string[]>([])

const showModal = ref(false)
const formData = ref({ name: '', type: '', properties: '{}' })

// Extract from page
const showExtractModal = ref(false)
const pages = ref<any[]>([])
const extractLoading = ref(false)

async function loadData() {
  loading.value = true
  try {
    data.value = await trpc.kg.listEntities.query()
    const typeSet = new Set(data.value.map((e) => e.type))
    types.value = Array.from(typeSet)
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

async function handleAdd() {
  if (!formData.value.name || !formData.value.type) {
    message.warning('请填写名称和类型')
    return
  }
  let props = {}
  try {
    props = JSON.parse(formData.value.properties || '{}')
  } catch {
    message.warning('属性 JSON 格式错误')
    return
  }
  try {
    await trpc.kg.addEntity.mutate({
      name: formData.value.name,
      type: formData.value.type,
      properties: props,
    })
    message.success('已添加')
    showModal.value = false
    formData.value = { name: '', type: '', properties: '{}' }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '添加失败')
  }
}

async function handleDelete(row: any) {
  try {
    await trpc.kg.removeEntity.mutate({ id: row.id })
    message.success('已删除')
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '删除失败')
  }
}

async function openExtract() {
  try {
    pages.value = await trpc.content.pages.list.query()
  } catch {
    pages.value = []
  }
  showExtractModal.value = true
}

async function handleExtract(pageId: string) {
  extractLoading.value = true
  try {
    await trpc.kg.extractFromPage.mutate({ pageId })
    message.success('抽取任务已创建，请在优化任务中审核')
    showExtractModal.value = false
  } catch (e: any) {
    message.error(e?.message || '抽取失败')
  } finally {
    extractLoading.value = false
  }
}

const columns: DataTableColumns<any> = [
  { title: '名称', key: 'name', width: 200 },
  {
    title: '类型',
    key: 'type',
    width: 140,
    render(row) {
      return h(NTag, { size: 'small', type: 'info' }, { default: () => row.type })
    },
  },
  {
    title: '属性',
    key: 'properties',
    ellipsis: { tooltip: true },
    render(row) {
      return JSON.stringify(row.properties)
    },
  },
  { title: '来源', key: 'sourceUrl', width: 200, ellipsis: { tooltip: true } },
  {
    title: '',
    key: 'actions',
    width: 80,
    render(row) {
      return h(NPopconfirm, { onPositiveClick: () => handleDelete(row) }, {
        trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '删除' }),
        default: () => '确认删除？',
      })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="实体管理" subtitle="知识图谱实体 CRUD" />

    <NSpace justify="space-between" style="margin-bottom: 16px">
      <NSelect
        :options="[{ label: '全部', value: '' }, ...types.map(t => ({ label: t, value: t }))]"
        style="width: 180px"
        @update:value="async (v: string) => { loading = true; try { data = v ? (await trpc.kg.listEntities.query({ type: v })) : (await trpc.kg.listEntities.query()) } finally { loading = false } }"
      />
      <NSpace>
        <NButton @click="openExtract">📥 从页面抽取</NButton>
        <NButton type="primary" @click="showModal = true">+ 添加实体</NButton>
      </NSpace>
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

    <NModal v-model:show="showModal" preset="card" title="添加实体" style="width: 480px">
      <NForm>
        <NFormItem label="名称">
          <NInput v-model:value="formData.name" placeholder="zoomer.top" />
        </NFormItem>
        <NFormItem label="类型">
          <NInput v-model:value="formData.type" placeholder="SoftwareApplication" />
        </NFormItem>
        <NFormItem label="属性 (JSON)">
          <NInput v-model:value="formData.properties" type="textarea" :rows="4" placeholder='{"url":"...","description":"..."}' />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" @click="handleAdd">添加</NButton>
        </NSpace>
      </NForm>
    </NModal>

    <NModal v-model:show="showExtractModal" preset="card" title="从页面抽取实体" style="width: 480px">
      <NDataTable
        :columns="[
          { title: 'URL', key: 'url', ellipsis: { tooltip: true } },
          { title: '类型', key: 'pageType', width: 100 },
          {
            title: '',
            key: 'actions',
            width: 80,
            render: (row: any) => h(NButton, { size: 'small', type: 'primary', loading: extractLoading, onClick: () => handleExtract(row.id) }, { default: () => '抽取' }),
          },
        ]"
        :data="pages"
        :bordered="false"
        :row-key="(row: any) => row.id"
        :max-height="300"
      />
    </NModal>
  </div>
</template>

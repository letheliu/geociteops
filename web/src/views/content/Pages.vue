<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NSpace, NModal, NForm, NFormItem,
  NInput, NSelect, useMessage,
} from 'naive-ui'
import { useRouter } from 'vue-router'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import ScoreBar from '../../components/common/ScoreBar.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const router = useRouter()
const loading = ref(true)
const data = ref<any[]>([])

const showModal = ref(false)
const formData = ref({ url: '', pageType: 'blog', currentContent: '' })
const submitting = ref(false)

const pageTypeOptions = [
  { label: 'Blog', value: 'blog' },
  { label: 'Docs', value: 'docs' },
  { label: 'Whitepaper', value: 'whitepaper' },
  { label: 'Landing', value: 'landing' },
  { label: 'About', value: 'about' },
]

const statusColors: Record<string, any> = {
  DRAFT: 'default',
  REVIEWED: 'warning',
  PUBLISHED: 'success',
}

async function loadData() {
  loading.value = true
  try {
    data.value = await trpc.content.pages.list.query()
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

async function handleAdd() {
  if (!formData.value.url || !formData.value.currentContent) {
    message.warning('请填写 URL 和内容')
    return
  }
  submitting.value = true
  try {
    await trpc.content.pages.upsert.mutate({
      url: formData.value.url,
      pageType: formData.value.pageType,
      currentContent: formData.value.currentContent,
    })
    message.success('已保存')
    showModal.value = false
    formData.value = { url: '', pageType: 'blog', currentContent: '' }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    submitting.value = false
  }
}

const columns: DataTableColumns<any> = [
  {
    title: '状态',
    key: 'status',
    width: 100,
    render(row) {
      return h(NTag, { size: 'small', type: statusColors[row.status] || 'default' }, { default: () => row.status })
    },
  },
  { title: 'URL', key: 'url', ellipsis: { tooltip: true } },
  { title: '类型', key: 'pageType', width: 100 },
  {
    title: '分数',
    key: 'optimizationScore',
    width: 140,
    render(row) {
      return h(ScoreBar, { score: row.optimizationScore || 0 })
    },
  },
  {
    title: '',
    key: 'actions',
    width: 120,
    render(row) {
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', quaternary: true, onClick: () => router.push(`/content/pages/${row.id}`) }, { default: () => '查看' }),
        ],
      })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="内容页面" subtitle="管理需要优化的页面内容" />

    <NSpace justify="end" style="margin-bottom: 16px">
      <NButton type="primary" @click="showModal = true">+ 新增页面</NButton>
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

    <NModal v-model:show="showModal" preset="card" title="新增页面" style="width: 640px">
      <NForm>
        <NFormItem label="URL">
          <NInput v-model:value="formData.url" placeholder="/features/ai-search" />
        </NFormItem>
        <NFormItem label="页面类型">
          <NSelect v-model:value="formData.pageType" :options="pageTypeOptions" />
        </NFormItem>
        <NFormItem label="原始内容">
          <NInput v-model:value="formData.currentContent" type="textarea" :rows="10" placeholder="粘贴页面原始内容..." />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" :loading="submitting" @click="handleAdd">保存</NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

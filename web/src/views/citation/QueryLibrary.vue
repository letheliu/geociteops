<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NSpace, NModal, NForm, NFormItem,
  NInput, NSelect, NInputNumber, NPopconfirm, useMessage, NBadge, NSwitch, NTooltip,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import EmptyState from '../../components/common/EmptyState.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const data = ref<any[]>([])

const showModal = ref(false)
const showGenModal = ref(false)
const formData = ref({ queryText: '', source: 'manual', pageId: null as string | null })
const genForm = ref({ topic: '', count: 10 })
const genLoading = ref(false)

// ===== M2 §3.3 关联页面（pageId 下拉制：不收自由 URL，服务端写 mappedPageUrl=page.url）=====
const showMapModal = ref(false)
const mapTarget = ref<any>(null)
const mapPageId = ref<string | null>(null)
const mapLoading = ref(false)
const pages = ref<any[]>([])
const pageOptions = computed(() =>
  pages.value.map((p) => ({ label: p.url, value: p.id })),
)

async function loadPages() {
  try {
    pages.value = await trpc.content.pages.list.query()
  } catch (e: any) {
    message.error(e?.message || '加载页面失败')
  }
}

async function openAddModal() {
  showModal.value = true
  await loadPages()
}

async function openMapModal(row: any) {
  mapTarget.value = row
  mapPageId.value = null
  showMapModal.value = true
  await loadPages()
}

async function handleSetMapping() {
  if (!mapTarget.value || !mapPageId.value) {
    message.warning('请选择关联页面')
    return
  }
  mapLoading.value = true
  try {
    await trpc.citation.queries.setPageMapping.mutate({
      queryId: mapTarget.value.id,
      pageId: mapPageId.value,
    })
    message.success('已关联页面')
    showMapModal.value = false
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '关联失败')
  } finally {
    mapLoading.value = false
  }
}

const sourceOptions = [
  { label: '手动录入', value: 'manual' },
  { label: 'Google Suggest', value: 'google_suggest' },
  { label: 'LLM 生成', value: 'llm_generated' },
  { label: 'PAA', value: 'paa' },
  { label: '竞品', value: 'competitor' },
]

const sourceColors: Record<string, string> = {
  MANUAL: 'default',
  GOOGLE_SUGGEST: 'info',
  LLM_GENERATED: 'success',
  PAA: 'warning',
  COMPETITOR: 'error',
}

async function loadData() {
  loading.value = true
  try {
    data.value = await trpc.citation.queries.list.query()
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

async function handleAdd() {
  if (!formData.value.queryText.trim()) {
    message.warning('请输入查询文本')
    return
  }
  try {
    if (formData.value.pageId && pages.value.length === 0) await loadPages()
    await trpc.citation.queries.add.mutate({
      queryText: formData.value.queryText,
      source: formData.value.source as any,
      ...(formData.value.pageId ? { pageId: formData.value.pageId } : {}),
    })
    message.success('已添加')
    showModal.value = false
    formData.value = { queryText: '', source: 'manual', pageId: null }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '添加失败')
  }
}

async function handleGenerate() {
  if (!genForm.value.topic.trim()) {
    message.warning('请输入主题')
    return
  }
  genLoading.value = true
  try {
    const result = await trpc.citation.queries.generate.mutate({
      topic: genForm.value.topic,
      count: genForm.value.count,
    })
    message.success(`生成了 ${Array.isArray(result) ? result.length : 0} 个查询`)
    showGenModal.value = false
    genForm.value = { topic: '', count: 10 }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '生成失败')
  } finally {
    genLoading.value = false
  }
}

async function handleToggle(row: any) {
  try {
    if (row.status === 'ACTIVE') {
      await trpc.citation.queries.pause.mutate({ id: row.id })
      message.success('已暂停')
    } else {
      await trpc.citation.queries.resume.mutate({ id: row.id })
      message.success('已激活')
    }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

async function handleDelete(id: string) {
  try {
    await trpc.citation.queries.delete.mutate({ id })
    message.success('已删除')
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '删除失败')
  }
}

async function handleToggleScheduled(row: any) {
  const next = !row.scheduled
  try {
    await trpc.citation.queries.setScheduled.mutate({ id: row.id, scheduled: next })
    message.success(next ? '已加入定时监测' : '已退出定时监测')
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '切换失败')
  }
}

const columns: DataTableColumns<any> = [
  {
    title: '状态',
    key: 'status',
    width: 80,
    render(row) {
      return h(NBadge, {
        type: row.status === 'ACTIVE' ? 'success' : 'default',
        dot: true,
      }, { default: () => row.status === 'ACTIVE' ? '活跃' : '暂停' })
    },
  },
  {
    // scheduled=false 只退出「定时」；status=PAUSED 才退出所有运行（含手动）
    title: '定时',
    key: 'scheduled',
    width: 70,
    render(row) {
      return h(
        NTooltip,
        {
          trigger: 'hover',
        },
        {
          trigger: () => h(NSwitch, {
            size: 'small',
            value: row.scheduled !== false,
            disabled: row.status !== 'ACTIVE',
            'onUpdate:value': () => handleToggleScheduled(row),
          }),
          default: () =>
            row.status !== 'ACTIVE'
              ? '查询已暂停，不参与任何运行'
              : row.scheduled === false
                ? '不参与定时监测（手动触发仍可用）'
                : '参与定时监测',
        },
      )
    },
  },
  { title: 'Query', key: 'queryText', ellipsis: { tooltip: true } },
  {
    title: '来源',
    key: 'source',
    width: 120,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: (sourceColors[row.source] || 'default') as any,
      }, { default: () => row.source })
    },
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 180,
    render(row) {
      return new Date(row.createdAt).toLocaleString('zh-CN')
    },
  },
  {
    // 映射失效语义：optimizeFromWeakPoint 按此 url 解析页面，
    // 页面被删/换 url 后映射即失效（一键优化会被拒并提示重新关联）
    title: '关联页面',
    key: 'mappedPageUrl',
    width: 160,
    ellipsis: { tooltip: true },
    render(row) {
      return row.mappedPageUrl || '未关联'
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 210,
    render(row) {
      return h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, {
            size: 'tiny',
            onClick: () => openMapModal(row),
          }, { default: () => (row.mappedPageUrl ? '改关联' : '关联页面') }),
          h(NButton, {
            size: 'tiny',
            type: row.status === 'ACTIVE' ? 'warning' : 'success',
            onClick: () => handleToggle(row),
          }, { default: () => row.status === 'ACTIVE' ? '暂停' : '激活' }),
          h(NPopconfirm, {
            onPositiveClick: () => handleDelete(row.id),
          }, {
            trigger: () => h(NButton, { size: 'tiny', type: 'error' }, { default: () => '删除' }),
            default: () => '确认删除？',
          }),
        ],
      })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="查询库管理" subtitle="管理 AI 搜索监测的查询词" />

    <NSpace justify="space-between" style="margin-bottom: 16px">
      <NSpace />
      <NSpace>
        <NButton @click="showGenModal = true">🤖 LLM 批量生成</NButton>
        <NButton type="primary" @click="openAddModal">+ 手动添加</NButton>
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

    <!-- 手动添加 -->
    <NModal v-model:show="showModal" preset="card" title="添加查询" style="width: 480px">
      <NForm>
        <NFormItem label="查询文本">
          <NInput v-model:value="formData.queryText" placeholder="AI设计工具哪个好" />
        </NFormItem>
        <NFormItem label="来源">
          <NSelect v-model:value="formData.source" :options="sourceOptions" />
        </NFormItem>
        <NFormItem label="关联页面（可选）">
          <NSelect
            v-model:value="formData.pageId"
            :options="pageOptions"
            clearable
            placeholder="选择要优化的内容页"
          />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" @click="handleAdd">添加</NButton>
        </NSpace>
      </NForm>
    </NModal>

    <!-- 关联页面（M2 §3.3）：只允许从本工作区的 ContentPage 中选 -->
    <NModal v-model:show="showMapModal" preset="card" title="关联页面" style="width: 480px">
      <NForm>
        <NFormItem :label="`为「${mapTarget?.queryText ?? ''}」关联页面`">
          <NSelect v-model:value="mapPageId" :options="pageOptions" placeholder="选择内容页" />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="showMapModal = false">取消</NButton>
          <NButton type="primary" :loading="mapLoading" @click="handleSetMapping">保存</NButton>
        </NSpace>
      </NForm>
    </NModal>

    <!-- LLM 批量生成 -->
    <NModal v-model:show="showGenModal" preset="card" title="LLM 批量生成查询" style="width: 480px">
      <NForm>
        <NFormItem label="主题">
          <NInput v-model:value="genForm.topic" placeholder="AI 协作工具" />
        </NFormItem>
        <NFormItem label="数量">
          <NInputNumber v-model:value="genForm.count" :min="1" :max="100" style="width: 100%" />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="showGenModal = false">取消</NButton>
          <NButton type="primary" :loading="genLoading" @click="handleGenerate">生成</NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

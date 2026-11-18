<script setup lang="ts">
import { ref, onMounted, h, watchEffect } from 'vue'
import {
  NCard, NDataTable, NTag, NSpace, NButton, NDrawer, NDrawerContent,
  NTabs, NTabPane, NInput, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import JsonViewer from '../../components/common/JsonViewer.vue'
import { trpc } from '../../composables/useTrpc'
import { useI18n } from '@/i18n'
const { t, locale: appLocale } = useI18n()


const message = useMessage()
const loading = ref(true)
const data = ref<any[]>([])
const filterStatus = ref<string>('')

const statusFilters = [
  { label: t("全部"), value: '' },
  { label: t("待审"), value: 'pending' },
  { label: t("已审"), value: 'reviewed' },
  { label: t("已发布"), value: 'published' },
  { label: t("待验证"), value: 'awaiting_verification' },
  { label: t("已验证"), value: 'verified' },
]

// Review drawer
const showDrawer = ref(false)
const selectedTask = ref<any>(null)
const reviewNote = ref('')
const reviewLoading = ref(false)

const statusColors: Record<string, any> = {
  PENDING: 'warning',
  IN_PROGRESS: 'info',
  REVIEWED: 'success',
  PUBLISHED: 'success',
  AWAITING_VERIFICATION: 'info',
  VERIFIED: 'success',
  FAILED: 'error',
}

const typeLabels: Record<string, string> = {
  REWRITE_CONTENT: t("内容重写"),
  OPTIMIZE_FOR_QUERY: t("查询优化"),
  GENERATE_SCHEMA: t("Schema 生成"),
  UPDATE_KG: t("知识图谱更新"),
}

async function loadData() {
  loading.value = true
  try {
    data.value = await trpc.tasks.list.query(
      filterStatus.value ? { status: filterStatus.value as any } : undefined,
    )
  } catch (e: any) {
    message.error(e?.message || t("加载失败"))
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

function openReview(row: any) {
  selectedTask.value = row
  reviewNote.value = ''
  showDrawer.value = true
}

async function handleReview(approved: boolean) {
  if (!selectedTask.value) return
  reviewLoading.value = true
  try {
    await trpc.tasks.review.mutate({
      id: selectedTask.value.id,
      approved,
      note: reviewNote.value || undefined,
    })
    message.success(approved ? t("已通过审核") : t("已拒绝"))
    if (approved) {
      // Immediately allow publish
      selectedTask.value.status = 'REVIEWED'
    } else {
      showDrawer.value = false
    }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || t("操作失败"))
  } finally {
    reviewLoading.value = false
  }
}

async function handlePublish() {
  if (!selectedTask.value) return
  reviewLoading.value = true
  try {
    await trpc.tasks.publish.mutate({ id: selectedTask.value.id })
    message.success(t("已发布"))
    showDrawer.value = false
    await loadData()
  } catch (e: any) {
    message.error(e?.message || t("发布失败"))
  } finally {
    reviewLoading.value = false
  }
}

const parsedResult = ref<any>(null)

watchEffect(() => {
  if (selectedTask.value?.result) {
    try {
      parsedResult.value = typeof selectedTask.value.result === 'string'
        ? JSON.parse(selectedTask.value.result)
        : selectedTask.value.result
    } catch {
      parsedResult.value = selectedTask.value.result
    }
  } else {
    parsedResult.value = null
  }
})

const parsedProposals = ref<any>(null)
watchEffect(() => {
  if (selectedTask.value?.extractionProposals) {
    try {
      parsedProposals.value = typeof selectedTask.value.extractionProposals === 'string'
        ? JSON.parse(selectedTask.value.extractionProposals)
        : selectedTask.value.extractionProposals
    } catch {
      parsedProposals.value = selectedTask.value.extractionProposals
    }
  } else {
    parsedProposals.value = null
  }
})

const columns: DataTableColumns<any> = [
  {
    title: t("状态"),
    key: 'status',
    width: 100,
    render(row) {
      return h(NTag, { size: 'small', type: statusColors[row.status] || 'default' }, { default: () => row.status })
    },
  },
  {
    title: t("类型"),
    key: 'type',
    width: 120,
    render(row) {
      return typeLabels[row.type] || row.type
    },
  },
  {
    title: t("分数变化"),
    key: 'score',
    width: 120,
    render(row) {
      if (row.beforeScore != null && row.afterScore != null) {
        return `${row.beforeScore} → ${row.afterScore}`
      }
      return '-'
    },
  },
  {
    title: t("创建时间"),
    key: 'createdAt',
    width: 160,
    render(row) {
      return new Date(row.createdAt).toLocaleString(appLocale.value)
    },
  },
  {
    title: '',
    key: 'actions',
    width: 100,
    render(row) {
      if (row.status === 'PENDING' || row.status === 'REVIEWED') {
        return h(NButton, { size: 'small', type: row.status === 'REVIEWED' ? 'primary' : 'default', onClick: () => openReview(row) }, { default: () => t("审核") })
      }
      return h(NButton, { size: 'small', quaternary: true, onClick: () => openReview(row) }, { default: () => t("查看") })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader :title="t('优化任务')" :subtitle="t('审核 AI 生成的内容优化方案')" />

    <NSpace style="margin-bottom: 16px">
      <NButton
        v-for="f in statusFilters"
        :key="f.value"
        :type="filterStatus === f.value ? 'primary' : 'default'"
        size="small"
        @click="filterStatus = f.value; loadData()"
      >
        {{ f.label }}
      </NButton>
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

    <!-- Review Drawer -->
    <NDrawer v-model:show="showDrawer" :width="600" placement="right">
      <NDrawerContent :title="t('任务审核')" closable>
        <template v-if="selectedTask">
          <NSpace vertical :size="16">
            <NSpace align="center">
              <NTag size="small" :type="statusColors[selectedTask.status]">{{ selectedTask.status }}</NTag>
              <NTag size="small" type="info">{{ typeLabels[selectedTask.type] || selectedTask.type }}</NTag>
            </NSpace>

            <div v-if="selectedTask.beforeScore != null && selectedTask.afterScore != null">
              <span>{{ t('分数:') }} {{ selectedTask.beforeScore }} → {{ selectedTask.afterScore }}</span>
            </div>

            <NTabs v-if="selectedTask.type === 'UPDATE_KG' && parsedProposals">
              <NTabPane name="entities" :tab="`${t('实体 (')}${parsedProposals.entities?.length || 0})`">
                <JsonViewer :data="parsedProposals.entities" />
              </NTabPane>
              <NTabPane name="relations" :tab="`${t('关系 (')}${parsedProposals.relations?.length || 0})`">
                <JsonViewer :data="parsedProposals.relations" />
              </NTabPane>
            </NTabs>

            <div v-else-if="parsedResult">
              <div style="font-weight: 600; margin-bottom: 8px">{{ t('优化结果') }}</div>
              <JsonViewer :data="parsedResult" />
            </div>

            <div v-if="selectedTask.reviewNote">
              <div style="font-weight: 600; margin-bottom: 4px">{{ t('审核备注') }}</div>
              <div style="font-size: 13px; color: var(--text-color-2)">{{ selectedTask.reviewNote }}</div>
            </div>

            <div v-if="selectedTask.status === 'PENDING'">
              <NInput v-model:value="reviewNote" :placeholder="t('审核备注（可选）')" type="textarea" :rows="2" />
            </div>

            <template v-if="selectedTask.status === 'PENDING'">
              <NSpace>
                <NButton type="error" :loading="reviewLoading" @click="handleReview(false)">{{ t('拒绝') }}</NButton>
                <NButton type="success" :loading="reviewLoading" @click="handleReview(true)">{{ t('通过审核') }}</NButton>
              </NSpace>
            </template>
            <template v-else-if="selectedTask.status === 'REVIEWED'">
              <NButton type="primary" :loading="reviewLoading" @click="handlePublish">{{ t('📦 发布') }}</NButton>
            </template>
          </NSpace>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

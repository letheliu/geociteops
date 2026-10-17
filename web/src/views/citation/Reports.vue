<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NSpace, NDatePicker, NSelect,
  NModal, NCheckboxGroup, NCheckbox, useMessage, NDrawer, NDrawerContent,
  NCode, NList, NListItem, NThing,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const data = ref<any[]>([])

const dateRange = ref<[number, number]>([
  Date.now() - 7 * 86400000,
  Date.now(),
])
const platformFilter = ref<string | null>(null)

const platformOptions = [
  { label: '全部', value: '' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: '豆包', value: 'doubao' },
  { label: '通义千问', value: 'qwen' },
  { label: '文心一言', value: 'ernie' },
]

// Trigger monitor modal
const showTrackModal = ref(false)
const trackPlatforms = ref<string[]>(['deepseek'])
const trackQuery = ref('')
const trackLoading = ref(false)

// Event detail drawer
const showDetail = ref(false)
const selectedEvent = ref<any>(null)

const platformCheckbox = [
  { label: 'DeepSeek', value: 'deepseek' },
  { label: '豆包', value: 'doubao' },
  { label: '通义千问', value: 'qwen' },
  { label: '文心一言', value: 'ernie' },
]

async function loadData() {
  loading.value = true
  try {
    const result = await trpc.citation.getReport.query({
      dateRange: {
        start: new Date(dateRange.value[0]).toISOString(),
        end: new Date(dateRange.value[1]).toISOString(),
      },
      platform: platformFilter.value || undefined,
    })
    data.value = result.events || []
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

async function handleTrack() {
  if (trackPlatforms.value.length === 0) {
    message.warning('请选择至少一个平台')
    return
  }
  trackLoading.value = true
  try {
    await trpc.citation.trackQuery.mutate({
      query: trackQuery.value,
      platforms: trackPlatforms.value,
    })
    message.success('监测已触发')
    showTrackModal.value = false
    trackQuery.value = ''
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '触发失败')
  } finally {
    trackLoading.value = false
  }
}

function showEventDetail(row: any) {
  selectedEvent.value = row
  showDetail.value = true
}

const columns: DataTableColumns<any> = [
  {
    title: '时间',
    key: 'capturedAt',
    width: 160,
    render(row) {
      return new Date(row.capturedAt).toLocaleString('zh-CN')
    },
  },
  {
    title: '平台',
    key: 'platform',
    width: 100,
    render(row) {
      return h(NTag, { size: 'small', type: 'info' }, { default: () => row.platform })
    },
  },
  {
    title: '品牌提及',
    key: 'brandMentioned',
    width: 100,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: row.brandMentioned ? 'success' : 'default',
      }, { default: () => row.brandMentioned ? '✅ 提及' : '❌ 未提及' })
    },
  },
  {
    title: '排名',
    key: 'rankInAnswer',
    width: 80,
    render(row) {
      return row.rankInAnswer ? `#${row.rankInAnswer}` : '-'
    },
  },
  {
    title: 'SOV',
    key: 'sovScore',
    width: 80,
    render(row) {
      return row.sovScore ? (row.sovScore * 100).toFixed(0) + '%' : '-'
    },
  },
  {
    title: '答案摘录',
    key: 'rawAnswer',
    ellipsis: { tooltip: true },
    render(row) {
      return row.rawAnswer?.slice(0, 100) + '...'
    },
  },
  {
    title: '',
    key: 'actions',
    width: 80,
    render(row) {
      return h(NButton, { size: 'small', quaternary: true, onClick: () => showEventDetail(row) }, { default: () => '详情' })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="引用报告" subtitle="跨平台引用监测结果" />

    <NSpace justify="space-between" style="margin-bottom: 16px">
      <NSpace>
        <NDatePicker v-model:value="dateRange" type="daterange" clearable @update:value="loadData" />
        <NSelect
          v-model:value="platformFilter"
          :options="platformOptions"
          style="width: 140px"
          @update:value="loadData"
        />
      </NSpace>
      <NButton type="primary" @click="showTrackModal = true">📡 触发监测</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="data"
        :loading="loading"
        :bordered="false"
        :row-key="(row: any) => row.id"
        :pagination="{ pageSize: 15 }"
      />
    </NCard>

    <!-- Trigger Monitor Modal -->
    <NModal v-model:show="showTrackModal" preset="card" title="触发监测" style="width: 480px">
      <NSpace vertical :size="16">
        <div>
          <label style="font-size: 13px; margin-bottom: 6px; display: block">查询文本</label>
          <NInput v-model:value="trackQuery" placeholder="输入要监测的查询" />
        </div>
        <div>
          <label style="font-size: 13px; margin-bottom: 6px; display: block">监测平台</label>
          <NCheckboxGroup v-model:value="trackPlatforms">
            <NSpace>
              <NCheckbox v-for="p in platformCheckbox" :key="p.value" :value="p.value" :label="p.label" />
            </NSpace>
          </NCheckboxGroup>
        </div>
        <NSpace justify="end">
          <NButton @click="showTrackModal = false">取消</NButton>
          <NButton type="primary" :loading="trackLoading" @click="handleTrack">触发</NButton>
        </NSpace>
      </NSpace>
    </NModal>

    <!-- Event Detail Drawer -->
    <NDrawer v-model:show="showDetail" :width="520" placement="right">
      <NDrawerContent title="引用事件详情" closable>
        <template v-if="selectedEvent">
          <NSpace vertical :size="12">
            <div>
              <NTag size="small" type="info">{{ selectedEvent.platform }}</NTag>
              <NTag size="small" :type="selectedEvent.brandMentioned ? 'success' : 'default'" style="margin-left: 8px">
                {{ selectedEvent.brandMentioned ? '✅ 品牌被提及' : '❌ 未提及' }}
              </NTag>
            </div>
            <div v-if="selectedEvent.rankInAnswer">引用排名: #{{ selectedEvent.rankInAnswer }}</div>
            <div v-if="selectedEvent.sovScore">SOV: {{ (selectedEvent.sovScore * 100).toFixed(1) }}%</div>
            <div>
              <div style="font-weight: 600; margin-bottom: 6px">竞品</div>
              <NCode :code="JSON.stringify(selectedEvent.competitors, null, 2)" language="json" />
            </div>
            <div>
              <div style="font-weight: 600; margin-bottom: 6px">引用 URL</div>
              <NCode :code="JSON.stringify(selectedEvent.citedUrls, null, 2)" language="json" />
            </div>
            <div>
              <div style="font-weight: 600; margin-bottom: 6px">原始答案</div>
              <div style="background: var(--code-color); padding: 12px; border-radius: 6px; font-size: 13px; max-height: 300px; overflow: auto; white-space: pre-wrap">{{ selectedEvent.rawAnswer }}</div>
            </div>
          </NSpace>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

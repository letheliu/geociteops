<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NSpace, NDatePicker,
  NModal, NCheckboxGroup, NCheckbox, useMessage, NDrawer, NDrawerContent,
  NCode, NCollapse, NCollapseItem, NInputNumber, NTooltip,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

/**
 * 引用报告（Run 维度，规格 §5/§8）：
 * - 列表 = citation.runs.list：物理 Run 行 + `legacy:<date>` 历史日桶（同样式 + 角标）
 * - 行点击抽屉 = citation.runs.samples：展开该次的全部采样（含 rawAnswer 折叠块）
 */

const message = useMessage()
const loading = ref(true)
const runs = ref<any[]>([])

const dateRange = ref<[number, number]>([
  Date.now() - 30 * 86400000,
  Date.now(),
])

// Trigger monitor modal
const showTrackModal = ref(false)
const trackPlatforms = ref<string[]>(['deepseek'])
const trackSampleCount = ref<number | null>(null)
const trackLoading = ref(false)

// Run detail drawer
const showDetail = ref(false)
const detailLoading = ref(false)
const detail = ref<any>(null)
const detailSamples = ref<any[]>([])
const expanded = ref<string[]>([])

const platformCheckbox = [
  { label: 'DeepSeek', value: 'deepseek' },
  { label: '豆包', value: 'doubao' },
  { label: '通义千问', value: 'qwen' },
  { label: '文心一言', value: 'ernie' },
]

async function loadData() {
  loading.value = true
  try {
    const result = await trpc.citation.runs.list.query({
      dateRange: {
        start: new Date(dateRange.value[0]).toISOString(),
        end: new Date(dateRange.value[1]).toISOString(),
      },
    })
    runs.value = result.runs || []
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
  if (trackSampleCount.value !== null && (trackSampleCount.value < 1 || trackSampleCount.value > 10)) {
    message.warning('采样次数需在 1..10 之间')
    return
  }
  trackLoading.value = true
  try {
    const result = await trpc.citation.runs.create.mutate({
      platforms: trackPlatforms.value,
      sampleCount: trackSampleCount.value ?? undefined,
    })
    if (!result.runId) {
      message.warning('没有可监测的查询，请先在查询库中添加')
      return
    }
    message.success('监测已触发，正在采样…')
    showTrackModal.value = false
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '触发失败')
  } finally {
    trackLoading.value = false
  }
}

async function showRunDetail(row: any) {
  detail.value = row
  detailSamples.value = []
  expanded.value = []
  showDetail.value = true
  detailLoading.value = true
  try {
    const result = row.legacy
      ? await trpc.citation.runs.samples.query({ legacyDay: row.date })
      : await trpc.citation.runs.samples.query({ runId: row.id })
    detail.value = { ...row, ...result.run }
    detailSamples.value = result.events || []
  } catch (e: any) {
    message.error(e?.message || '加载采样明细失败')
  } finally {
    detailLoading.value = false
  }
}

const statusMeta: Record<string, { label: string; type: 'success' | 'warning' | 'error' | 'default' | 'info' }> = {
  COMPLETED: { label: '全部成功', type: 'success' },
  PARTIAL: { label: '部分失败', type: 'warning' },
  FAILED: { label: '全部失败', type: 'error' },
  RUNNING: { label: '运行中', type: 'info' },
}

const triggerLabel: Record<string, string> = {
  SCHEDULED: '定时',
  MANUAL: '手动',
  LEGACY: '历史',
}

const columns: DataTableColumns<any> = [
  {
    title: '时间',
    key: 'startedAt',
    width: 170,
    render(row) {
      return new Date(row.startedAt).toLocaleString('zh-CN')
    },
  },
  {
    title: '来源',
    key: 'trigger',
    width: 90,
    render(row) {
      return h(NTag, { size: 'small', type: 'default' }, { default: () => triggerLabel[row.trigger] ?? row.trigger })
    },
  },
  {
    title: 'N',
    key: 'sampleCount',
    width: 60,
    render(row) {
      return String(row.sampleCount)
    },
  },
  {
    title: '有效 / 失败',
    key: 'validSamples',
    width: 120,
    render(row) {
      return h(
        NSpace,
        { size: 4, align: 'center' },
        {
          default: () => [
            h('span', null, { default: () => String(row.validSamples) }),
            row.failedSamples > 0
              ? h(
                  NTooltip,
                  { trigger: 'hover' },
                  {
                    default: () => h(NTag, { size: 'small', type: 'warning' }, { default: () => String(row.failedSamples) }),
                    trigger: () => '本次失败或缺失的采样数',
                  },
                )
              : h('span', { style: 'color: var(--text-color-3)' }, { default: () => '0' }),
          ],
        },
      )
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render(row) {
      const meta = statusMeta[row.status] ?? { label: row.status, type: 'default' as const }
      return h(NTag, { size: 'small', type: meta.type }, { default: () => meta.label })
    },
  },
  {
    title: '备注',
    key: 'failureReason',
    ellipsis: { tooltip: true },
    render(row) {
      return row.legacy ? '历史事件级聚合口径' : (row.failureReason ?? '')
    },
  },
  {
    title: '',
    key: 'actions',
    width: 80,
    render(row) {
      return h(
        NButton,
        { size: 'small', quaternary: true, onClick: () => showRunDetail(row) },
        { default: () => '明细' },
      )
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="引用报告" subtitle="按运行查看跨平台采样结果" />

    <NSpace justify="space-between" style="margin-bottom: 16px">
      <NSpace>
        <NDatePicker v-model:value="dateRange" type="daterange" clearable @update:value="loadData" />
      </NSpace>
      <NButton type="primary" @click="showTrackModal = true">📡 触发监测</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="runs"
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
          <label style="font-size: 13px; margin-bottom: 6px; display: block">采样次数 N（留空用工作区配置）</label>
          <NInputNumber v-model:value="trackSampleCount" :min="1" :max="10" placeholder="1..10" style="width: 160px" />
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

    <!-- Run Detail Drawer -->
    <NDrawer v-model:show="showDetail" :width="640" placement="right">
      <NDrawerContent :title="detail?.legacy ? `历史日桶 ${detail.date}` : '运行明细'" closable>
        <NSpace v-if="detail" vertical :size="12">
          <NSpace align="center" :size="8">
            <NTag size="small" :type="(statusMeta[detail.status]?.type ?? 'default')">
              {{ statusMeta[detail.status]?.label ?? detail.status }}
            </NTag>
            <NTag size="small" type="default">{{ triggerLabel[detail.trigger] ?? detail.trigger }}</NTag>
            <span style="font-size: 12px; color: var(--text-color-3)">
              N={{ detail.sampleCount }} · 有效 {{ detail.validSamples }}
              <template v-if="detail.failedSamples > 0"> · 失败 {{ detail.failedSamples }}</template>
            </span>
          </NSpace>

          <div v-if="detail.failureReason" style="font-size: 12px; color: var(--warning-color)">
            {{ detail.failureReason }}
          </div>
          <div v-if="detail.slotKey" style="font-size: 12px; color: var(--text-color-3)">
            槽位：{{ detail.slotKey }}（同槽位每日只会有一次运行）
          </div>

          <NCollapse v-model:expanded="expanded">
            <NCollapseItem
              v-for="ev in detailSamples"
              :key="ev.id"
              :title="`${ev.platform} · ${ev.sampleIndex ?? 1} · ${ev.status === 'OK' ? (ev.brandMentioned ? '✅ 提及' : '❌ 未提及') : '⚠️ 采样失败'}`"
            >
              <NSpace vertical :size="8">
                <div style="font-size: 12px; color: var(--text-color-3)">
                  {{ ev.query?.queryText || ev.queryId }}
                  <template v-if="ev.rankInAnswer"> · 排名 #{{ ev.rankInAnswer }}</template>
                  <template v-if="ev.sovScore !== null && ev.sovScore !== undefined">
                    · SOV {{ (ev.sovScore * 100).toFixed(1) }}%
                  </template>
                </div>
                <div v-if="ev.status === 'FAILED'" style="font-size: 12px; color: var(--error-color)">
                  失败原因：{{ ev.failureReason || '未知' }}
                </div>
                <div v-if="ev.rawAnswer" style="background: var(--code-color); padding: 12px; border-radius: 6px; font-size: 13px; max-height: 300px; overflow: auto; white-space: pre-wrap">
                  {{ ev.rawAnswer }}
                </div>
                <div>
                  <div style="font-weight: 600; margin-bottom: 6px">引用 URL</div>
                  <NCode :code="JSON.stringify(ev.citedUrls, null, 2)" language="json" />
                </div>
              </NSpace>
            </NCollapseItem>
          </NCollapse>

          <div v-if="!detailLoading && detailSamples.length === 0" style="color: var(--text-color-3)">
            没有采样明细
          </div>
        </NSpace>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import {
  NCard, NDataTable, NTag, NSpace, NDatePicker, NSwitch, NButton,
  NAlert, NTooltip, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import EmptyState from '../../components/common/EmptyState.vue'
import { trpc } from '../../composables/useTrpc'

/**
 * 引用覆盖矩阵（docs/specs/引用覆盖-设计.md）：
 * - 行 = PUBLISHED 页面,列 = 窗口内出现过的平台
 * - 单元格证据分层:EXACT 绿 / NORMALIZED 蓝 / DOMAIN 灰「域」(域级证据不计入覆盖)
 * - 盲区页 = 窗口内从未 EXACT/NORMALIZED 被引;意图落空 = 映射了目标页但该查询的回答从未引到它
 * 口径详见 docs/METRICS.md——本页只呈现,不另行计算。
 */

const message = useMessage()
const loading = ref(true)
const platforms = ref<string[]>([])
const rows = ref<any[]>([])
const summary = ref<any>(null)
const intentRows = ref<any[]>([])
const blindOnly = ref(false)

const dateRange = ref<[number, number]>([
  Date.now() - 30 * 86400000,
  Date.now(),
])

const platformLabels: Record<string, string> = {
  deepseek: 'DeepSeek',
  doubao: '豆包',
  qwen: '通义千问',
  ernie: '文心一言',
  openai: 'ChatGPT Search',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  claude: 'Claude',
}

const tierTag = (cell: any) => {
  if (!cell) return h('span', { style: { color: '#c2c5cd' } }, { default: () => '—' })
  if (cell.cites > 0 && cell.tier === 'EXACT') {
    return h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => cell.cites })
  }
  if (cell.cites > 0) {
    return h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => cell.cites })
  }
  return h(NTooltip, null, {
    trigger: () => h(NTag, { size: 'small', type: 'default', bordered: false }, { default: () => '域' }),
    default: () => '本域被该平台引用,但未定位到本页(域级证据,不计入覆盖)',
  })
}

const visibleRows = computed(() =>
  blindOnly.value ? rows.value.filter((r: any) => r.blindSpot) : rows.value,
)

const matrixColumns = computed<DataTableColumns<any>>(() => [
  {
    title: '页面',
    key: 'url',
    minWidth: 260,
    ellipsis: { tooltip: true },
    render(row) {
      return h(NSpace, { size: 2, vertical: true }, {
        default: () => [
          h('span', {}, { default: () => row.url }),
          row.blindSpot
            ? h(NTag, { size: 'tiny', type: row.domainOnly ? 'warning' : 'error', bordered: false }, {
                default: () => (row.domainOnly ? '盲区 · 仅域级证据' : '盲区'),
              })
            : null,
        ],
      })
    },
  },
  {
    title: '可引分',
    key: 'citabilityScore',
    width: 90,
    render: (row) => (row.citabilityScore === null || row.citabilityScore === undefined ? '—' : (row.citabilityScore as number).toFixed(2)),
  },
  ...platforms.value.map((p) => ({
    title: platformLabels[p] ?? p,
    key: p,
    width: 110,
    render: (row: any) => tierTag(row.perPlatform?.[p]),
  })),
  {
    title: '被引平台数',
    key: 'coveredPlatforms',
    width: 110,
    sorter: (a: any, b: any) => a.coveredPlatforms - b.coveredPlatforms,
    render: (row) => `${row.coveredPlatforms} / ${platforms.value.length}`,
  },
  { title: '被引次数', key: 'totalCites', width: 100, sorter: (a: any, b: any) => a.totalCites - b.totalCites },
])

const intentColumns: DataTableColumns<any> = [
  { title: '查询', key: 'queryText', ellipsis: { tooltip: true } },
  { title: '映射页面', key: 'mappedPageUrl', ellipsis: { tooltip: true } },
  {
    title: '目标页被引(本查询)',
    key: 'cites',
    width: 160,
    render(row) {
      return row.miss
        ? h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => '落空 · 0 次' })
        : h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => `${row.cites} 次` })
    },
  },
]

async function loadData() {
  loading.value = true
  try {
    const result = await trpc.citation.coverage.query({
      dateRange: {
        start: new Date(dateRange.value[0]).toISOString(),
        end: new Date(dateRange.value[1]).toISOString(),
      },
    })
    platforms.value = result.platforms
    rows.value = result.rows
    summary.value = result.summary
    intentRows.value = result.intentRows
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`)
</script>

<template>
  <div>
    <PageHeader title="引用覆盖" subtitle="已发布页面 × AI 平台的被引矩阵:哪些页面被引、哪些是盲区、哪些只有域级证据" />

    <n-alert type="info" :show-icon="true" style="margin-bottom: 12px">
      覆盖只认 EXACT / NORMALIZED 证据;「域」= 本域被引用但未定位到该页,不计入覆盖。无样本的平台不显示列(证据不存在 ≠ 覆盖为零)。
    </n-alert>

    <n-space vertical size="large">
      <n-space align="center" justify="space-between" style="width: 100%">
        <n-date-picker v-model:value="dateRange" type="daterange" clearable :disabled="loading" />
        <n-space align="center">
          <span style="font-size: 13px; color: #666">只看盲区</span>
          <n-switch v-model:value="blindOnly" size="small" />
          <n-button size="small" :loading="loading" @click="loadData">刷新</n-button>
        </n-space>
      </n-space>

      <n-space v-if="summary" size="large">
        <n-card size="small" style="min-width: 140px">
          <template #header>覆盖率</template>
          <span style="font-size: 26px; font-weight: 600">{{ pct(summary.coverageRate) }}</span>
        </n-card>
        <n-card size="small" style="min-width: 140px">
          <template #header>已覆盖页 / 总页</template>
          <span style="font-size: 26px; font-weight: 600">{{ summary.coveredPages }} / {{ summary.totalPages }}</span>
        </n-card>
        <n-card size="small" style="min-width: 140px">
          <template #header>盲区页</template>
          <span style="font-size: 26px; font-weight: 600; color: #d03050">{{ summary.blindSpotCount }}</span>
        </n-card>
        <n-card size="small" style="min-width: 160px">
          <template #header>仅域级证据</template>
          <span style="font-size: 26px; font-weight: 600; color: #f0a020">{{ summary.domainOnlyCount }}</span>
        </n-card>
      </n-space>

      <n-card title="覆盖矩阵" size="small">
        <EmptyState v-if="!loading && visibleRows.length === 0" description="窗口内没有已发布页面或没有匹配行" />
        <n-data-table
          v-else
          :loading="loading"
          :columns="matrixColumns"
          :data="visibleRows"
          :row-key="(row: any) => row.pageId"
          :scroll-x="700"
          size="small"
          :bordered="false"
        />
      </n-card>

      <n-card title="意图映射:目标页被引情况" size="small">
        <template #header-extra>
          <span style="font-size: 12px; color: #999">映射了目标页的 ACTIVE 查询;「落空」= 该查询的回答从未引到目标页 → 优化闭环候选</span>
        </template>
        <EmptyState v-if="!loading && intentRows.length === 0" description="没有映射页面的查询(在查询库中为查询设置 pageId 映射)" />
        <n-data-table
          v-else
          :loading="loading"
          :columns="intentColumns"
          :data="intentRows"
          :row-key="(row: any) => row.queryId"
          size="small"
          :bordered="false"
        />
      </n-card>
    </n-space>
  </div>
</template>

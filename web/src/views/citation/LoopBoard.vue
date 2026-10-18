<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import { useRouter } from 'vue-router'
import {
  NCard, NDataTable, NTag, NSpace, NButton, NAlert, NTooltip, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import EmptyState from '../../components/common/EmptyState.vue'
import { trpc } from '../../composables/useTrpc'

/**
 * 闭环看板（M2 §3.3 规格 §8）。
 * Δ = 发布后首个有效 run 的观测值之差，**不是因果效应**——页头显式声明，避免被误读。
 */

const router = useRouter()
const message = useMessage()
const loading = ref(true)
const rows = ref<any[]>([])
const optimizationsAllowed = ref(true)

const typeLabels: Record<string, string> = {
  OPTIMIZE_FOR_QUERY: '查询优化',
  REWRITE_CONTENT: '内容重写',
  GENERATE_SCHEMA: 'Schema 生成',
  UPDATE_KG: '知识图谱更新',
}

function fmt(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits)
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(0)}%`
}

function fmtTime(value: string | Date | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

/** Δ：正绿负红；基线空或未验证显示 —；AWAITING 显"待下次监测" */
function deltaCell(row: any, value: number | null, formatter: (v: number) => string) {
  if (row.status !== 'VERIFIED' || value === null) {
    return h(NTag, { size: 'small', type: 'default' }, { default: () => '待下次监测' })
  }
  const color = value > 0 ? '#18a058' : value < 0 ? '#d03050' : '#888'
  return h('span', { style: { color, fontWeight: 600 } }, { default: () => formatter(value) })
}

async function loadData() {
  loading.value = true
  try {
    const result = await trpc.citation.loopBoard.query()
    rows.value = result.rows
    optimizationsAllowed.value = result.optimizationsAllowed
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

function gotoTrend(row: any) {
  router.push({ name: 'citation-sov', query: { queryId: row.queryId ?? undefined } })
}

const columns: DataTableColumns<any> = [
  {
    title: '查询',
    key: 'queryText',
    ellipsis: { tooltip: true },
    render(row) {
      if (!row.queryText) return h('span', { style: { color: '#999' } }, { default: () => '（查询已删除）' })
      return h(NSpace, { size: 4, vertical: true }, {
        default: () => [
          h('span', {}, { default: () => row.queryText }),
          row.queryStateNote
            ? h(NTag, { size: 'tiny', type: 'warning' }, { default: () => row.queryStateNote })
            : null,
        ],
      })
    },
  },
  {
    title: '基线',
    key: 'baseline',
    width: 190,
    render(row) {
      return h(NSpace, { size: 4, vertical: true }, {
        default: () => [
          h('span', {}, { default: () => `SOV ${fmt(row.baselineSovMean)}` }),
          h('span', {}, { default: () => `提及 ${pct(row.baselineMentionRate)}` }),
          h(
            NTooltip,
            {},
            {
              trigger: () => h('span', { style: { color: '#999', fontSize: '12px' } }, { default: () => `样本 ${row.baselineValidSamples ?? '—'}` }),
              default: () => '有效样本数：OK 且有 SOV 分数的采样条数。样本越少，指标波动越大。',
            },
          ),
        ],
      })
    },
  },
  {
    title: '动作',
    key: 'action',
    width: 170,
    render(row) {
      return h(NSpace, { size: 4, vertical: true }, {
        default: () => [
          h(NTag, { size: 'small', type: 'info' }, { default: () => typeLabels[row.type] || row.type }),
          h('span', { style: { color: '#888', fontSize: '12px' } }, { default: () => fmtTime(row.publishedAt) }),
        ],
      })
    },
  },
  {
    title: '验证',
    key: 'verified',
    width: 190,
    render(row) {
      if (row.status !== 'VERIFIED') {
        return h('span', { style: { color: '#999' } }, { default: () => '等待下次监测回填' })
      }
      return h(NSpace, { size: 4, vertical: true }, {
        default: () => [
          h('span', {}, { default: () => `SOV ${fmt(row.verifiedSovMean)}` }),
          h('span', {}, { default: () => `提及 ${pct(row.verifiedMentionRate)}` }),
          h('span', { style: { color: '#999', fontSize: '12px' } }, {
            default: () => `样本 ${row.verifiedValidSamples ?? '—'} · ${fmtTime(row.verifiedAt)}`,
          }),
        ],
      })
    },
  },
  {
    title: 'Δ',
    key: 'delta',
    width: 150,
    render(row) {
      return h(NSpace, { size: 8 }, {
        default: () => [
          deltaCell(row, row.deltaSovMean, (v) => `SOV ${v >= 0 ? '+' : ''}${v.toFixed(3)}`),
          deltaCell(row, row.deltaMentionRate, (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}pt`),
        ],
      })
    },
  },
  {
    title: '',
    key: 'trend',
    width: 90,
    render(row) {
      if (!row.queryId) return null
      return h(
        NButton,
        { size: 'tiny', quaternary: true, onClick: () => gotoTrend(row) },
        { default: () => '趋势' },
      )
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="闭环看板" subtitle="薄弱点 → 建议 → 发布 → 回填 → Δ" />

    <NAlert type="info" style="margin-bottom: 16px" :show-icon="true">
      Δ 为发布后首个有效监测运行的观测值之差，反映「改动后被观测到的变化」，不等于改动的因果效应；样本数越少波动越大。
    </NAlert>

    <NCard>
      <NSpace vertical style="margin-bottom: 12px">
        <NAlert v-if="!optimizationsAllowed" type="warning" :show-icon="true">
          当前套餐不含内容优化：可查看已发布的闭环记录，但无法新建优化任务，请联系开通。
        </NAlert>
        <NSpace justify="end">
          <NButton size="small" @click="loadData">刷新</NButton>
        </NSpace>
      </NSpace>

      <NDataTable
        v-if="rows.length > 0"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :bordered="false"
        :row-key="(row: any) => row.taskId"
      />
      <EmptyState v-else-if="!loading" description="在「引用报告」的薄弱查询卡中点击一键优化，即可创建闭环任务" />
    </NCard>
  </div>
</template>

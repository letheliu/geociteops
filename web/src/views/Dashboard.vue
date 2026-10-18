<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NGrid, NGridItem, NStatistic, NSpace, NEmpty, NSpin, NTag, NRadioGroup, NRadioButton, NButton } from 'naive-ui'
import { trpc } from '../composables/useTrpc'
import TrendChart, { type TrendPoint } from '../components/TrendChart.vue'

const loading = ref(true)
const sovScore = ref<number>(0)
const mentionRate = ref<number | null>(null)
const validSamples = ref<number>(0)
const failedSamples = ref<number>(0)
const runCount = ref<number>(0)
const queryCount = ref<number>(0)
const pendingTasks = ref<number>(0)
const recentEvents = ref<any[]>([])
const trendPoints = ref<TrendPoint[]>([])
const rangeDays = ref(7)

async function loadData(days = rangeDays.value) {
  rangeDays.value = days
  loading.value = true
  const now = new Date()
  const start = new Date(now.getTime() - days * 86400000)
  const dateRange = {
    start: start.toISOString(),
    end: now.toISOString(),
  }
  try {
    const [trend, queries, tasks, report] = await Promise.all([
      trpc.citation.trend.query({ dateRange }),
      trpc.citation.queries.list.query(),
      trpc.tasks.list.query({ status: 'pending' }),
      trpc.citation.getReport.query({ dateRange }),
    ])

    // 口径：sovMean = 份额（SOV 正名）；提及率单列，不再混叫 SOV
    sovScore.value = Math.round((trend.period.sovMean ?? 0) * 100)
    mentionRate.value = trend.period.brandMentionRate
    validSamples.value = trend.period.validSamples
    failedSamples.value = trend.period.failedSamples
    runCount.value = trend.period.pointCount
    trendPoints.value = trend.points as unknown as TrendPoint[]
    queryCount.value = Array.isArray(queries) ? queries.length : 0
    pendingTasks.value = Array.isArray(tasks) ? tasks.length : 0
    recentEvents.value = (report.events || []).slice(0, 5)
  } catch (e: any) {
    console.error('Dashboard load failed:', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => loadData(7))
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="24">
      <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
        <NRadioGroup v-model:value="rangeDays" @update:value="loadData">
          <NRadioButton :value="7">近 7 天</NRadioButton>
          <NRadioButton :value="30">近 30 天</NRadioButton>
          <NRadioButton :value="90">近 90 天</NRadioButton>
        </NRadioGroup>
        <NButton quaternary @click="loadData()">🔄 刷新</NButton>
      </NSpace>
      <NGrid :cols="4" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic :label="`SOV 份额（近 ${rangeDays} 天）`" :value="sovScore">
              <template #suffix>%</template>
            </NStatistic>
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="监测覆盖" :value="queryCount">
              <template #suffix>queries</template>
            </NStatistic>
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic :label="`有效采样 / 运行次数`" :value="validSamples">
              <template #suffix>
                · {{ runCount }} 次运行{{ failedSamples > 0 ? `（失败 ${failedSamples}）` : '' }}
              </template>
            </NStatistic>
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="待审任务" :value="pendingTasks" />
          </NCard>
        </NGridItem>
      </NGrid>

      <NCard title="监测趋势">
        <NSpace vertical :size="4">
          <span style="font-size: 12px; color: var(--text-color-3)">
            一个点 = 一次运行（N 次采样的聚合）。阴影带为组内离散度，非置信区间。
          </span>
          <TrendChart :series="trendPoints" />
        </NSpace>
      </NCard>

      <NCard title="最近引用事件">
        <NEmpty v-if="recentEvents.length === 0 && !loading" description="暂无数据" />
        <NSpace v-else vertical :size="8">
          <div
            v-for="ev in recentEvents"
            :key="ev.id"
            style="display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--divider-color)"
          >
            <NTag :type="ev.brandMentioned ? 'success' : 'default'" size="small">
              {{ ev.brandMentioned ? '✅ 提及' : '❌ 未提及' }}
            </NTag>
            <span style="flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ ev.query?.queryText || ev.queryId }}
            </span>
            <NTag size="small" type="info">{{ ev.platform }}</NTag>
            <span v-if="ev.rankInAnswer" style="font-size: 12px; color: var(--text-color-3)">
              排名 #{{ ev.rankInAnswer }}
            </span>
            <span style="font-size: 12px; color: var(--text-color-3)">
              SOV {{ ev.sovScore ? (ev.sovScore * 100).toFixed(0) + '%' : '-' }}
            </span>
          </div>
        </NSpace>
      </NCard>
    </NSpace>
  </NSpin>
</template>

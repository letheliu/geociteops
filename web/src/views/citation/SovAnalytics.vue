<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NCard, NSpace, NDatePicker, NEmpty, NSpin, NGrid, NGridItem, NTag } from 'naive-ui'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart, PieChart } from 'echarts/charts'
import {
  TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent,
} from 'echarts/components'
import PageHeader from '../../components/common/PageHeader.vue'
import TrendChart, { type TrendPoint } from '../../components/TrendChart.vue'
import { trpc } from '../../composables/useTrpc'

use([CanvasRenderer, LineChart, BarChart, PieChart, TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent])

const loading = ref(true)
const dateRange = ref<[number, number]>([
  Date.now() - 30 * 86400000,
  Date.now(),
])
// 样本级事件（平台分布/提及统计仍按事件算），趋势改走 trend 端点
const events = ref<any[]>([])
const trendPoints = ref<TrendPoint[]>([])

const platforms = computed(() => {
  const set = new Set(events.value.map((e) => e.platform))
  return Array.from(set)
})

// 平台分布 pie
const platformOption = computed(() => {
  const counts = new Map<string, number>()
  for (const ev of events.value) {
    counts.set(ev.platform, (counts.get(ev.platform) || 0) + 1)
  }
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      data: Array.from(counts.entries()).map(([name, value]) => ({ name, value })),
    }],
  }
})

// Mentioned vs not mentioned bar
const mentionOption = computed(() => {
  const mentioned = events.value.filter((e) => e.brandMentioned).length
  const notMentioned = events.value.length - mentioned
  return {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ['已提及', '未提及'] },
    yAxis: { type: 'value' },
    series: [{
      type: 'bar',
      data: [
        { value: mentioned, itemStyle: { color: '#18a058' } },
        { value: notMentioned, itemStyle: { color: '#909399' } },
      ],
      barWidth: '40%',
    }],
  }
})

async function loadData() {
  loading.value = true
  const dateRangeArg = {
    start: new Date(dateRange.value[0]).toISOString(),
    end: new Date(dateRange.value[1]).toISOString(),
  }
  try {
    // 趋势走 trend 端点（Run 级聚合）；分布/统计仍取样本级事件
    // M2 §3.3：闭环看板的「趋势」跳转带 queryId 落点（口径与看板 Δ 同源）
    const trendQuery = queryId.value
      ? { dateRange: dateRangeArg, queryId: queryId.value }
      : { dateRange: dateRangeArg }
    const [trend, report] = await Promise.all([
      trpc.citation.trend.query(trendQuery as any),
      trpc.citation.getReport.query({ dateRange: dateRangeArg }),
    ])
    trendPoints.value = trend.points as unknown as TrendPoint[]
    events.value = report.events || []
  } catch {
    trendPoints.value = []
    events.value = []
  } finally {
    loading.value = false
  }
}

// M2 §3.3：?queryId=xxx 聚焦单个查询（闭环看板趋势跳转的落点）
const route = useRoute()
const router = useRouter()
const queryId = ref<string | null>((route.query.queryId as string) || null)
function clearQueryFilter() {
  queryId.value = null
  router.replace({ name: 'citation-sov', query: {} })
}

onMounted(loadData)
watch(dateRange, loadData)
watch(queryId, loadData)
</script>

<template>
  <div>
    <PageHeader title="SOV 分析" subtitle="Share of Voice 趋势与竞品对比" />

    <NSpace style="margin-bottom: 16px">
      <NDatePicker v-model:value="dateRange" type="daterange" clearable />
      <NTag v-if="queryId" closable size="small" type="info" @close="clearQueryFilter">
        已聚焦单个查询（闭环看板跳转）
      </NTag>
    </NSpace>

    <NSpin :show="loading">
      <NEmpty v-if="events.length === 0 && trendPoints.length === 0 && !loading" description="暂无数据，请先触发监测" />

      <NSpace v-else vertical :size="16">
        <NCard title="监测趋势">
          <NSpace vertical :size="4">
            <span style="font-size: 12px; color: var(--text-color-3)">
              一个点 = 一次运行（N 次采样的聚合）。阴影带为组内离散度，非置信区间。
            </span>
            <TrendChart :series="trendPoints" />
          </NSpace>
        </NCard>

        <NGrid :cols="2" :x-gap="16">
          <NGridItem>
            <NCard title="平台分布">
              <VChart :option="platformOption" style="height: 300px" autoresize />
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard title="提及统计">
              <VChart :option="mentionOption" style="height: 300px" autoresize />
            </NCard>
          </NGridItem>
        </NGrid>
      </NSpace>
    </NSpin>
  </div>
</template>

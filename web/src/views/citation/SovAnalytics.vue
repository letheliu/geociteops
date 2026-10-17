<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { NCard, NSpace, NDatePicker, NEmpty, NSpin, NGrid, NGridItem } from 'naive-ui'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart, PieChart } from 'echarts/charts'
import {
  TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent,
} from 'echarts/components'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

use([CanvasRenderer, LineChart, BarChart, PieChart, TitleComponent, TooltipComponent, GridComponent, LegendComponent, DataZoomComponent])

const loading = ref(true)
const dateRange = ref<[number, number]>([
  Date.now() - 30 * 86400000,
  Date.now(),
])
const events = ref<any[]>([])

const platforms = computed(() => {
  const set = new Set(events.value.map((e) => e.platform))
  return Array.from(set)
})

// SOV trend: daily brand mention rate
const trendOption = computed(() => {
  const days = new Map<string, { total: number; mentioned: number }>()
  for (const ev of events.value) {
    const day = new Date(ev.capturedAt).toISOString().slice(0, 10)
    if (!days.has(day)) days.set(day, { total: 0, mentioned: 0 })
    const d = days.get(day)!
    d.total++
    if (ev.brandMentioned) d.mentioned++
  }
  const sorted = Array.from(days.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['品牌提及率'] },
    xAxis: { type: 'category', data: sorted.map((s) => s[0]) },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    series: [{
      name: '品牌提及率',
      type: 'line',
      smooth: true,
      areaStyle: {},
      data: sorted.map((s) => {
        const { total, mentioned } = s[1]
        return total > 0 ? Math.round((mentioned / total) * 100) : 0
      }),
    }],
  }
})

// Platform distribution pie
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
  try {
    const result = await trpc.citation.getReport.query({
      dateRange: {
        start: new Date(dateRange.value[0]).toISOString(),
        end: new Date(dateRange.value[1]).toISOString(),
      },
    })
    events.value = result.events || []
  } catch {
    events.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
watch(dateRange, loadData)
</script>

<template>
  <div>
    <PageHeader title="SOV 分析" subtitle="Share of Voice 趋势与竞品对比" />

    <NSpace style="margin-bottom: 16px">
      <NDatePicker v-model:value="dateRange" type="daterange" clearable />
    </NSpace>

    <NSpin :show="loading">
      <NEmpty v-if="events.length === 0 && !loading" description="暂无数据，请先触发监测" />

      <NSpace v-else vertical :size="16">
        <NCard title="SOV 趋势">
          <VChart :option="trendOption" style="height: 320px" autoresize />
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

<script setup lang="ts">
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components'
import { NEmpty } from 'naive-ui'

use([CanvasRenderer, LineChart, TooltipComponent, GridComponent, LegendComponent])

export interface GeoScorePoint {
  id: string
  at: string
  date: string
  score: number
  grade: string
  brandName: string
  trigger: 'MANUAL' | 'SCHEDULED'
  pillars: {
    agentReadiness: number | null
    citations: number | null
    citability: number | null
    structuredSignals: number | null
  }
}

const props = withDefaults(defineProps<{ points: GeoScorePoint[]; height?: string }>(), { height: '320px' })

const SERIES = [
  { key: 'score' as const, name: '总分', color: '#17323a' },
  { key: 'agentReadiness' as const, name: 'Agent 就绪', color: '#0f766e' },
  { key: 'citations' as const, name: 'AI 引用快照', color: '#2080f0' },
  { key: 'citability' as const, name: '内容可引用性', color: '#f0a020' },
  { key: 'structuredSignals' as const, name: '结构化信号', color: '#8a63d2' },
]

function valueOf(point: GeoScorePoint, key: (typeof SERIES)[number]['key']): number | null {
  if (key === 'score') return point.score
  return point.pillars[key]
}

const option = computed(() => {
  const points = props.points
  return {
    tooltip: {
      trigger: 'axis',
      formatter: (params: { dataIndex: number; seriesName: string; value: number | null }[]) => {
        const list = Array.isArray(params) ? params : [params]
        const point = points[list[0]?.dataIndex ?? -1]
        if (!point) return ''
        const when = point.trigger === 'SCHEDULED' ? '定时复跑' : '手动'
        const rows = [`<div style="font-weight:600">${point.date} · ${point.brandName}</div>`, `${when} · ${point.grade}`]
        for (const item of list) {
          if (item.value == null) continue
          rows.push(`${item.seriesName}：<b>${item.value}</b>`)
        }
        return rows.join('<br/>')
      },
    },
    legend: { data: SERIES.map((item) => item.name) },
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map((point) => point.date), boundaryGap: false },
    yAxis: { type: 'value', min: 0, max: 100 },
    series: SERIES.map((item) => ({
      name: item.name,
      type: 'line',
      smooth: false,
      connectNulls: false,
      data: points.map((point) => valueOf(point, item.key)),
      lineStyle: { width: item.key === 'score' ? 3 : 1.5, color: item.color },
      itemStyle: { color: item.color },
      symbol: item.key === 'score' ? 'circle' : 'emptyCircle',
      symbolSize: item.key === 'score' ? 8 : 6,
    })),
  }
})
</script>

<template>
  <NEmpty v-if="points.length === 0" description="还没有完成的体检，跑完一次之后这里会画出总分和四根支柱。" style="padding: 32px 0" />
  <VChart v-else :option="option" :style="{ height }" autoresize />
</template>

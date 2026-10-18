<script setup lang="ts">
import { computed, ref } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components'
import { NEmpty, NRadioGroup, NRadioButton } from 'naive-ui'

/**
 * 监测趋势图（规格 §8）：一个点 = 一次运行（N 次采样的聚合），不是一天一次抓取。
 *
 * 读图约定：
 * - 主线口径切换：份额（sovMean，默认）/ 提及率 / 引用率
 * - 阴影带 = ±sovStdDev「组内离散度」，**不是置信区间**——措辞在 tooltip 里也保持一致
 * - legacy 日点用虚线，tooltip 注明「历史为事件级聚合口径」
 * - PARTIAL 点用三角标记：有数据但当次运行有失败采样
 * - 无数据（null）断线，不补零
 */

export interface TrendPoint {
  id: string
  date: string
  startedAt: string
  trigger: 'SCHEDULED' | 'MANUAL' | 'LEGACY'
  sampleCount: number
  validSamples: number
  failedSamples: number
  status: string
  slotKey: string | null
  legacy: boolean
  sovMean: number | null
  brandMentionRate: number | null
  brandSourceCitationRate: number | null
  sovStdDev: number | null
  rankMedian: number | null
  rankBest: number | null
}

const props = withDefaults(
  defineProps<{
    series: TrendPoint[]
    height?: string
    defaultMetric?: 'sovMean' | 'brandMentionRate' | 'brandSourceCitationRate'
  }>(),
  { height: '340px', defaultMetric: 'sovMean' },
)

const METRICS = [
  { value: 'sovMean' as const, label: '份额 SOV' },
  { value: 'brandMentionRate' as const, label: '提及率' },
  { value: 'brandSourceCitationRate' as const, label: '引用率' },
]

const metric = ref<'sovMean' | 'brandMentionRate' | 'brandSourceCitationRate'>(props.defaultMetric)
const metricLabel = computed(() => METRICS.find((m) => m.value === metric.value)!.label)

function pct(v: number | null): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`
}

/** 单点的视觉样式：PARTIAL 三角、legacy 菱形、常规圆点 */
function pointStyle(p: TrendPoint) {
  if (p.status === 'PARTIAL') return { symbol: 'triangle', symbolSize: 11 }
  if (p.legacy) return { symbol: 'diamond', symbolSize: 9 }
  return { symbol: 'circle', symbolSize: 7 }
}

const option = computed(() => {
  const points = props.series
  const dates = points.map((p) => p.date)

  // null 保持 null —— echarts 默认不连接 null，正好实现「断线不造零」
  const values = points.map((p) => p[metric.value])
  const stddevs = points.map((p) => p.sovStdDev)

  const mainData = points.map((p, i) => ({
    value: values[i],
    ...pointStyle(p),
  }))

  // legacy 点单独一层虚线：历史事件级口径与 run 级口径视觉可辨
  const legacyData = points.map((p, i) => (p.legacy ? values[i] : null))

  // ±stdDev 带：两条堆叠线（基线透明 + 差值填充）实现，不引额外图表类型
  const lower = points.map((p, i) => {
    const v = values[i]
    const sd = stddevs[i]
    if (v === null || v === undefined || sd === null || sd === undefined) return null
    return Math.max(0, v - sd)
  })
  const bandHeight = points.map((p, i) => {
    const v = values[i]
    const sd = stddevs[i]
    const base = lower[i]
    if (v === null || v === undefined || sd === null || sd === undefined || base === null) return null
    // 堆叠高度 = 上界 - 下界 = stdDev + max(0, v - stdDev)
    return v - base + sd
  })

  const statusText: Record<string, string> = {
    COMPLETED: '全部成功',
    PARTIAL: '部分失败（有可用样本）',
    FAILED: '全部失败（不进趋势）',
    RUNNING: '运行中',
  }

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (params: any[]) => {
        const list = Array.isArray(params) ? params : [params]
        const idx = list[0]?.dataIndex
        const p = points[idx]
        if (!p) return ''
        const rows = [
          `<div style="font-weight:600">${p.date}${p.legacy ? '（历史日桶）' : ''}</div>`,
          `${metricLabel.value}：<b>${pct(p[metric.value])}</b>`,
          metric.value === 'sovMean' ? `组内离散度：±${pct(p.sovStdDev)}` : '',
          `有效采样：${p.validSamples}${p.failedSamples > 0 ? ` · 失败 ${p.failedSamples}` : ''}`,
          `N：${p.sampleCount} 次采样`,
          `状态：${statusText[p.status] ?? p.status}`,
          p.slotKey ? `槽位：${p.slotKey}` : '',
          p.legacy ? '<span style="opacity:.7">历史为事件级聚合口径，与 Run 级口径不保证逐日相等</span>' : '',
        ].filter(Boolean)
        return rows.join('<br/>')
      },
    },
    legend: { data: [metricLabel.value] },
    grid: { left: 48, right: 24, top: 32, bottom: 28 },
    xAxis: { type: 'category', data: dates, boundaryGap: false },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
    },
    series: [
      // 组内离散度带（底）
      {
        name: '__band-base',
        type: 'line',
        stack: 'band',
        data: lower,
        lineStyle: { opacity: 0 },
        symbol: 'none',
        silent: true,
        tooltip: { show: false },
        legendHoverLink: false,
      },
      {
        name: '__band',
        type: 'line',
        stack: 'band',
        data: bandHeight,
        lineStyle: { opacity: 0 },
        areaStyle: { color: 'rgba(24,160,88,0.12)' },
        symbol: 'none',
        silent: true,
        tooltip: { show: false },
        legendHoverLink: false,
      },
      {
        name: metricLabel.value,
        type: 'line',
        smooth: false,
        connectNulls: false,
        data: mainData,
        lineStyle: { width: 2, color: '#18a058' },
        itemStyle: { color: '#18a058' },
      },
      {
        name: `${metricLabel.value}（历史日桶）`,
        type: 'line',
        data: legacyData,
        lineStyle: { width: 2, type: 'dashed', color: '#909399' },
        itemStyle: { color: '#909399' },
        tooltip: { show: false },
      },
    ],
  }
})

const hasData = computed(() => props.series.some((p) => p[metric.value] !== null))
</script>

<template>
  <div>
    <div style="display: flex; justify-content: flex-end; margin-bottom: 8px">
      <NRadioGroup v-model:value="metric" size="small">
        <NRadioButton v-for="m in METRICS" :key="m.value" :value="m.value">
          {{ m.label }}
        </NRadioButton>
      </NRadioGroup>
    </div>

    <NEmpty v-if="!hasData" description="暂无趋势数据，请先触发一次监测" style="padding: 48px 0" />
    <VChart v-else :option="option" :style="{ height }" autoresize />
  </div>
</template>

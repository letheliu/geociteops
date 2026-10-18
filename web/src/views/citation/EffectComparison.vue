<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  NCard, NSpace, NDatePicker, NButton, NSelect, NSpin, NEmpty, NGrid, NGridItem,
  NStatistic, NTag,
} from 'naive-ui'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import { TitleComponent, TooltipComponent, GridComponent, LegendComponent } from 'echarts/components'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

use([CanvasRenderer, BarChart, TitleComponent, TooltipComponent, GridComponent, LegendComponent])

const loading = ref(false)
const result = ref<any>(null)

const beforeRange = ref<[number, number]>([
  Date.now() - 14 * 86400000,
  Date.now() - 7 * 86400000,
])
const afterRange = ref<[number, number]>([
  Date.now() - 7 * 86400000,
  Date.now(),
])

const platformOptions = [
  { label: '全部平台', value: '' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: '豆包', value: 'doubao' },
  { label: '通义千问', value: 'qwen' },
  { label: '文心一言', value: 'ernie' },
]
const selectedPlatform = ref('')

function deltaColor(v: number | null): string {
  if (v === null) return '#909399'
  if (v > 0.01) return '#18a058'
  if (v < -0.01) return '#d03050'
  return '#909399'
}

function deltaText(v: number | null, suffix = ''): string {
  if (v === null) return '—'
  if (v > 0) return `+${(v * 100).toFixed(1)}${suffix}`
  return `${(v * 100).toFixed(1)}${suffix}`
}

/** 期间级聚合可能没有可算的点（无有效采样）→ 展示为 —，不显示 0 */
function pctOrDash(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`
}

function numOrDash(v: number | null): string {
  return v === null ? '—' : v.toFixed(1)
}

const chartOption = computed(() => {
  if (!result.value) return {}
  const { before, after } = result.value
  // 口径已随 M2 §3.1 改造：sov = 份额，mention = 提及率，rank = 池化中位数
  const pick = (s: any) => [
    s.sovMean === null ? null : Math.round(s.sovMean * 100),
    s.brandMentionRate === null ? null : Math.round(s.brandMentionRate * 100),
  ]
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['优化前', '优化后'] },
    xAxis: { type: 'category', data: ['SOV 份额', '品牌提及率'] },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    series: [
      { name: '优化前', type: 'bar', data: pick(before), itemStyle: { color: '#909399' } },
      { name: '优化后', type: 'bar', data: pick(after), itemStyle: { color: '#18a058' } },
    ],
  }
})

async function loadData() {
  loading.value = true
  try {
    result.value = await trpc.citation.getEffectComparison.query({
      before: {
        start: new Date(beforeRange.value[0]).toISOString(),
        end: new Date(beforeRange.value[1]).toISOString(),
      },
      after: {
        start: new Date(afterRange.value[0]).toISOString(),
        end: new Date(afterRange.value[1]).toISOString(),
      },
      platform: selectedPlatform.value || undefined,
    })
  } catch {
    result.value = null
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="效果对比" subtitle="对比优化前后的 SOV 变化" />

    <NCard style="margin-bottom: 16px">
      <NSpace align="end" :size="16">
        <div>
          <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 4px">优化前时段</div>
          <NDatePicker v-model:value="beforeRange" type="daterange" />
        </div>
        <div>
          <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 4px">优化后时段</div>
          <NDatePicker v-model:value="afterRange" type="daterange" />
        </div>
        <NSelect
          v-model:value="selectedPlatform"
          :options="platformOptions"
          style="width: 140px"
        />
        <NButton type="primary" :loading="loading" @click="loadData">对比分析</NButton>
      </NSpace>
    </NCard>

    <NSpin :show="loading">
      <NEmpty v-if="!result && !loading" description="选择时段后点击对比分析" />

      <template v-else-if="result">
        <NGrid :cols="3" :x-gap="16" :y-gap="16" style="margin-bottom: 16px">
          <NGridItem>
            <NCard>
              <NStatistic label="SOV 份额变化">
                <template #default>
                  <span :style="{ color: deltaColor(result.delta.sovMean), fontSize: '24px', fontWeight: '600' }">
                    {{ deltaText(result.delta.sovMean, '%') }}
                  </span>
                </template>
                <template #suffix>
                  <div style="font-size: 12px; color: var(--text-color-3)">
                    {{ pctOrDash(result.before.sovMean) }} → {{ pctOrDash(result.after.sovMean) }}
                  </div>
                </template>
              </NStatistic>
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard>
              <NStatistic label="品牌提及率变化">
                <template #default>
                  <span :style="{ color: deltaColor(result.delta.brandMentionRate), fontSize: '24px', fontWeight: '600' }">
                    {{ deltaText(result.delta.brandMentionRate, '%') }}
                  </span>
                </template>
                <template #suffix>
                  <div style="font-size: 12px; color: var(--text-color-3)">
                    优化前 {{ result.before.validSamples }} 个有效采样
                    优化后 {{ result.after.validSamples }} 个
                  </div>
                </template>
              </NStatistic>
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard>
              <NStatistic label="排名中位数变化">
                <template #default>
                  <span :style="{ color: deltaColor(result.delta.rankMedian === null ? null : -result.delta.rankMedian), fontSize: '24px', fontWeight: '600' }">
                    {{ deltaText(result.delta.rankMedian === null ? null : -result.delta.rankMedian, '') }}
                  </span>
                </template>
                <template #suffix>
                  <div style="font-size: 12px; color: var(--text-color-3)">
                    {{ numOrDash(result.before.rankMedian) }} → {{ numOrDash(result.after.rankMedian) }}
                  </div>
                </template>
              </NStatistic>
            </NCard>
          </NGridItem>
        </NGrid>

        <NCard title="对比图表">
          <VChart :option="chartOption" style="height: 360px" autoresize />
        </NCard>
      </template>
    </NSpin>
  </div>
</template>

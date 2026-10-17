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

function deltaColor(v: number): string {
  if (v > 0.01) return '#18a058'
  if (v < -0.01) return '#d03050'
  return '#909399'
}

function deltaText(v: number, suffix = ''): string {
  if (v > 0) return `+${(v * 100).toFixed(1)}${suffix}`
  return `${(v * 100).toFixed(1)}${suffix}`
}

const chartOption = computed(() => {
  if (!result.value) return {}
  const { before, after } = result.value
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: ['优化前', '优化后'] },
    xAxis: { type: 'category', data: ['SOV 分数', '品牌提及率'] },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    series: [
      {
        name: '优化前',
        type: 'bar',
        data: [
          Math.round(before.sov * 100),
          before.totalEvents > 0 ? Math.round((before.mentionedCount / before.totalEvents) * 100) : 0,
        ],
        itemStyle: { color: '#909399' },
      },
      {
        name: '优化后',
        type: 'bar',
        data: [
          Math.round(after.sov * 100),
          after.totalEvents > 0 ? Math.round((after.mentionedCount / after.totalEvents) * 100) : 0,
        ],
        itemStyle: { color: '#18a058' },
      },
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
              <NStatistic label="SOV 变化">
                <template #default>
                  <span :style="{ color: deltaColor(result.delta.sov), fontSize: '24px', fontWeight: '600' }">
                    {{ deltaText(result.delta.sov, '%') }}
                  </span>
                </template>
                <template #suffix>
                  <div style="font-size: 12px; color: var(--text-color-3)">
                    {{ (result.before.sov * 100).toFixed(1) }}% → {{ (result.after.sov * 100).toFixed(1) }}%
                  </div>
                </template>
              </NStatistic>
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard>
              <NStatistic label="品牌提及率变化">
                <template #default>
                  <span :style="{ color: deltaColor(result.delta.mentionRate), fontSize: '24px', fontWeight: '600' }">
                    {{ deltaText(result.delta.mentionRate, '%') }}
                  </span>
                </template>
                <template #suffix>
                  <div style="font-size: 12px; color: var(--text-color-3)">
                    优化前 {{ result.before.mentionedCount }}/{{ result.before.totalEvents }}
                    优化后 {{ result.after.mentionedCount }}/{{ result.after.totalEvents }}
                  </div>
                </template>
              </NStatistic>
            </NCard>
          </NGridItem>
          <NGridItem>
            <NCard>
              <NStatistic label="平均排名变化">
                <template #default>
                  <span :style="{ color: deltaColor(-result.delta.avgRank), fontSize: '24px', fontWeight: '600' }">
                    {{ result.delta.avgRank > 0 ? '+' : '' }}{{ result.delta.avgRank.toFixed(1) }}
                  </span>
                </template>
                <template #suffix>
                  <div style="font-size: 12px; color: var(--text-color-3)">
                    {{ result.before.avgRank.toFixed(1) }} → {{ result.after.avgRank.toFixed(1) }}
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

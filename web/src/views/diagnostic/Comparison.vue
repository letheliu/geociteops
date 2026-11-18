<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { NSpace, NCard, NTag, NAlert, NSpin, NEmpty } from 'naive-ui'
import { trpc } from '../../api/client'
import { formatMentionRate } from '../../domain/diagnostic'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const route = useRoute()
const baselineRunId = route.params.baselineRunId as string
const retestRunId = route.params.retestRunId as string
const comparison = ref<any>(null)
const loading = ref(true)

onMounted(async () => {
  loading.value = true
  try {
    comparison.value = await (trpc as any).diagnostic.reports.compare.query({ baselineRunId, retestRunId })
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NSpin :show="loading">
    <div v-if="comparison">
      <NSpace vertical :size="16">
        <h2 style="margin: 0">{{ t('复测对比') }}</h2>

        <NAlert v-if="!comparison.strictlyComparable" type="warning" :title="t('非严格可比')"> {{ t('基线与复测的范围不一致，以下分析仅供参考，不能宣称确定性提升。') }} </NAlert>

        <NCard :title="t('范围比较')" size="small">
          <div v-if="comparison.queryDiffs.added.length">{{ t('新增 Query 类型：') }}{{ comparison.queryDiffs.added.join(', ') }}</div>
          <div v-if="comparison.queryDiffs.removed.length">{{ t('移除 Query 类型：') }}{{ comparison.queryDiffs.removed.join(', ') }}</div>
          <div v-if="comparison.platformDiffs.added.length">{{ t('新增平台：') }}{{ comparison.platformDiffs.added.join(', ') }}</div>
          <div v-if="comparison.platformDiffs.removed.length">{{ t('移除平台：') }}{{ comparison.platformDiffs.removed.join(', ') }}</div>
          <div v-if="comparison.samplingDiff.samplesPerQueryChanged">{{ t('采样次数已变更') }}</div>
          <div v-if="comparison.samplingDiff.localeChanged">{{ t('语言设置已变更') }}</div>
          <div v-if="comparison.samplingDiff.timezoneChanged">{{ t('时区设置已变更') }}</div>
          <NEmpty v-if="comparison.strictlyComparable" :description="t('范围一致，可直接对比')" />
        </NCard>

        <div v-if="comparison.baselineReport && comparison.retestReport">
          <NCard :title="t('指标对比')" size="small">
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px;">{{ t('指标') }}</th>
                  <th style="padding: 8px;">{{ t('基线') }}</th>
                  <th style="padding: 8px;">{{ t('复测') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding: 8px;">{{ t('品牌提及率') }}</td>
                  <td style="padding: 8px; text-align: center;">{{ formatMentionRate(comparison.baselineReport.metrics.mentionRate) }}</td>
                  <td style="padding: 8px; text-align: center;">{{ formatMentionRate(comparison.retestReport.metrics.mentionRate) }}</td>
                </tr>
                <tr>
                  <td style="padding: 8px;">{{ t('来源引用率') }}</td>
                  <td style="padding: 8px; text-align: center;">{{ formatMentionRate(comparison.baselineReport.metrics.sourceCitationRate) }}</td>
                  <td style="padding: 8px; text-align: center;">{{ formatMentionRate(comparison.retestReport.metrics.sourceCitationRate) }}</td>
                </tr>
              </tbody>
            </table>
          </NCard>
        </div>
      </NSpace>
    </div>
  </NSpin>
</template>

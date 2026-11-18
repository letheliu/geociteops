<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty, NSpin, NDrawer, NDrawerContent, useMessage } from 'naive-ui'
import { trpc } from '../../api/client'
import { DIAGNOSTIC_FINDING_SEVERITY_COLORS, DIAGNOSTIC_FINDING_TYPE_LABELS, DIAGNOSTIC_ACTION_HORIZON_LABELS, formatMentionRate, formatAverageRank } from '../../domain/diagnostic'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const route = useRoute()
const router = useRouter()
const message = useMessage()
const runId = route.params.runId as string

const report = ref<any>(null)
const loading = ref(true)
const rawAnswerDrawer = ref(false)
const rawAnswerText = ref('')

async function loadReport() {
  loading.value = true
  try {
    const result = await (trpc as any).diagnostic.reports.get.query({ runId })
    report.value = result
  } catch (err: any) {
    message.error(err.message)
  } finally {
    loading.value = false
  }
}

async function handleAccept(actionId: string) {
  try {
    await (trpc as any).diagnostic.actions.accept.mutate({ actionId })
    message.success(t("已接受"))
    await loadReport()
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleDismiss(actionId: string) {
  try {
    await (trpc as any).diagnostic.actions.dismiss.mutate({ actionId })
    message.success(t("已忽略"))
    await loadReport()
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleConvert(actionId: string) {
  try {
    const result = await (trpc as any).diagnostic.actions.convert.mutate({ actionId })
    message.success(`${t("已转换为优化任务 ")}${(result as any).optimizationTaskId}`)
    await loadReport()
  } catch (err: any) {
    message.error(err.message)
  }
}

onMounted(loadReport)
</script>

<template>
  <NSpin :show="loading">
    <div v-if="report">
      <NSpace vertical :size="16">
        <h2 style="margin: 0">{{ t('诊断报告') }}</h2>

        <NCard :title="t('诊断概览')" size="small">
          <NDescriptions :column="2">
            <NDescriptionsItem :label="t('运行类型')">{{ report.runType }}</NDescriptionsItem>
            <NDescriptionsItem :label="t('状态')">{{ report.status }}</NDescriptionsItem>
            <NDescriptionsItem :label="t('可靠性')">
              <NTag :type="report.reliability === 'HIGH' ? 'success' : report.reliability === 'MEDIUM' ? 'warning' : 'error'">
                {{ report.reliability }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('有效样本')">{{ report.metrics.validSampleCount }} / {{ report.metrics.plannedSamples }}（{{ formatMentionRate(report.metrics.validSampleRate) }}）</NDescriptionsItem>
            <NDescriptionsItem :label="t('品牌提及率')">{{ formatMentionRate(report.metrics.mentionRate) }}</NDescriptionsItem>
            <NDescriptionsItem :label="t('来源引用率')">{{ formatMentionRate(report.metrics.sourceCitationRate) }}</NDescriptionsItem>
            <NDescriptionsItem :label="t('平均排名')">{{ formatAverageRank(report.metrics.averageRank) }}</NDescriptionsItem>
            <NDescriptionsItem label="SOV">{{ formatMentionRate(report.metrics.sovScore) }}</NDescriptionsItem>
          </NDescriptions>
        </NCard>

        <NCard :title="t('发现')" size="small">
          <div v-if="report.findings.length">
            <div v-for="f in report.findings" :key="f.id" style="padding: 12px 0; border-bottom: 1px solid #eee;">
              <NSpace align="center" :size="8">
                <NTag :type="DIAGNOSTIC_FINDING_SEVERITY_COLORS[f.severity] || 'default'" size="small">
                  {{ DIAGNOSTIC_FINDING_TYPE_LABELS[f.type] || f.type }}
                </NTag>
                <span>{{ f.title }}</span>
              </NSpace>
              <p style="margin: 8px 0 0; color: #666;">{{ f.summary }}</p>
            </div>
          </div>
          <NEmpty v-else :description="t('暂无发现')" />
        </NCard>

        <NCard :title="t('30/60/90 天行动')" size="small">
          <div v-if="report.actions.length">
            <div v-for="a in report.actions" :key="a.id" style="padding: 12px 0; border-bottom: 1px solid #eee;">
              <NSpace vertical :size="8">
                <NSpace align="center" :size="8">
                  <NTag size="small">{{ DIAGNOSTIC_ACTION_HORIZON_LABELS[a.horizon] || a.horizon }}</NTag>
                  <strong>{{ a.title }}</strong>
                  <NTag :type="a.status === 'ACCEPTED' ? 'success' : a.status === 'CONVERTED' ? 'info' : a.status === 'DISMISSED' ? 'default' : 'warning'" size="tiny">{{ a.status }}</NTag>
                </NSpace>
                <p style="margin: 0; color: #666;">{{ a.description }}</p>
                <NSpace v-if="a.status === 'PROPOSED'" :size="4">
                  <NButton size="tiny" type="primary" @click="handleAccept(a.id)">{{ t('接受') }}</NButton>
                  <NButton size="tiny" @click="handleDismiss(a.id)">{{ t('忽略') }}</NButton>
                </NSpace>
                <div v-if="a.status === 'ACCEPTED'">
                  <NButton size="tiny" type="primary" @click="handleConvert(a.id)">{{ t('转换为任务') }}</NButton>
                </div>
              </NSpace>
            </div>
          </div>
          <NEmpty v-else :description="t('暂无行动')" />
        </NCard>
      </NSpace>
    </div>
  </NSpin>

  <NDrawer v-model:show="rawAnswerDrawer" :width="600" placement="right">
    <NDrawerContent :title="t('原始回答')">
      <pre style="white-space: pre-wrap; word-break: break-all;">{{ rawAnswerText }}</pre>
    </NDrawerContent>
  </NDrawer>
</template>

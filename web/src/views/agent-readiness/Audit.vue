<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NGrid, NGridItem, NInput, NSpace, NSpin, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import type {
  AgentReadinessAuditDetail,
  AgentReadinessAuditSummary,
  AgentReadinessCheck,
  AgentReadinessReport,
  CheckStatus,
} from '../../../../src/modules/agent-readiness/types.ts'
import { useI18n } from '@/i18n'
const { t, locale: appLocale } = useI18n()


/**
 * 控制台没有 vue-i18n，页面文案与其它页一样用简体中文。
 * 报告里同时带 en / zh，后续语言开关或 GEO 健康检查直接复用，不必重跑审计。
 */
const message = useMessage()
const url = ref('')
const starting = ref(false)
const history = ref<AgentReadinessAuditSummary[]>([])
const audit = ref<AgentReadinessAuditDetail | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

const report = computed<AgentReadinessReport | null>(() => audit.value?.report ?? null)

const STATUS_LABEL: Record<CheckStatus | AgentReadinessAuditSummary['status'], string> = {
  pass: t("通过"),
  warn: t("警告"),
  fail: t("未通过"),
  QUEUED: t("排队"),
  RUNNING: t("进行中"),
  SUCCEEDED: t("完成"),
  FAILED: t("失败"),
}

const ROLE_LABEL: Record<string, string> = {
  answer: t("回答"),
  search: t("搜索"),
  training: t("训练"),
}

function tagType(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'pass' || status === 'SUCCEEDED') return 'success'
  if (status === 'warn' || status === 'RUNNING' || status === 'QUEUED') return 'warning'
  if (status === 'fail' || status === 'FAILED') return 'error'
  return 'default'
}

function gradeColor(grade: string | null | undefined): string {
  if (grade === 'A' || grade === 'B') return '#18a058'
  if (grade === 'C') return '#f0a020'
  return '#d03050'
}

interface BotRow {
  token: string
  vendor: string
  role: string
  allowed: boolean | null
  source: string
  matchedRule: string | null
}

function botsOf(check: AgentReadinessCheck): BotRow[] {
  const value = check.evidence.bots
  if (!Array.isArray(value)) return []
  return value.filter((row): row is BotRow => {
    return !!row && typeof row === 'object' && 'token' in row
  })
}

function probesOf(check: AgentReadinessCheck): { url: string; status: number }[] {
  const value = check.evidence.probes
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object' || !('url' in row)) return []
    const urlValue = (row as { url?: unknown }).url
    const status = (row as { status?: unknown }).status
    if (typeof urlValue !== 'string' || typeof status !== 'number') return []
    return [{ url: urlValue, status }]
  })
}

const botColumns: DataTableColumns<BotRow> = [
  { title: t("爬虫"), key: 'token', width: 180 },
  { title: t("厂商"), key: 'vendor', width: 120 },
  {
    title: t("角色"),
    key: 'role',
    width: 80,
    render: (row) => ROLE_LABEL[row.role] ?? row.role,
  },
  {
    title: t("结果"),
    key: 'allowed',
    width: 90,
    render: (row) => row.allowed == null ? t("未知") : row.allowed ? t("允许") : t("禁止"),
  },
  {
    title: t("命中规则"),
    key: 'matchedRule',
    render: (row) => row.matchedRule ?? (row.source === 'default' ? t("无规则，默认允许") : '—'),
  },
]

const historyColumns: DataTableColumns<AgentReadinessAuditSummary> = [
  {
    title: t("时间"),
    key: 'createdAt',
    width: 180,
    render: (row) => new Date(row.createdAt).toLocaleString(appLocale.value),
  },
  { title: 'URL', key: 'url', ellipsis: { tooltip: true } },
  {
    title: t("状态"),
    key: 'status',
    width: 90,
    render: (row) => STATUS_LABEL[row.status],
  },
  {
    title: t("得分"),
    key: 'score',
    width: 80,
    render: (row) => row.score == null ? '—' : `${row.score} ${row.grade ?? ''}`,
  },
]

function checksIn(categoryId: string): AgentReadinessCheck[] {
  return report.value?.checks.filter((check) => check.category === categoryId) ?? []
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function loadHistory() {
  history.value = await trpc.agentReadiness.list.query({ limit: 20 })
}

async function loadAudit(id: string, poll: boolean) {
  const row = await trpc.agentReadiness.get.query({ id })
  audit.value = row
  if (row.status === 'SUCCEEDED' || row.status === 'FAILED') {
    stopPolling()
    await loadHistory()
    return
  }
  if (poll && !pollTimer) {
    pollTimer = setInterval(() => {
      loadAudit(id, false).catch(() => stopPolling())
    }, 1500)
  }
}

async function startAudit() {
  const target = url.value.trim()
  if (!target) {
    message.warning(t("请输入要审计的 URL"))
    return
  }
  starting.value = true
  stopPolling()
  try {
    const created = await trpc.agentReadiness.start.mutate({ url: target })
    message.success(t("审计已开始"))
    await loadAudit(created.id, true)
  } catch (err: unknown) {
    const text = err instanceof Error ? err.message : t("审计没有开始")
    message.error(text)
  } finally {
    starting.value = false
  }
}

function historyRowProps(row: AgentReadinessAuditSummary) {
  return { style: 'cursor: pointer', onClick: () => openHistory(row) }
}

function openHistory(row: AgentReadinessAuditSummary) {
  stopPolling()
  loadAudit(row.id, row.status === 'QUEUED' || row.status === 'RUNNING').catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : t("无法打开这条记录"))
  })
}

onMounted(async () => {
  try {
    const ws = await trpc.workspace.get.query()
    if (ws.domain && !url.value) {
      url.value = /^https?:\/\//i.test(ws.domain) ? ws.domain : `https://${ws.domain}`
    }
  } catch {
    // 域名只是输入框的默认值
  }
  try {
    await loadHistory()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("无法加载历史记录"))
  }
})

onUnmounted(stopPolling)
</script>

<template>
  <div>
    <PageHeader
      :title="t('Agent 就绪')"
      :subtitle="t('检查这个 URL 对 AI 爬虫和回答引擎准备得怎么样，并按影响度给出要先改的项。报告结构可直接嵌入后续的 GEO 健康检查。')"
    />

    <NCard style="margin-bottom: 16px">
      <NSpace align="center" :wrap="true">
        <NInput
          v-model:value="url"
          placeholder="https://example.com"
          style="width: min(560px, 100%)"
          :disabled="starting"
          @keyup.enter="startAudit"
        />
        <NButton type="primary" :loading="starting" @click="startAudit">{{ t('开始审计') }}</NButton>
      </NSpace>
      <NText depth="3" style="display: block; margin-top: 8px; font-size: 12px"> {{ t('审计在后台队列里跑，只访问公网 http/https。内网、本机和云元数据地址会被拒绝。') }} </NText>
    </NCard>

    <NSpin :show="audit?.status === 'QUEUED' || audit?.status === 'RUNNING'">
      <NCard v-if="audit && (audit.status === 'QUEUED' || audit.status === 'RUNNING')" style="margin-bottom: 16px"> {{ t('正在审计') }} {{ audit.url }}（{{ STATUS_LABEL[audit.status] }}{{ t('）。结果会写进下面的历史，可以稍后回来看。') }} </NCard>

      <NCard v-else-if="audit?.status === 'FAILED'" :title="t('这次审计没有完成')" style="margin-bottom: 16px">
        <NText>{{ audit.error || t('未知错误') }}</NText>
      </NCard>

      <template v-if="report">
        <NCard style="margin-bottom: 16px">
          <NSpace align="center" justify="space-between" :wrap="true">
            <div>
              <div :style="{ fontSize: '40px', fontWeight: 700, lineHeight: 1, color: gradeColor(report.grade) }">
                {{ report.score }}
                <span style="font-size: 20px; margin-left: 8px">{{ report.grade }}</span>
              </div>
              <NText depth="3" style="display: block; margin-top: 8px">{{ report.summary.zh }}</NText>
              <NText depth="3" style="display: block; margin-top: 4px; font-size: 12px">{{ report.finalUrl }}</NText>
            </div>
            <NTag :type="tagType(audit?.status || '')">{{ STATUS_LABEL[audit?.status || 'SUCCEEDED'] }}</NTag>
          </NSpace>
        </NCard>

        <NGrid cols="1 600:2 900:3" :x-gap="12" :y-gap="12" style="margin-bottom: 16px">
          <NGridItem v-for="category in report.categories" :key="category.id">
            <NCard size="small" :title="category.label.zh">
              <NSpace align="center">
                <span :style="{ fontWeight: 700, color: gradeColor(category.score >= 75 ? 'B' : category.score >= 60 ? 'C' : 'F') }">
                  {{ category.score }}
                </span>
                <NTag size="small" :type="tagType(category.status)">{{ STATUS_LABEL[category.status] }}</NTag>
              </NSpace>
            </NCard>
          </NGridItem>
        </NGrid>

        <NCard :title="t('优先修复')" style="margin-bottom: 16px">
          <NText v-if="report.fixes.length === 0" depth="3">{{ t('没有需要修复的项。') }}</NText>
          <div v-for="(fix, index) in report.fixes" :key="fix.checkId" style="padding: 12px 0; border-top: 1px solid var(--divider-color)">
            <NSpace align="center" :size="8" style="margin-bottom: 6px">
              <NText depth="3">{{ index + 1 }}</NText>
              <NTag size="small" :type="tagType(fix.status)">{{ STATUS_LABEL[fix.status] }}</NTag>
              <strong>{{ fix.title.zh }}</strong>
              <NText depth="3">{{ t('影响') }} {{ fix.impact }}</NText>
            </NSpace>
            <div>{{ fix.fix.zh }}</div>
            <NText depth="3" style="display: block; margin-top: 4px">{{ t('如何验证：') }}{{ fix.verify.zh }}</NText>
          </div>
        </NCard>

        <NCard :title="t('分项检查')" style="margin-bottom: 16px">
          <div v-for="category in report.categories" :key="category.id" style="margin-bottom: 16px">
            <NText strong>{{ category.label.zh }}</NText>
            <div
              v-for="check in checksIn(category.id)"
              :key="check.id"
              style="margin-top: 8px; padding: 12px; border: 1px solid var(--divider-color); border-radius: 8px"
            >
              <NSpace align="center" :size="8" style="margin-bottom: 6px">
                <NTag size="small" :type="tagType(check.status)">{{ STATUS_LABEL[check.status] }}</NTag>
                <strong>{{ check.title.zh }}</strong>
                <NText v-if="!check.applicable" depth="3">{{ t('不计入总分') }}</NText>
              </NSpace>
              <div>{{ check.explanation.zh }}</div>
              <div v-if="check.status !== 'pass'" style="margin-top: 6px">{{ t('修复：') }}{{ check.fix.zh }}</div>
              <NText depth="3" style="display: block; margin-top: 4px">{{ t('如何验证：') }}{{ check.verify.zh }}</NText>
              <NDataTable
                v-if="check.id === 'robots.answer-bots' && botsOf(check).length"
                size="small"
                style="margin-top: 8px"
                :columns="botColumns"
                :data="botsOf(check)"
                :pagination="{ pageSize: 20 }"
              />
              <ul v-if="probesOf(check).length" style="margin: 8px 0 0; padding-left: 18px">
                <li v-for="probe in probesOf(check)" :key="probe.url">
                  HTTP {{ probe.status }} · {{ probe.url }}
                </li>
              </ul>
            </div>
          </div>
        </NCard>
      </template>
    </NSpin>

    <NCard :title="t('历史')">
      <NDataTable
        size="small"
        :columns="historyColumns"
        :data="history"
        :row-props="historyRowProps"
      />
      <NText v-if="history.length === 0" depth="3">{{ t('还没有审计记录。') }}</NText>
    </NCard>
  </div>
</template>

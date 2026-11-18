<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NGrid, NGridItem, NInput, NPopconfirm, NProgress, NRadioButton, NRadioGroup,
  NSpace, NSpin, NSwitch, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import GeoScoreChart, { type GeoScorePoint } from '../../components/GeoScoreChart.vue'
import { trpc } from '../../composables/useTrpc'
import { useI18n } from '@/i18n'
const { t, locale: appLocale } = useI18n()


type Detail = Awaited<ReturnType<typeof trpc.geoHealth.get.query>>
type Summary = Awaited<ReturnType<typeof trpc.geoHealth.list.query>>[number]
type Report = NonNullable<Detail['report']>
type Schedule = Awaited<ReturnType<typeof trpc.geoHealth.schedules.query>>[number]
type Cadence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON'

const message = useMessage()
const brandName = ref('')
const siteUrl = ref('')
const industry = ref('')
const competitorsText = ref('')
const queriesText = ref('')
const language = ref<'auto' | 'zh' | 'en'>('auto')
const cadence = ref<Cadence>('WEEKLY')
const cronText = ref('0 4 * * 1')
const selectedScheduleId = ref<string | null>(null)
const starting = ref(false)
const saving = ref(false)
const savingSchedule = ref(false)
const history = ref<Summary[]>([])
const schedules = ref<Schedule[]>([])
const scorePoints = ref<GeoScorePoint[]>([])
const current = ref<Detail | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

const report = computed<Report | null>(() => current.value?.report ?? null)

const PILLAR_NAME: Record<string, string> = {
  agentReadiness: t("Agent 就绪"),
  citations: t("AI 引用快照"),
  citability: t("内容可引用性"),
  structuredSignals: t("结构化信号"),
}

const STATUS_LABEL: Record<string, string> = {
  QUEUED: t("排队"),
  RUNNING: t("进行中"),
  SUCCEEDED: t("完成"),
  PARTIAL: t("部分完成"),
  FAILED: t("失败"),
  PENDING: t("等待"),
  SKIPPED: t("跳过"),
  pass: t("通过"),
  warn: t("警告"),
  fail: t("未通过"),
  unknown: t("未知"),
}

const CADENCE_LABEL: Record<string, string> = {
  DAILY: t("每天 04:00"),
  WEEKLY: t("每周一 04:00"),
  MONTHLY: t("每月 1 日 04:00"),
  CRON: t("自定义"),
}

const KIND_LABEL: Record<string, string> = {
  brand: t("品牌"),
  category: t("品类"),
  comparison: t("对比"),
  custom: t("自填"),
}

const GAP_LABEL: Record<string, string> = {
  numeric: t("缺数字"),
  entity: t("缺实体"),
  selfContained: t("缺主谓宾"),
  definition: t("缺定义句"),
}

const IMPACT_LABEL: Record<string, string> = { high: t("高"), medium: t("中"), low: t("低") }

function tagType(status: string): 'success' | 'warning' | 'error' | 'default' | 'info' {
  if (status === 'SUCCEEDED' || status === 'pass') return 'success'
  if (status === 'RUNNING' || status === 'QUEUED' || status === 'PENDING' || status === 'warn' || status === 'PARTIAL') return 'warning'
  if (status === 'FAILED' || status === 'fail') return 'error'
  if (status === 'SKIPPED') return 'info'
  return 'default'
}

function gradeColor(grade: string | null | undefined): string {
  if (grade === 'A' || grade === 'B') return '#18a058'
  if (grade === 'C') return '#f0a020'
  return '#d03050'
}

function gapText(missing: string[]): string {
  return missing.map((gap) => GAP_LABEL[gap] ?? gap).join('、')
}

function pct(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${Math.round(value * 1000) / 10}%`
}

function linesOf(value: string): string[] {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function downloadText(filename: string, content: string, mime: string) {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

function downloadBase64(filename: string, content: string, mime: string) {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  downloadBlob(filename, new Blob([bytes], { type: mime }))
}

function when(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(appLocale.value, { timeZone: 'Asia/Shanghai' })
}

async function loadHistory() {
  history.value = await trpc.geoHealth.list.query({ limit: 20 })
}

async function loadSchedules() {
  schedules.value = await trpc.geoHealth.schedules.query()
}

async function loadTrend() {
  const result = await trpc.geoHealth.trend.query({ limit: 30 })
  scorePoints.value = result.points
}

async function loadCheck(id: string, poll: boolean) {
  const row = await trpc.geoHealth.get.query({ id })
  current.value = row
  if (row.status === 'SUCCEEDED' || row.status === 'PARTIAL' || row.status === 'FAILED') {
    stopPolling()
    await Promise.all([loadHistory(), loadTrend()])
    return
  }
  if (poll && !pollTimer) {
    pollTimer = setInterval(() => {
      loadCheck(id, false).catch(() => stopPolling())
    }, 1500)
  }
}

async function startCheck() {
  if (!brandName.value.trim() || !siteUrl.value.trim()) {
    message.warning(t("请填写品牌名和官网"))
    return
  }
  starting.value = true
  stopPolling()
  try {
    const created = await trpc.geoHealth.start.mutate({
      brandName: brandName.value.trim(),
      siteUrl: siteUrl.value.trim(),
      ...(industry.value.trim() ? { industry: industry.value.trim() } : {}),
      ...(linesOf(competitorsText.value).length > 0 ? { competitors: linesOf(competitorsText.value).slice(0, 8) } : {}),
      ...(linesOf(queriesText.value).length > 0 ? { queries: linesOf(queriesText.value).slice(0, 10) } : {}),
      language: language.value,
    })
    message.success(t("体检已开始"))
    await loadCheck(created.id, true)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("体检没有开始"))
  } finally {
    starting.value = false
  }
}

async function saveQueries() {
  if (!current.value) return
  saving.value = true
  try {
    const result = await trpc.geoHealth.saveQueries.mutate({ id: current.value.id })
    message.success(`${t("已保存 ")}${result.saved}${t(" 条到查询库，跳过 ")}${result.skipped}${t(" 条重复")}`)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("没有保存"))
  } finally {
    saving.value = false
  }
}

async function exportReport(format: 'markdown' | 'json' | 'pdf') {
  if (!current.value) return
  try {
    const file = await trpc.geoHealth.export.query({ id: current.value.id, format })
    if (file.encoding === 'base64') downloadBase64(file.filename, file.content, file.mime)
    else downloadText(file.filename, file.content, file.mime)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("导出失败"))
  }
}

function formPayload() {
  return {
    brandName: brandName.value.trim(),
    siteUrl: siteUrl.value.trim(),
    ...(industry.value.trim() ? { industry: industry.value.trim() } : {}),
    ...(linesOf(competitorsText.value).length > 0 ? { competitors: linesOf(competitorsText.value).slice(0, 8) } : {}),
    ...(linesOf(queriesText.value).length > 0 ? { queries: linesOf(queriesText.value).slice(0, 10) } : {}),
    language: language.value,
  }
}

async function saveSchedule() {
  if (!brandName.value.trim() || !siteUrl.value.trim()) {
    message.warning(t("请填写品牌名和官网"))
    return
  }
  if (cadence.value === 'CRON' && !cronText.value.trim()) {
    message.warning(t("请填写 cron"))
    return
  }
  savingSchedule.value = true
  try {
    const saved = await trpc.geoHealth.saveSchedule.mutate({
      ...(selectedScheduleId.value ? { id: selectedScheduleId.value } : {}),
      ...formPayload(),
      cadence: cadence.value,
      ...(cadence.value === 'CRON' ? { cron: cronText.value.trim() } : {}),
    })
    selectedScheduleId.value = saved.id
    message.success(t("已保存体检计划"))
    await loadSchedules()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("没有保存计划"))
  } finally {
    savingSchedule.value = false
  }
}

function fillFromSchedule(row: Schedule) {
  selectedScheduleId.value = row.id
  brandName.value = row.brandName
  siteUrl.value = row.siteUrl
  industry.value = row.industry ?? ''
  competitorsText.value = row.competitors.join('\n')
  queriesText.value = row.userQueries.join('\n')
  language.value = row.language
  cadence.value = row.cadence
  cronText.value = row.cron
}

async function toggleSchedule(row: Schedule, enabled: boolean) {
  try {
    await trpc.geoHealth.setScheduleEnabled.mutate({ id: row.id, enabled })
    await loadSchedules()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("没有改成"))
    await loadSchedules()
  }
}

async function removeSchedule(id: string) {
  try {
    await trpc.geoHealth.removeSchedule.mutate({ id })
    if (selectedScheduleId.value === id) selectedScheduleId.value = null
    message.success(t("已删除计划，已有报告还在"))
    await loadSchedules()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("没有删除"))
  }
}

const pillarRows = computed(() => {
  const progress = current.value?.progress
  if (!progress) return []
  return (Object.keys(PILLAR_NAME) as (keyof typeof PILLAR_NAME)[]).map((id) => ({
    id,
    name: PILLAR_NAME[id],
    status: progress.pillars[id].status,
    error: progress.pillars[id].error,
    score: report.value?.pillars[id].score ?? null,
  }))
})

const sovRows = computed(() => {
  const currentReport = report.value
  if (!currentReport) return []
  const citations = currentReport.pillars.citations
  return [
    {
      brand: currentReport.brandName,
      mentionRate: citations.mentionRate,
      shareOfVoice: citations.shareOfVoice,
      self: true,
    },
    ...citations.competitorSov.map((row: { brand: string; mentionRate: number; shareOfVoice: number }) => ({ ...row, self: false })),
  ]
})

const historyColumns: DataTableColumns<Summary> = [
  {
    title: t("时间"),
    key: 'createdAt',
    width: 180,
    render: (row) => new Date(row.createdAt).toLocaleString(appLocale.value),
  },
  { title: t("品牌"), key: 'brandName', width: 140 },
  { title: t("站点"), key: 'siteUrl', ellipsis: { tooltip: true } },
  {
    title: t("状态"),
    key: 'status',
    width: 100,
    render: (row) => STATUS_LABEL[row.status] ?? row.status,
  },
  {
    title: t("得分"),
    key: 'score',
    width: 90,
    render: (row) => row.score == null ? '—' : `${row.score} ${row.grade ?? ''}`,
  },
  {
    title: t("来源"),
    key: 'trigger',
    width: 80,
    render: (row) => row.trigger === 'SCHEDULED' ? t("定时") : t("手动"),
  },
]

function historyRowProps(row: Summary) {
  return {
    style: 'cursor: pointer',
    onClick: () => {
      stopPolling()
      loadCheck(row.id, row.status === 'QUEUED' || row.status === 'RUNNING').catch((err: unknown) => {
        message.error(err instanceof Error ? err.message : t("无法打开这条记录"))
      })
    },
  }
}

const busy = computed(() => current.value?.status === 'QUEUED' || current.value?.status === 'RUNNING')

onMounted(async () => {
  try {
    const ws = await trpc.workspace.get.query()
    if (ws.defaultBrandName && !brandName.value) brandName.value = ws.defaultBrandName
    if (ws.domain && !siteUrl.value) {
      siteUrl.value = /^https?:\/\//i.test(ws.domain) ? ws.domain : `https://${ws.domain}`
    }
  } catch {
    // 品牌和域名只是输入框的默认值
  }
  try {
    await Promise.all([loadHistory(), loadSchedules(), loadTrend()])
    const newest = history.value.find((row) => row.status === 'SUCCEEDED' || row.status === 'PARTIAL')
    if (newest) await loadCheck(newest.id, false)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : t("无法加载历史记录"))
  }
})

onUnmounted(stopPolling)
</script>

<template>
  <div>
    <PageHeader
      :title="t('GEO 体检')"
      :subtitle="t('填品牌名和官网，一次看清爬虫能不能进来、回答引擎会不会提到你、页面好不好引用。不必先配齐所有引擎。')"
    />

    <NCard :title="t('开始一次体检')" style="margin-bottom: 16px">
      <NGrid :cols="2" :x-gap="16" :y-gap="12" responsive="screen" item-responsive>
        <NGridItem span="2 m:1">
          <NText depth="3" style="font-size: 12px">{{ t('品牌名') }}</NText>
          <NInput v-model:value="brandName" :placeholder="t('例如：极客文档')" :disabled="starting" />
        </NGridItem>
        <NGridItem span="2 m:1">
          <NText depth="3" style="font-size: 12px">{{ t('官网') }}</NText>
          <NInput v-model:value="siteUrl" placeholder="https://example.com" :disabled="starting" @keyup.enter="startCheck" />
        </NGridItem>
        <NGridItem span="2 m:1">
          <NText depth="3" style="font-size: 12px">{{ t('行业（可选）') }}</NText>
          <NInput v-model:value="industry" :placeholder="t('例如：协作文档')" :disabled="starting" />
        </NGridItem>
        <NGridItem span="2 m:1">
          <NText depth="3" style="font-size: 12px">{{ t('问题语言') }}</NText>
          <NRadioGroup v-model:value="language" :disabled="starting" style="margin-top: 6px">
            <NRadioButton value="auto">{{ t('自动') }}</NRadioButton>
            <NRadioButton value="zh">{{ t('中文') }}</NRadioButton>
            <NRadioButton value="en">English</NRadioButton>
          </NRadioGroup>
        </NGridItem>
        <NGridItem span="2 m:1">
          <NText depth="3" style="font-size: 12px">{{ t('竞品（可选，每行一个或用逗号分隔，最多 8 个）') }}</NText>
          <NInput v-model:value="competitorsText" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="Northwind Ink" :disabled="starting" />
        </NGridItem>
        <NGridItem span="2 m:1">
          <NText depth="3" style="font-size: 12px">{{ t('目标问题（可选。留空则自动生成 5–8 个起步问题）') }}</NText>
          <NInput v-model:value="queriesText" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" :placeholder="t('最好的协作文档是哪家？')" :disabled="starting" />
        </NGridItem>
      </NGrid>
      <NSpace style="margin-top: 16px" align="center">
        <NButton type="primary" :loading="starting" @click="startCheck">{{ t('开始体检') }}</NButton>
        <NText depth="3" style="font-size: 12px">{{ t('后台分四步跑。某一步失败不会让整份报告作废。没配凭证的引擎会跳过并写进报告。') }}</NText>
      </NSpace>
    </NCard>

    <NCard :title="t('定时复跑')" style="margin-bottom: 16px">
      <NText depth="3" style="display: block; margin-bottom: 12px; font-size: 13px"> {{ t('按上面的品牌和官网保存一份计划。每天、每周、每月，或一段至少间隔 1 小时的 cron。时区是 Asia/Shanghai，和监测一样。每次跑完都是历史里的一份新报告。正在跑的时候不会再开一份。用的是这个工作区自己的引擎凭证。') }} </NText>
      <NSpace align="center" style="margin-bottom: 12px">
        <NRadioGroup v-model:value="cadence">
          <NRadioButton value="DAILY">{{ t('每天') }}</NRadioButton>
          <NRadioButton value="WEEKLY">{{ t('每周') }}</NRadioButton>
          <NRadioButton value="MONTHLY">{{ t('每月') }}</NRadioButton>
          <NRadioButton value="CRON">Cron</NRadioButton>
        </NRadioGroup>
        <NInput v-if="cadence === 'CRON'" v-model:value="cronText" placeholder="0 4 * * 1" style="width: 180px" />
        <NButton :loading="savingSchedule" @click="saveSchedule">{{ t('保存计划') }}</NButton>
      </NSpace>
      <div v-if="schedules.length === 0">
        <NText depth="3">{{ t('还没有计划。') }}</NText>
      </div>
      <div v-for="row in schedules" :key="row.id" style="display: flex; gap: 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--divider-color); font-size: 13px">
        <div style="flex: 1; cursor: pointer" @click="fillFromSchedule(row)">
          <div>{{ row.brandName }} · {{ row.cadence === 'CRON' ? row.cron : CADENCE_LABEL[row.cadence] }}</div>
          <NText depth="3" style="font-size: 12px">{{ t('下次') }} {{ when(row.nextRunAt) }} {{ t('· 上次') }} {{ when(row.lastRunAt) }} {{ row.lastStatus ? STATUS_LABEL[row.lastStatus] : '' }}</NText>
        </div>
        <NSwitch :value="row.enabled" @update:value="(value) => toggleSchedule(row, value)" />
        <NPopconfirm @positive-click="removeSchedule(row.id)">
          <template #trigger>
            <NButton size="tiny" quaternary type="error">{{ t('删除') }}</NButton>
          </template> {{ t('删除这份计划？已经生成的报告还在。') }} </NPopconfirm>
      </div>
    </NCard>

    <NCard :title="t('GEO 分数趋势')" style="margin-bottom: 16px">
      <NText depth="3" style="display: block; margin-bottom: 8px; font-size: 12px">{{ t('一次体检一个点，含总分和四根支柱。') }}</NText>
      <GeoScoreChart :points="scorePoints" />
    </NCard>

    <NSpin :show="busy">
      <NCard v-if="current && busy" :title="t('进度')" style="margin-bottom: 16px">
        <NProgress type="line" :percentage="current.progress.percent" :show-indicator="true" style="margin-bottom: 12px" />
        <NSpace vertical :size="8">
          <div v-for="row in pillarRows" :key="row.id" style="display: flex; gap: 12px; align-items: center">
            <NTag size="small" :type="tagType(row.status)" :bordered="false">{{ STATUS_LABEL[row.status] ?? row.status }}</NTag>
            <span>{{ row.name }}</span>
            <NText v-if="row.error" depth="3" style="font-size: 12px">{{ row.error }}</NText>
          </div>
        </NSpace>
      </NCard>

      <NCard v-else-if="current?.status === 'FAILED' && !report" :title="t('这次体检没有完成')" style="margin-bottom: 16px">
        <NText>{{ current.error || t('未知错误') }}</NText>
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
              <NTag v-if="current" size="small" :type="tagType(current.status)" :bordered="false" style="margin-top: 8px">
                {{ STATUS_LABEL[current.status] }}
              </NTag>
            </div>
            <NSpace>
              <NButton @click="exportReport('markdown')">{{ t('导出 Markdown') }}</NButton>
              <NButton @click="exportReport('json')">{{ t('导出 JSON') }}</NButton>
              <NButton @click="exportReport('pdf')">{{ t('导出 PDF') }}</NButton>
              <NButton type="primary" secondary :loading="saving" @click="saveQueries">{{ t('保存问题到查询库') }}</NButton>
            </NSpace>
          </NSpace>
          <NText depth="3" style="display: block; margin-top: 12px; font-size: 12px">{{ report.weighting.notes.zh }}</NText>
        </NCard>

        <NCard v-if="current?.diff" :title="t('和上次相比')" style="margin-bottom: 16px">
          <NText>
            {{ current.diff.previousScore }} {{ current.diff.previousGrade }}
            → {{ current.diff.currentScore }} {{ current.diff.currentGrade }}
            （{{ current.diff.scoreDelta > 0 ? '+' : '' }}{{ current.diff.scoreDelta }}）
          </NText>
          <NText depth="3" style="display: block; margin-top: 4px; font-size: 12px">{{ t('上次是') }} {{ when(current.diff.previousAt) }}</NText>
          <div v-for="item in current.diff.pillars" :key="item.pillar" style="display: flex; gap: 12px; padding: 4px 0; font-size: 13px">
            <span style="flex: 1">{{ PILLAR_NAME[item.pillar] }}</span>
            <span>{{ item.previous ?? '—' }} → {{ item.current ?? '—' }}</span>
            <NTag v-if="item.delta != null && item.delta < 0" size="small" type="error" :bordered="false">{{ t('退步') }} {{ item.delta }}</NTag>
            <NTag v-else-if="item.delta != null && item.delta > 0" size="small" type="success" :bordered="false">+{{ item.delta }}</NTag>
          </div>
          <div v-if="current.diff.newActions.length" style="margin-top: 8px">
            <NText strong style="font-size: 13px">{{ t('新出现') }}</NText>
            <div v-for="item in current.diff.newActions" :key="item.id" style="font-size: 13px">{{ item.title.zh }}</div>
          </div>
          <div v-if="current.diff.resolvedActions.length" style="margin-top: 8px">
            <NText strong style="font-size: 13px">{{ t('上次有、这次没有') }}</NText>
            <div v-for="item in current.diff.resolvedActions" :key="item.id" style="font-size: 13px">{{ item.title.zh }}</div>
          </div>
          <div v-if="current.diff.regressedActions.length" style="margin-top: 8px">
            <NText strong style="font-size: 13px">{{ t('影响变高了') }}</NText>
            <div v-for="item in current.diff.regressedActions" :key="item.id" style="font-size: 13px">{{ item.title.zh }}</div>
          </div>
        </NCard>

        <NGrid :cols="2" :x-gap="16" :y-gap="16" responsive="screen" item-responsive style="margin-bottom: 16px">
          <NGridItem span="2 m:1">
            <NCard :title="t('Agent 就绪')" size="small" style="height: 100%">
              <NSpace align="center">
                <NTag :type="tagType(report.pillars.agentReadiness.status)" :bordered="false">
                  {{ STATUS_LABEL[report.pillars.agentReadiness.status] }}
                </NTag>
                <NText strong>{{ report.pillars.agentReadiness.score ?? '—' }}</NText>
              </NSpace>
              <NText depth="3" style="display: block; margin-top: 8px; font-size: 13px">
                {{ report.pillars.agentReadiness.report?.summary.zh || report.pillars.agentReadiness.error || t('没有嵌入就绪报告') }}
              </NText>
              <div v-if="report.pillars.agentReadiness.report" style="margin-top: 8px">
                <NTag
                  v-for="item in report.pillars.agentReadiness.report.fixes.slice(0, 3)"
                  :key="item.checkId"
                  size="small"
                  style="margin: 0 6px 6px 0"
                  :type="item.status === 'fail' ? 'error' : 'warning'"
                  :bordered="false"
                >
                  {{ item.title.zh }}
                </NTag>
              </div>
            </NCard>
          </NGridItem>
          <NGridItem span="2 m:1">
            <NCard :title="t('AI 引用快照')" size="small" style="height: 100%">
              <NSpace align="center">
                <NTag :type="tagType(report.pillars.citations.status)" :bordered="false">
                  {{ STATUS_LABEL[report.pillars.citations.status] }}
                </NTag>
                <NText strong>{{ report.pillars.citations.score ?? '—' }}</NText>
              </NSpace>
              <NText depth="3" style="display: block; margin-top: 8px; font-size: 13px"> {{ t('提及') }} {{ pct(report.pillars.citations.mentionRate) }} {{ t('· 引用') }} {{ pct(report.pillars.citations.citationRate) }} {{ t('· 声量') }} {{ pct(report.pillars.citations.shareOfVoice) }}
                <template v-if="report.pillars.citations.meanRank != null"> {{ t('· 平均排名') }} {{ report.pillars.citations.meanRank.toFixed(1) }}</template>
              </NText>
              <NText v-if="report.pillars.citations.note" depth="3" style="display: block; margin-top: 6px; font-size: 12px">
                {{ report.pillars.citations.note.zh }}
              </NText>
              <div style="margin-top: 8px">
                <NTag v-for="name in report.pillars.citations.enginesRun" :key="name" size="small" type="success" :bordered="false" style="margin: 0 6px 6px 0">
                  {{ name }}
                </NTag>
                <NTag v-for="item in report.pillars.citations.enginesSkipped" :key="item.platform" size="small" :bordered="false" style="margin: 0 6px 6px 0">
                  {{ item.platform }} {{ t('跳过') }} </NTag>
              </div>
            </NCard>
          </NGridItem>
          <NGridItem span="2 m:1">
            <NCard :title="t('内容可引用性')" size="small" style="height: 100%">
              <NSpace align="center">
                <NTag :type="tagType(report.pillars.citability.status)" :bordered="false">
                  {{ STATUS_LABEL[report.pillars.citability.status] }}
                </NTag>
                <NText strong>{{ report.pillars.citability.score ?? '—' }}</NText>
              </NSpace>
              <NText v-if="report.pillars.citability.note" depth="3" style="display: block; margin-top: 8px; font-size: 12px">
                {{ report.pillars.citability.note.zh }}
              </NText>
              <div v-for="page in report.pillars.citability.weakestPages" :key="page.url" style="margin-top: 8px">
                <NText strong style="font-size: 13px">{{ page.title }}</NText>
                <NText depth="3" style="font-size: 12px"> {{ t('· 综合') }} {{ page.composite }}</NText>
                <div v-for="(atom, index) in page.weakestAtoms.slice(0, 2)" :key="index" style="font-size: 12px; color: var(--text-color-3)">
                  {{ atom.score }} {{ t('分') }} <template v-if="atom.missing.length">（{{ gapText(atom.missing) }}）</template>
                  ：{{ atom.text }}
                </div>
              </div>
              <NText v-if="report.pillars.citability.error" type="error" style="display: block; margin-top: 8px">
                {{ report.pillars.citability.error }}
              </NText>
            </NCard>
          </NGridItem>
          <NGridItem span="2 m:1">
            <NCard :title="t('结构化信号')" size="small" style="height: 100%">
              <NSpace align="center">
                <NTag :type="tagType(report.pillars.structuredSignals.status)" :bordered="false">
                  {{ STATUS_LABEL[report.pillars.structuredSignals.status] }}
                </NTag>
                <NText strong>{{ report.pillars.structuredSignals.score ?? '—' }}</NText>
              </NSpace>
              <NText depth="3" style="display: block; margin-top: 8px; font-size: 13px">
                JSON-LD {{ report.pillars.structuredSignals.jsonLdPresent ? t('有') : t('无') }}
                <template v-if="report.pillars.structuredSignals.schemaTypes.length">（{{ report.pillars.structuredSignals.schemaTypes.join('、') }}）</template>
                · llms.txt {{ STATUS_LABEL[report.pillars.structuredSignals.llmsTxtStatus] ?? report.pillars.structuredSignals.llmsTxtStatus }}
                · llms-full.txt {{ STATUS_LABEL[report.pillars.structuredSignals.llmsFullStatus] ?? report.pillars.structuredSignals.llmsFullStatus }}
              </NText>
              <NText v-if="report.pillars.structuredSignals.note" depth="3" style="display: block; margin-top: 6px; font-size: 12px">
                {{ report.pillars.structuredSignals.note.zh }}
              </NText>
              <NSpace style="margin-top: 10px">
                <NButton
                  size="small"
                  :disabled="!report.pillars.structuredSignals.generatedLlmsTxt"
                  @click="downloadText('llms.txt', report.pillars.structuredSignals.generatedLlmsTxt, 'text/plain;charset=utf-8')"
                > {{ t('下载 llms.txt') }} </NButton>
                <NButton
                  size="small"
                  :disabled="!report.pillars.structuredSignals.generatedJsonLd"
                  @click="downloadText('jsonld.json', report.pillars.structuredSignals.generatedJsonLd, 'application/json;charset=utf-8')"
                > {{ t('下载 JSON-LD') }} </NButton>
              </NSpace>
            </NCard>
          </NGridItem>
        </NGrid>

        <NCard v-if="sovRows.length > 1" :title="t('声量份额')" style="margin-bottom: 16px">
          <div v-for="row in sovRows" :key="row.brand" style="display: flex; gap: 16px; padding: 6px 0; border-bottom: 1px solid var(--divider-color); font-size: 13px">
            <span style="flex: 1">{{ row.brand }}<NText v-if="row.self" depth="3">{{ t('（本品）') }}</NText></span>
            <span>{{ t('提及') }} {{ pct(row.mentionRate) }}</span>
            <span>{{ t('声量') }} {{ pct(row.shareOfVoice) }}</span>
          </div>
        </NCard>

        <NCard v-if="report.pillars.citations.queries.length" :title="t('这次问了什么')" style="margin-bottom: 16px">
          <div v-for="query in report.pillars.citations.queries" :key="query.text" style="display: flex; gap: 12px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--divider-color); font-size: 13px">
            <span style="flex: 1">{{ query.text }}</span>
            <NTag size="small" :bordered="false">{{ KIND_LABEL[query.kind] ?? query.kind }}</NTag>
            <NText depth="3">{{ t('提及') }} {{ query.mentions }}/{{ query.samples }} {{ t('· 引用') }} {{ query.citations }}/{{ query.samples }}</NText>
          </div>
        </NCard>

        <NCard :title="t('优先做的 10 件事')" style="margin-bottom: 16px">
          <NText v-if="report.actions.length === 0" depth="3">{{ t('这次没有排出行动项。') }}</NText>
          <div v-for="(item, index) in report.actions" :key="item.id" style="padding: 10px 0; border-bottom: 1px solid var(--divider-color)">
            <NSpace align="center" :size="8">
              <NText strong>{{ index + 1 }}. {{ item.title.zh }}</NText>
              <NTag size="small" :bordered="false">{{ t('影响') }} {{ IMPACT_LABEL[item.impact] }}</NTag>
              <NTag size="small" :bordered="false">{{ t('工作量') }} {{ item.effortLabel.zh }}</NTag>
              <NTag size="small" :bordered="false">{{ PILLAR_NAME[item.pillar] }}</NTag>
            </NSpace>
            <NText style="display: block; margin-top: 6px; font-size: 13px">{{ t('做法：') }}{{ item.fix.zh }}</NText>
            <NText depth="3" style="display: block; margin-top: 4px; font-size: 12px">{{ t('如何验证：') }}{{ item.verify.zh }}</NText>
            <NText v-if="item.verifyQuery" depth="3" style="display: block; margin-top: 2px; font-size: 12px">{{ t('复跑问题：「') }}{{ item.verifyQuery }}」</NText>
          </div>
        </NCard>
      </template>
    </NSpin>

    <NCard :title="t('历史')">
      <NDataTable
        :columns="historyColumns"
        :data="history"
        :row-props="historyRowProps"
        :bordered="false"
        size="small"
      />
    </NCard>
  </div>
</template>

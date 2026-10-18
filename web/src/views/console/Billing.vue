<script setup lang="ts">
// 我的服务（客户侧，任务 14，规格 §4.3/§6.4）：
// - 生效订阅卡片：billing.subscriptions（plan 名称/状态 NTag/起止时间/到期日），
//   续费按钮跳服务商城；
// - 配额与当月用量进度条：billing.entitlements（{ limits, usage }）六个容量键
//   NProgress（当前用量/上限，samplesPerRun 无月度计量展示"—/上限"，超限红色）。
import { computed, onMounted, ref } from 'vue'
import {
  NButton, NCard, NEmpty, NGrid, NGridItem, NProgress, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const router = useRouter()
const message = useMessage()

type SubscriptionsResult = Awaited<ReturnType<typeof trpc.billing.subscriptions.query>>
type SubscriptionRow = SubscriptionsResult['items'][number]
type EntitlementsResult = Awaited<ReturnType<typeof trpc.billing.entitlements.query>>

const loading = ref(false)
const subscriptions = ref<SubscriptionRow[]>([])
const entitlements = ref<EntitlementsResult | null>(null)

const SUB_STATUS_META: Record<string, { type: 'success' | 'warning' | 'default' | 'error'; label: string }> = {
  ACTIVE: { type: 'success', label: '生效中' },
  GRACE: { type: 'warning', label: '宽限期' },
  EXPIRED: { type: 'error', label: '已到期' },
  CANCELLED: { type: 'default', label: '已取消' },
}

function subStatusMeta(status: string) {
  return SUB_STATUS_META[status] ?? { type: 'default' as const, label: status }
}

async function load() {
  loading.value = true
  try {
    const [subs, ents] = await Promise.all([
      trpc.billing.subscriptions.query(),
      trpc.billing.entitlements.query(),
    ])
    subscriptions.value = subs.items
    entitlements.value = ents
  } catch (e: any) {
    message.error(e?.message || '服务信息加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function fmtDate(value: string | Date | null): string {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '—'
}

/** 配额键 → 中文标签（与后端 CAPACITY_FIELDS ∪ OPTIONAL_CAPACITY_FIELDS 同键集） */
const QUOTA_FIELDS: { key: keyof EntitlementsResult['usage']; label: string }[] = [
  { key: 'maxWorkspaces', label: 'Workspace 数' },
  { key: 'maxQueries', label: '查询数 / 月' },
  { key: 'maxPages', label: '页面数' },
  { key: 'diagnosticRunsPerMonth', label: '诊断次数 / 月' },
  { key: 'samplesPerRun', label: '单次样本数' },
  { key: 'optimizationsPerMonth', label: '优化次数 / 月' },
  // M2 §3.0：单次运行采样数上限——单次参数，无月度计量，展示"上限 3 / —"不画进度条
  { key: 'monitorSampleCountMax', label: '监测采样数上限 N' },
]

/** 用量进度（百分比）：上限 0 视为未开通（null 不渲染条），超限 100+ 红色 */
function quotaPercent(usage: number, limit: number): number | null {
  if (limit <= 0) return null
  return Math.min(Math.round((usage / limit) * 100), 100)
}

function quotaStatus(usage: number, limit: number): 'default' | 'success' | 'warning' | 'error' {
  if (limit <= 0) return 'default'
  if (usage > limit) return 'error'
  if (usage >= limit * 0.8) return 'warning'
  return 'success'
}

/** samplesPerRun 为单次上限无月度计量（usage 恒 0 展示"—"） */
function isUnmetered(key: keyof EntitlementsResult['usage']): boolean {
  return key === 'samplesPerRun' || key === 'monitorSampleCountMax'
}

/** 单次运行上限类字段：只展示"上限 N / —"，不画进度条（无月度累计语义） */
function isSingleRunLimit(key: keyof EntitlementsResult['usage']): boolean {
  return key === 'samplesPerRun' || key === 'monitorSampleCountMax'
}

/**
 * 上限文案：monitorSampleCountMax 未声明 = 不限（键缺失），展示"—"而不是 0——
 * 0 会被误读成"一次都不能跑"。
 */
function quotaLimitText(key: keyof EntitlementsResult['usage']): string {
  const limit = entitlements.value?.limits[key]
  if (limit === undefined || limit === null) return key === 'monitorSampleCountMax' ? '—（不限）' : '0'
  return String(limit)
}

// 统计窗口标签（遗留 D4）：取后端 billing.entitlements 返回的 periodStart/periodEnd
// ——后端已改为返回 usage 实际聚合的新鲜自然月窗口（与 OE 存量行窗口解耦，
// 跨月未 recompute 不再滞后）；字段缺省（null）时隐藏标签（无统计窗口）
const periodLabel = computed(() => {
  if (!entitlements.value?.periodStart || !entitlements.value?.periodEnd) return ''
  const { periodStart, periodEnd } = entitlements.value
  return `${fmtDate(periodStart)} ~ ${fmtDate(periodEnd)}`
})
</script>

<template>
  <div style="max-width: 1200px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="我的服务" subtitle="订阅状态与企业配额用量" />
      <NButton size="small" type="primary" @click="router.push({ name: 'console-services' })">
        续费 / 加购
      </NButton>
    </NSpace>

    <NSpace v-if="loading" justify="center" style="margin-top: 96px">
      <NText depth="3">加载中…</NText>
    </NSpace>

    <template v-else>
      <!-- 生效订阅卡片 -->
      <NEmpty
        v-if="subscriptions.length === 0"
        description="暂无订阅记录，可前往服务商城开通。"
        size="small"
        style="margin-bottom: 24px"
      >
        <template #extra>
          <NButton size="small" type="primary" @click="router.push({ name: 'console-services' })">
            去商城开通
          </NButton>
        </template>
      </NEmpty>

      <NGrid
        v-else
        :cols="3"
        :x-gap="16"
        :y-gap="16"
        responsive="screen"
        item-responsive
        style="margin-bottom: 24px"
      >
        <NGridItem v-for="sub in subscriptions" :key="sub.id" span="3 m:2 l:1">
          <NCard size="small" style="height: 100%">
            <template #header>
              <NText strong style="font-size: 15px">{{ sub.planName }}</NText>
            </template>
            <template #header-extra>
              <NTag size="small" :bordered="false" :type="subStatusMeta(sub.status).type">
                {{ subStatusMeta(sub.status).label }}
              </NTag>
            </template>
            <NSpace vertical :size="6">
              <NText depth="3" style="font-size: 13px">起始：{{ fmtDate(sub.startAt) }}</NText>
              <NText depth="3" style="font-size: 13px">
                到期：<NText :type="sub.status === 'ACTIVE' ? 'default' : 'warning'">
                  {{ fmtDate(sub.endAt) }}
                </NText>
              </NText>
            </NSpace>
            <template #footer>
              <NButton size="tiny" tertiary @click="router.push({ name: 'console-services' })">
                续费
              </NButton>
            </template>
          </NCard>
        </NGridItem>
      </NGrid>

      <!-- 配额与当月用量（§4.3 六字段进度条） -->
      <NCard size="small" title="配额与当月用量">
        <template #header-extra>
          <NText depth="3" style="font-size: 12px">
            {{ periodLabel ? `统计窗口 ${periodLabel}（上海自然月）` : '暂无统计窗口' }}
          </NText>
        </template>
        <NGrid :cols="2" :x-gap="24" :y-gap="20" responsive="screen" item-responsive>
          <NGridItem v-for="field in QUOTA_FIELDS" :key="field.key" span="2 m:1">
            <NSpace vertical :size="4">
              <NSpace justify="space-between" align="center">
                <NText style="font-size: 13px">{{ field.label }}</NText>
                <NText depth="3" style="font-size: 12px">
                  {{ isUnmetered(field.key) ? '—' : entitlements?.usage[field.key] ?? 0 }}
                  / {{ quotaLimitText(field.key) }}
                </NText>
              </NSpace>
              <NProgress
                v-if="!isSingleRunLimit(field.key) && quotaPercent(entitlements?.usage[field.key] ?? 0, entitlements?.limits[field.key] ?? 0) !== null"
                :percentage="quotaPercent(entitlements?.usage[field.key] ?? 0, entitlements?.limits[field.key] ?? 0) ?? 0"
                :status="quotaStatus(entitlements?.usage[field.key] ?? 0, entitlements?.limits[field.key] ?? 0)"
                :show-indicator="false"
              />
              <NText v-else depth="3" style="font-size: 12px">
                {{ isSingleRunLimit(field.key) ? '单次运行上限，无月度统计' : '未开通或无计量（上限 0）' }}
              </NText>
            </NSpace>
          </NGridItem>
        </NGrid>
        <NText depth="3" style="font-size: 12px">
          配额为各有效订阅/加购合并后的企业级池化上限；超限时软限不拦截但会收到提醒。
        </NText>
      </NCard>
    </template>
  </div>
</template>

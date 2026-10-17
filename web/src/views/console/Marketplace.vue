<script setup lang="ts">
// 服务商城（客户侧，任务 14，规格 §4.3 / §6.1）：
// - 数据源 catalog.list（authed：登录即可见在售目录），按 kind 分三组渲染：
//   SUBSCRIPTION 套餐对比 / SERVICE 单项服务 / ADDON 加购；
// - 商品卡内套餐为可选中的小卡（点选高亮），展示价格（分→元）、计费周期与配额摘要；
// - 下单 Modal（仅 ORG_OWNER 可见按钮——order.create 为 OWNER 专属，数据面后端判）：
//   数量（ADDON 可调 ≥1，SUBSCRIPTION/SERVICE 固定 1）+ ADDON/SERVICE 可选目标
//   workspace（数据源 me().workspaces，可空）+ 支付方式四选（对公转账默认）；
// - 提交后按支付方式分流：微信/支付宝 → createPayment 展示 mock payUrl（提示扫码）；
//   对公转账 → 跳订单详情引导上传回单；合同账期 → 提示联系运营开通并跳订单详情。
import { computed, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NGrid, NGridItem, NInput, NInputNumber,
  NInputGroup, NModal, NRadio, NRadioGroup, NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { formatCents } from '../../utils/money'

const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

/**
 * 目录行：与后端 CatalogListResult 的线上形状对齐。直接 Awaited<ReturnType<...>>
 * 推导该端点会因 entitlements/deliverables 的 Prisma JsonValue 递归类型触发
 * TS2589（同 Credentials.vue 的做法），故本地声明（Json 通道下均为 unknown 消费）。
 */
interface PlanRow {
  id: string
  name: string
  priceCents: number
  billingPeriod: 'MONTH' | 'YEAR' | null
  entitlements: unknown
  deliverables: unknown
}
interface ProductRow {
  id: string
  code: string
  name: string
  kind: 'SUBSCRIPTION' | 'SERVICE' | 'ADDON'
  description: string
  plans: PlanRow[]
}

const loading = ref(false)
const items = ref<ProductRow[]>([])

const KIND_GROUP: { kind: ProductRow['kind']; title: string; hint: string }[] = [
  { kind: 'SUBSCRIPTION', title: '套餐订阅', hint: '按月/年订阅，配额按套餐合并计算' },
  { kind: 'SERVICE', title: '单项服务', hint: '一次性专业服务，交付里程碑跟踪' },
  { kind: 'ADDON', title: '加购包', hint: '在订阅基础上叠加容量配额' },
]

const PERIOD_LABEL: Record<string, string> = {
  MONTH: ' / 月',
  YEAR: ' / 年',
}

/** 配额键 → 中文标签（与后端 CAPACITY_FIELDS 同键集） */
const QUOTA_LABEL: Record<string, string> = {
  maxWorkspaces: 'Workspace 数',
  maxQueries: '查询数 / 月',
  maxPages: '页面数',
  diagnosticRunsPerMonth: '诊断次数 / 月',
  samplesPerRun: '单次样本数',
  optimizationsPerMonth: '优化次数 / 月',
}

/** 配额摘要：已知键映射中文标签，allowedPlatforms 单列，未知键原样展示 */
function quotaSummary(entitlements: unknown): string[] {
  if (entitlements === null || typeof entitlements !== 'object' || Array.isArray(entitlements)) {
    return []
  }
  const record = entitlements as Record<string, unknown>
  const parts: string[] = []
  for (const [key, label] of Object.entries(QUOTA_LABEL)) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${label} ${value}`)
  }
  const platforms = record.allowedPlatforms
  if (Array.isArray(platforms) && platforms.length > 0) {
    parts.push(`平台 ${platforms.join(' / ')}`)
  }
  return parts
}

/** 服务交付模板条数（SERVICE 里程碑） */
function deliverableCount(deliverables: unknown): number {
  return Array.isArray(deliverables) ? deliverables.length : 0
}

async function load() {
  loading.value = true
  try {
    const result = await trpc.catalog.list.query()
    items.value = result.items
  } catch (e: any) {
    message.error(e?.message || '商城目录加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function groupItems(kind: ProductRow['kind']): ProductRow[] {
  return items.value.filter((product) => product.kind === kind)
}

// ORG_MEMBER/ORG_VIEWER 无 order.create——下单按钮隐藏（数据面后端判，双保险）
const canOrder = computed(() => sessionStore.me?.orgRole === 'ORG_OWNER')

// ===== 下单 Modal =====
interface Draft {
  product: ProductRow | null
  plan: PlanRow | null
  quantity: number
  workspaceId: string | null
  paymentMethod: 'BANK_TRANSFER' | 'CONTRACT_CREDIT' | 'WECHAT' | 'ALIPAY'
}

const showModal = ref(false)
const creating = ref(false)
const draft = ref<Draft>({
  product: null,
  plan: null,
  quantity: 1,
  workspaceId: null,
  paymentMethod: 'BANK_TRANSFER',
})

/** 目标 workspace 下拉（ADDON/SERVICE 可选）：数据源 me().workspaces */
const workspaceOptions = computed<SelectOption[]>(() =>
  (sessionStore.me?.workspaces?.items ?? []).map((w) => ({ label: w.name, value: w.id })),
)

function openOrder(product: ProductRow, plan: PlanRow) {
  draft.value = {
    product,
    plan,
    quantity: 1,
    workspaceId: null,
    paymentMethod: 'BANK_TRANSFER',
  }
  showModal.value = true
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制')
  } catch {
    message.error('复制失败，请手动选择复制')
  }
}

async function handleSubmit() {
  const d = draft.value
  if (!d.plan) return
  creating.value = true
  try {
    const result = await trpc.orders.create.mutate({
      items: [
        {
          planId: d.plan.id,
          quantity: d.quantity,
          ...(d.workspaceId ? { workspaceId: d.workspaceId } : {}),
        },
      ],
    })
    showModal.value = false
    const orderId = result.order.id
    if (d.paymentMethod === 'WECHAT' || d.paymentMethod === 'ALIPAY') {
      // 在线支付：立即发起渠道下单，成功后展示 mock payUrl（扫码/复制打开）
      try {
        const payment = await trpc.orders.createPayment.mutate({ orderId, method: d.paymentMethod })
        payUrl.value = payment.payUrl
        channelOrderNo.value = payment.channelOrderNo
        payOrderNo.value = result.order.orderNo
        showPayUrl.value = true
      } catch (e: any) {
        message.error(e?.message || '发起支付失败，可稍后在订单详情重试')
        router.push({ name: 'console-order-detail', params: { id: orderId } })
      }
      return
    }
    if (d.paymentMethod === 'CONTRACT_CREDIT') {
      message.info('合同账期需联系运营开通后生效；订单已创建，可先在订单详情查看。')
    } else {
      message.success('订单已创建，请通过对公转账付款并上传回单。')
    }
    router.push({ name: 'console-order-detail', params: { id: orderId } })
  } catch (e: any) {
    message.error(e?.message || '下单失败')
  } finally {
    creating.value = false
  }
}

// ===== 在线支付 payUrl 展示（mock 渠道链接 + 扫码提示） =====
const showPayUrl = ref(false)
const payUrl = ref('')
const channelOrderNo = ref('')
const payOrderNo = ref('')

function closePayUrl() {
  showPayUrl.value = false
  payUrl.value = ''
  channelOrderNo.value = ''
  payOrderNo.value = ''
}
</script>

<template>
  <div style="max-width: 1200px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="服务商城" subtitle="订阅套餐、专业服务与容量加购" />
      <NButton tertiary size="small" @click="router.push({ name: 'console-orders' })">
        我的订单
      </NButton>
    </NSpace>

    <NAlert
      v-if="!canOrder"
      type="info"
      :bordered="false"
      :closable="false"
      style="margin-bottom: 16px"
    >
      浏览目录全员可用；下单仅企业管理员（ORG_OWNER）可操作，请联系管理员完成购买。
    </NAlert>

    <NSpace v-if="loading" justify="center" style="margin-top: 96px">
      <NText depth="3">加载中…</NText>
    </NSpace>

    <NEmpty
      v-else-if="items.length === 0"
      description="商城暂无在售商品，请联系商务上架。"
      style="margin-top: 96px"
    />

    <NSpace v-else vertical :size="32">
      <section v-for="group in KIND_GROUP" :key="group.kind">
        <NSpace align="baseline" :size="10" style="margin-bottom: 12px">
          <NText strong style="font-size: 16px">{{ group.title }}</NText>
          <NText depth="3" style="font-size: 12px">{{ group.hint }}</NText>
        </NSpace>

        <NEmpty
          v-if="groupItems(group.kind).length === 0"
          :description="`暂无在售${group.title}`"
          size="small"
        />

        <NGrid v-else :cols="3" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
          <NGridItem v-for="product in groupItems(group.kind)" :key="product.id" span="3 m:2 l:1">
            <NCard size="small" style="height: 100%">
              <template #header>
                <NText strong style="font-size: 15px">{{ product.name }}</NText>
              </template>
              <template #header-extra>
                <NTag size="small" :bordered="false">{{ product.code }}</NTag>
              </template>
              <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 12px">
                {{ product.description || '—' }}
              </NText>
              <NSpace vertical :size="8">
                <NCard
                  v-for="plan in product.plans"
                  :key="plan.id"
                  size="small"
                  :bordered="true"
                  style="cursor: pointer"
                  @click="canOrder && openOrder(product, plan)"
                >
                  <NSpace justify="space-between" align="center">
                    <NSpace vertical :size="4">
                      <NText strong style="font-size: 14px">{{ plan.name }}</NText>
                      <NText depth="3" style="font-size: 12px">
                        {{ quotaSummary(plan.entitlements).join(' · ') || '以商务方案为准' }}
                        <template v-if="group.kind === 'SERVICE' && deliverableCount(plan.deliverables)">
                          · {{ deliverableCount(plan.deliverables) }} 个交付里程碑
                        </template>
                      </NText>
                    </NSpace>
                    <NSpace vertical :size="4" align="end">
                      <NText strong style="font-size: 16px; color: var(--primary-color)">
                        ¥{{ formatCents(plan.priceCents) }}{{ PERIOD_LABEL[plan.billingPeriod ?? ''] ?? '' }}
                      </NText>
                      <NButton v-if="canOrder" size="tiny" type="primary" secondary>
                        立即购买
                      </NButton>
                    </NSpace>
                  </NSpace>
                </NCard>
              </NSpace>
            </NCard>
          </NGridItem>
        </NGrid>
      </section>
    </NSpace>

    <!-- 下单 Modal -->
    <NModal
      v-model:show="showModal"
      preset="card"
      title="确认下单"
      style="width: 560px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="100">
        <NFormItem label="套餐">
          <NSpace vertical :size="2">
            <NText strong>{{ draft.plan?.name }}</NText>
            <NText depth="3" style="font-size: 12px">
              {{ draft.product?.name }} · ¥{{ formatCents(draft.plan?.priceCents ?? null)
              }}{{ PERIOD_LABEL[draft.plan?.billingPeriod ?? ''] ?? ' / 次' }}
            </NText>
          </NSpace>
        </NFormItem>
        <NFormItem label="数量">
          <NInputNumber
            v-if="draft.product?.kind === 'ADDON'"
            v-model:value="draft.quantity"
            :min="1"
            :precision="0"
            style="width: 160px"
          />
          <NText v-else depth="3">1（{{ draft.product?.kind === 'SUBSCRIPTION' ? '订阅' : '服务' }}类商品单笔一件）</NText>
        </NFormItem>
        <NFormItem
          v-if="draft.product?.kind === 'ADDON' || draft.product?.kind === 'SERVICE'"
          label="目标 Workspace"
        >
          <NSelect
            v-model:value="draft.workspaceId"
            :options="workspaceOptions"
            clearable
            filterable
            placeholder="可选——加购配额作用 / 服务交付的目标工作区"
          />
        </NFormItem>
        <NFormItem label="支付方式">
          <NSpace vertical :size="8" style="width: 100%">
            <NRadioGroup v-model:value="draft.paymentMethod">
              <NSpace vertical :size="6">
                <NRadio value="BANK_TRANSFER">对公转账（上传回单确认）</NRadio>
                <NRadio value="CONTRACT_CREDIT">合同账期</NRadio>
                <NRadio value="WECHAT">微信支付</NRadio>
                <NRadio value="ALIPAY">支付宝</NRadio>
              </NSpace>
            </NRadioGroup>
            <NText depth="3" style="font-size: 12px">
              合同账期需联系运营开通；微信/支付宝为 mock 渠道（演示扫码流程）。
            </NText>
          </NSpace>
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="handleSubmit">
            提交订单（¥{{ formatCents((draft.plan?.priceCents ?? 0) * draft.quantity) }}）
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 在线支付 payUrl 展示（mock） -->
    <NModal
      :show="showPayUrl"
      preset="card"
      title="扫码支付（mock 渠道）"
      style="width: 560px"
      :mask-closable="false"
      @update:show="(v: boolean) => { if (!v) closePayUrl() }"
    >
      <NSpace vertical :size="12">
        <NText style="font-size: 13px">
          订单 <NText code>{{ payOrderNo }}</NText> 已创建，使用手机扫码或复制链接完成支付（演示环境为 mock 链接）。
        </NText>
        <NInputGroup>
          <NInput :value="payUrl" readonly />
          <NButton type="primary" @click="copyText(payUrl)">复制链接</NButton>
        </NInputGroup>
        <NText depth="3" style="font-size: 12px">
          渠道单号 {{ channelOrderNo }}；支付完成后由渠道回调自动确认，也可稍后在"我的订单"查看状态。
        </NText>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton type="primary" @click="closePayUrl">完成</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

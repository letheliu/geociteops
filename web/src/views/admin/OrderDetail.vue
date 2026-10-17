<script setup lang="ts">
// 订单详情（平台侧，任务 15）：数据源 admin.orders.get（order.view）——
// order 标量（含 organizationId/remark）+ items 快照 + payments 流水 + events 时间线。
// 平台操作区（order.manage：OPERATOR/SUPER_ADMIN；FINANCE/SUPPORT 只读）：
// - PENDING_PAYMENT → 取消（NPopconfirm）/ 账期开通（Modal dueDays 1..3650）；
// - FULFILLING/COMPLETED/PARTIALLY_REFUNDED → 退款管理入口（refund.request 仅此
//   三态可发起；PAID 不显示——遗留 D5，退款申请由客户在订单详情发起，
//   平台在退款工作台审批——无 admin 发起接口，此处仅导航）；
// - REFUNDING → 退款审批中标签 + 退款管理入口。
// 展示逻辑大量复用客户侧 console/OrderDetail.vue（权限分叉：平台按 platformRole）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NForm, NFormItem,
  NInputNumber, NModal, NPopconfirm, NSpace, NTag, NText, NTimeline, NTimelineItem, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { formatCents } from '../../utils/money'
import {
  orderEventLabel, orderStatusMeta, paymentMethodLabel, paymentStatusLabel,
} from '../../utils/order'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

/**
 * 详情载荷：与后端 splitOrderDetail 投影的线上形状对齐（JSON 通道下日期为 ISO 字符串，
 * planSnapshot 为 JsonValue——本地声明消费，避开 Prisma Json 递归类型，同客户侧做法）。
 */
interface OrderDetailPayload {
  order: {
    id: string
    orderNo: string
    organizationId: string
    status: string
    totalCents: number
    discountCents: number
    payableCents: number
    refundedCents: number
    currency: string
    paymentMethod: string | null
    dueAt: string | null
    paidAt: string | null
    remark: string | null
    createdAt: string
    updatedAt: string
  }
  items: {
    id: string
    planId: string
    workspaceId: string | null
    quantity: number
    unitPriceCents: number
    planSnapshot: { name?: unknown } & Record<string, unknown>
  }[]
  payments: {
    id: string
    method: string
    status: string
    amountCents: number
    voucherFileKey: string | null
    channelOrderNo: string | null
    createdAt: string
  }[]
  events: {
    id: string
    event: string
    fromStatus: string | null
    toStatus: string
    actorId: string | null
    note: string | null
    createdAt: string
  }[]
}

const loading = ref(false)
const detail = ref<OrderDetailPayload | null>(null)

const orderId = route.params.id as string
const order = computed(() => detail.value?.order ?? null)

/** order.manage（OPERATOR/SUPER_ADMIN）：取消/账期开通可见性 */
const canManage = computed(() =>
  sessionStore.me?.platformRole === 'OPERATOR' || sessionStore.me?.platformRole === 'SUPER_ADMIN',
)

const statusMeta = computed(() => (order.value ? orderStatusMeta(order.value.status) : null))

async function load() {
  loading.value = true
  try {
    detail.value = (await trpc.admin.orders.get.query({ orderId })) as unknown as OrderDetailPayload
  } catch (e: any) {
    message.error(e?.message || '订单详情加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

function snapshotName(item: OrderDetailPayload['items'][number]): string {
  return typeof item.planSnapshot?.name === 'string' ? item.planSnapshot.name : item.planId
}

function transitionText(from: string | null, to: string): string {
  const fromLabel = from ? orderStatusMeta(from).label : '初始'
  return `${fromLabel} → ${orderStatusMeta(to).label}`
}

// ===== 平台操作：取消 =====
const cancelling = ref(false)

async function handleCancel() {
  cancelling.value = true
  try {
    await trpc.admin.orders.cancel.mutate({ orderId })
    message.success('订单已取消')
    await load()
  } catch (e: any) {
    message.error(e?.message || '取消失败')
  } finally {
    cancelling.value = false
  }
}

// ===== 平台操作：账期开通（PENDING_PAYMENT → FULFILLING + 应收流水） =====
const showCreditModal = ref(false)
const creditDueDays = ref<number | null>(30)
const openingCredit = ref(false)

function openCredit() {
  creditDueDays.value = 30
  showCreditModal.value = true
}

async function handleOpenCredit() {
  const dueDays = creditDueDays.value
  if (!dueDays || !Number.isInteger(dueDays) || dueDays < 1 || dueDays > 3650) {
    message.warning('账期天数须为 1-3650 的整数')
    return
  }
  openingCredit.value = true
  try {
    const result = await trpc.admin.orders.openOnCredit.mutate({ orderId, dueDays })
    message.success(
      `账期已开通，截止 ${new Date(result.dueAt).toLocaleDateString('zh-CN')}；请到「收款确认-应收账期」跟踪回款。`,
    )
    showCreditModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '账期开通失败')
  } finally {
    openingCredit.value = false
  }
}

// ===== 行项 / 支付流水表格 =====
const itemColumns: DataTableColumns<OrderDetailPayload['items'][number]> = [
  { title: '商品', key: 'name', minWidth: 200, render: snapshotName },
  { title: '数量', key: 'quantity', width: 80 },
  {
    title: '单价',
    key: 'unitPriceCents',
    width: 110,
    render: (row) => `¥${formatCents(row.unitPriceCents)}`,
  },
  {
    title: '小计',
    key: 'subtotal',
    width: 110,
    render: (row) => `¥${formatCents(row.unitPriceCents * row.quantity)}`,
  },
  {
    title: '目标 Workspace',
    key: 'workspaceId',
    width: 160,
    ellipsis: { tooltip: true },
    render: (row) => row.workspaceId ?? '—',
  },
]

const paymentColumns: DataTableColumns<OrderDetailPayload['payments'][number]> = [
  { title: '通道', key: 'method', width: 110, render: (row) => paymentMethodLabel(row.method) },
  { title: '状态', key: 'status', width: 100, render: (row) => paymentStatusLabel(row.status) },
  {
    title: '金额',
    key: 'amountCents',
    width: 110,
    render: (row) => `¥${formatCents(row.amountCents)}`,
  },
  {
    title: '渠道单号',
    key: 'channelOrderNo',
    width: 170,
    ellipsis: { tooltip: true },
    render: (row) => row.channelOrderNo ?? '—',
  },
  {
    title: '回单',
    key: 'voucherFileKey',
    width: 90,
    render: (row) =>
      row.voucherFileKey
        ? h(
            NButton,
            { size: 'tiny', tertiary: true, tag: 'a', href: `/files/${row.voucherFileKey}`, target: '_blank' },
            { default: () => '预览' },
          )
        : '—',
  },
  {
    title: '时间',
    key: 'createdAt',
    width: 170,
    render: (row) => fmtDate(row.createdAt),
  },
]
</script>

<template>
  <div>
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="订单详情" :subtitle="order?.orderNo" />
      <NSpace align="center">
        <NTag v-if="statusMeta" size="small" :bordered="false" :type="statusMeta.type">
          {{ statusMeta.label }}
        </NTag>
        <NButton size="small" tertiary @click="router.push({ name: 'admin-orders' })">
          返回列表
        </NButton>
      </NSpace>
    </NSpace>

    <NSpace v-if="loading" justify="center" style="margin-top: 96px">
      <NText depth="3">加载中…</NText>
    </NSpace>

    <template v-else-if="order">
      <NAlert
        v-if="!canManage"
        type="info"
        :bordered="false"
        :closable="false"
        style="margin-bottom: 16px"
      >
        当前为只读视图：取消与账期开通仅运营（OPERATOR）与超级管理员可执行。
      </NAlert>

      <!-- 平台操作区（order.manage） -->
      <NSpace v-if="canManage" :size="8" style="margin-bottom: 16px">
        <template v-if="order.status === 'PENDING_PAYMENT'">
          <NPopconfirm @positive-click="handleCancel">
            <template #trigger>
              <NButton size="small" type="warning" :loading="cancelling">取消订单</NButton>
            </template>
            确认取消该订单？取消后不可恢复。
          </NPopconfirm>
          <NButton size="small" type="primary" secondary @click="openCredit">账期开通</NButton>
        </template>
        <template v-else-if="order.status === 'REFUNDING'">
          <NTag type="warning" :bordered="false">退款审批中</NTag>
          <NButton size="small" type="warning" secondary @click="router.push({ name: 'admin-refunds' })">
            前往退款管理
          </NButton>
        </template>
        <template v-else-if="['FULFILLING', 'COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)">
          <NButton size="small" type="warning" secondary @click="router.push({ name: 'admin-refunds' })">
            退款管理
          </NButton>
          <NText depth="3" style="font-size: 12px; align-self: center">
            退款申请由客户在订单详情发起，平台在退款管理中审批。
          </NText>
        </template>
      </NSpace>

      <!-- 订单信息 -->
      <NCard size="small" title="订单信息" style="margin-bottom: 16px">
        <NDescriptions :column="3" label-placement="left" size="small">
          <NDescriptionsItem label="订单号">{{ order.orderNo }}</NDescriptionsItem>
          <NDescriptionsItem label="企业 ID">{{ order.organizationId }}</NDescriptionsItem>
          <NDescriptionsItem label="创建时间">{{ fmtDate(order.createdAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="商品总额">¥{{ formatCents(order.totalCents) }}</NDescriptionsItem>
          <NDescriptionsItem label="优惠金额">¥{{ formatCents(order.discountCents) }}</NDescriptionsItem>
          <NDescriptionsItem label="应付金额">
            <NText strong style="color: var(--primary-color)">¥{{ formatCents(order.payableCents) }}</NText>
          </NDescriptionsItem>
          <NDescriptionsItem label="已退金额">¥{{ formatCents(order.refundedCents) }}</NDescriptionsItem>
          <NDescriptionsItem label="支付方式">{{ paymentMethodLabel(order.paymentMethod) }}</NDescriptionsItem>
          <NDescriptionsItem label="支付时间">{{ fmtDate(order.paidAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="账期截止">{{ fmtDate(order.dueAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="备注">{{ order.remark ?? '—' }}</NDescriptionsItem>
        </NDescriptions>
      </NCard>

      <!-- 行项 -->
      <NCard size="small" title="商品明细" style="margin-bottom: 16px">
        <NDataTable
          :columns="itemColumns"
          :data="detail?.items ?? []"
          :bordered="false"
          :row-key="(row: OrderDetailPayload['items'][number]) => row.id"
          :pagination="false"
        />
      </NCard>

      <!-- 支付流水（回单预览 / 渠道单号 / 到账状态） -->
      <NCard size="small" title="支付流水" style="margin-bottom: 16px">
        <NDataTable
          :columns="paymentColumns"
          :data="detail?.payments ?? []"
          :bordered="false"
          :row-key="(row: OrderDetailPayload['payments'][number]) => row.id"
          :pagination="false"
        />
      </NCard>

      <!-- 事件时间线 -->
      <NCard size="small" title="订单动态">
        <NTimeline>
          <NTimelineItem
            v-for="event in detail?.events ?? []"
            :key="event.id"
            :title="orderEventLabel(event.event)"
            :content="`${transitionText(event.fromStatus, event.toStatus)}${event.note ? ` · ${event.note}` : ''}`"
            :time="fmtDate(event.createdAt)"
            :type="event.event === 'finance.reject' || event.event === 'refund.reject' ? 'error' : 'default'"
          />
        </NTimeline>
      </NCard>
    </template>

    <!-- 账期开通 Modal -->
    <NModal
      v-model:show="showCreditModal"
      preset="card"
      title="合同账期开通"
      style="width: 480px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="110">
        <NFormItem label="订单">
          <NText>{{ order?.orderNo }}（应付 ¥{{ formatCents(order?.payableCents ?? null) }}）</NText>
        </NFormItem>
        <NFormItem label="账期天数">
          <NInputNumber v-model:value="creditDueDays" :min="1" :max="3650" :precision="0" style="width: 200px">
            <template #suffix>天</template>
          </NInputNumber>
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3)">
        开通后订单进入服务履行，生成应收账期流水（财务在「收款确认-应收账期」确认到账）；截止日 = 今天 + 账期天数。
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreditModal = false">取消</NButton>
          <NButton type="primary" :loading="openingCredit" @click="handleOpenCredit">开通账期</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

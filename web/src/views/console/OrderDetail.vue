<script setup lang="ts">
// 订单详情（客户侧，任务 14，规格 §6.2/§6.3）：
// - 数据源 orders.get（order.view）：order 标量 + items（快照）+ payments（回单/流水）+ events 时间线；
// - 待支付态展示平台收款账户信息（orders.bankInfo，env PAYMENT_BANK_INFO 未配置时
//   提示联系顾问）+ 订单号复制（转账备注用）；
// - 状态操作矩阵（动作按钮仅 ORG_OWNER 可见——与 order.create 同权限点，数据面后端判）：
//   PENDING_PAYMENT → 在线支付（微信/支付宝二选一 → createPayment 展示 mock payUrl）/
//     上传回单（NUpload 手动模式转 base64 → uploadVoucher）/ 取消（NPopconfirm）；
//   PENDING_CONFIRMATION → 回单预览（/files/{voucherFileKey}）+ 财务确认中标签；
//   FULFILLING/COMPLETED/PARTIALLY_REFUNDED → 申请退款 Modal（原因必填 + 金额
//     默认全额可退；部分退款后可再申请，走 refund.reopen。PAID 不提供入口——
//     refund.request 仅 COMPLETED|FULFILLING 合法，PAID 点击必 CONFLICT）；
//   REFUNDING → 退款审批中标签；其余状态只读；
// - OrderEvent 时间线 NTimeline（事件中文映射 + 状态迁移与备注）。
import { computed, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NForm, NFormItem,
  NInput, NInputNumber, NInputGroup, NModal, NPopconfirm, NRadio, NRadioGroup, NSpace, NTag,
  NText, NTimeline, NTimelineItem, NUpload, useMessage,
} from 'naive-ui'
import type { DataTableColumns, UploadFileInfo } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { fileToBase64 } from '../../utils/file'
import { formatCents } from '../../utils/money'
import { orderEventLabel, orderStatusMeta, paymentMethodLabel } from '../../utils/order'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

/**
 * 详情载荷：与后端 splitOrderDetail 投影的线上形状对齐（JSON 通道下日期为 ISO 字符串，
 * planSnapshot/rawPayload 为 JsonValue——按本地接口声明消费，避开 Prisma Json 递归类型）。
 */
interface OrderDetailPayload {
  order: {
    id: string
    orderNo: string
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

interface BankInfo {
  accountName: string
  accountNo: string
  bankName: string
}

const loading = ref(false)
const detail = ref<OrderDetailPayload | null>(null)
const bankInfo = ref<BankInfo | null>(null)

const orderId = route.params.id as string
const order = computed(() => detail.value?.order ?? null)

// 动作按钮显隐基准：与 order.create 同权限点（ORG_OWNER 通配，MEMBER/VIEWER 恒拒）
const canOperate = computed(() => sessionStore.me?.orgRole === 'ORG_OWNER')

const statusMeta = computed(() => (order.value ? orderStatusMeta(order.value.status) : null))

async function load() {
  loading.value = true
  try {
    detail.value = (await trpc.orders.get.query({ orderId })) as unknown as OrderDetailPayload
    // 待支付态顺带取收款账户信息（未配置时 null，前端提示联系顾问）
    if (detail.value.order.status === 'PENDING_PAYMENT') {
      try {
        bankInfo.value = await trpc.orders.bankInfo.query()
      } catch {
        bankInfo.value = null
      }
    }
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

/** 最新带回单的支付流水（回单预览链接用；payments 已按 createdAt 倒序） */
const voucherPayment = computed(() =>
  detail.value?.payments.find((p) => p.voucherFileKey) ?? null,
)

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制')
  } catch {
    message.error('复制失败，请手动选择复制')
  }
}

// ===== 在线支付（微信/支付宝二选一 → mock payUrl） =====
const showPayModal = ref(false)
const paying = ref(false)
const payMethod = ref<'WECHAT' | 'ALIPAY'>('WECHAT')
const payUrl = ref('')
const channelOrderNo = ref('')

function openPay() {
  payMethod.value = 'WECHAT'
  payUrl.value = ''
  channelOrderNo.value = ''
  showPayModal.value = true
}

async function handlePay() {
  if (!order.value) return
  paying.value = true
  try {
    const result = await trpc.orders.createPayment.mutate({ orderId, method: payMethod.value })
    payUrl.value = result.payUrl
    channelOrderNo.value = result.channelOrderNo
  } catch (e: any) {
    message.error(e?.message || '发起支付失败')
  } finally {
    paying.value = false
  }
}

// ===== 上传回单（NUpload 手动模式 → base64 → uploadVoucher） =====
const voucherFile = ref<File | null>(null)
const uploading = ref(false)
const uploadRef = ref<{ clear: () => void } | null>(null)

function handleVoucherChange({ fileList }: { fileList: UploadFileInfo[] }) {
  const last = fileList[fileList.length - 1]
  voucherFile.value = last?.file ?? null
}

async function handleUploadVoucher() {
  const file = voucherFile.value
  if (!file) {
    message.warning('请先选择回单文件（png/jpg/pdf，≤ 7MB）')
    return
  }
  if (file.size > 7 * 1024 * 1024) {
    message.warning('回单文件不能超过 7MB')
    return
  }
  uploading.value = true
  try {
    const contentBase64 = await fileToBase64(file)
    await trpc.orders.uploadVoucher.mutate({ orderId, fileName: file.name, contentBase64 })
    message.success('回单已上传，等待财务确认收款')
    voucherFile.value = null
    uploadRef.value?.clear()
    await load()
  } catch (e: any) {
    message.error(e?.message || '回单上传失败')
  } finally {
    uploading.value = false
  }
}

// ===== 取消订单 =====
const cancelling = ref(false)

async function handleCancel() {
  cancelling.value = true
  try {
    await trpc.orders.cancel.mutate({ orderId })
    message.success('订单已取消')
    await load()
  } catch (e: any) {
    message.error(e?.message || '取消失败')
  } finally {
    cancelling.value = false
  }
}

// ===== 申请退款（原因必填 + 金额默认全额可退额） =====
const showRefundModal = ref(false)
const refunding = ref(false)
const refundReason = ref('')
/** 退款金额（元）；提交时 ×100 转分 */
const refundAmountYuan = ref<number | null>(null)

/** 全额可退额（分）：payable - 已退 */
const refundableCents = computed(() =>
  order.value ? Math.max(order.value.payableCents - order.value.refundedCents, 0) : 0,
)

function openRefund() {
  refundReason.value = ''
  // 部分退款后再申请（PARTIALLY_REFUNDED → refund.reopen）：金额默认留空——
  // 提交时省略 amountCents，后端取全额可退额（proration 口径可能与前端
  // "应付-已退"不同）；首退（FULFILLING/COMPLETED）保持预填剩余全额
  refundAmountYuan.value =
    order.value?.status === 'PARTIALLY_REFUNDED' ? null : refundableCents.value / 100
  showRefundModal.value = true
}

async function handleRefund() {
  const reason = refundReason.value.trim()
  if (!reason) {
    message.warning('请填写退款原因')
    return
  }
  // 金额留空 → 省略 amountCents（后端缺省=全额可退额，zod optional 语义）
  const entered = refundAmountYuan.value
  const amountCents = entered === null ? null : Math.round(entered * 100)
  if (amountCents !== null && (!Number.isFinite(amountCents) || amountCents < 1)) {
    message.warning('退款金额须为正数（元），留空则按全额可退提交')
    return
  }
  refunding.value = true
  try {
    await trpc.orders.refundRequest.mutate({
      orderId,
      reason,
      ...(amountCents !== null ? { amountCents } : {}),
    })
    message.success('退款申请已提交，等待平台审批')
    showRefundModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '退款申请失败')
  } finally {
    refunding.value = false
  }
}

// ===== 行项表格 =====
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
    width: 140,
    render: (row) => row.workspaceId ?? '—',
  },
]

// ===== 事件时间线（事件中文映射 utils/order 单一来源） =====

/** 状态迁移展示：fromStatus → toStatus（中文标签） */
function transitionText(from: string | null, to: string): string {
  const fromLabel = from ? orderStatusMeta(from).label : '初始'
  return `${fromLabel} → ${orderStatusMeta(to).label}`
}
</script>

<template>
  <div style="max-width: 1080px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="订单详情" :subtitle="order?.orderNo" />
      <NSpace align="center">
        <NTag v-if="statusMeta" size="small" :bordered="false" :type="statusMeta.type">
          {{ statusMeta.label }}
        </NTag>
        <NButton size="small" tertiary @click="router.push({ name: 'console-orders' })">
          返回列表
        </NButton>
      </NSpace>
    </NSpace>

    <NAlert
      v-if="!canOperate && order"
      type="info"
      :bordered="false"
      :closable="false"
      style="margin-bottom: 16px"
    >
      当前为只读视图：支付、回单、取消与退款操作仅企业管理员（ORG_OWNER）可执行。
    </NAlert>

    <NSpace v-if="loading" justify="center" style="margin-top: 96px">
      <NText depth="3">加载中…</NText>
    </NSpace>

    <template v-else-if="order">
      <!-- 待支付：收款账户信息与转账备注（§6.3） -->
      <NCard
        v-if="order.status === 'PENDING_PAYMENT'"
        size="small"
        title="对公转账收款信息"
        style="margin-bottom: 16px"
      >
        <template v-if="bankInfo">
          <NDescriptions :column="3" label-placement="left" size="small">
            <NDescriptionsItem label="户名">{{ bankInfo.accountName }}</NDescriptionsItem>
            <NDescriptionsItem label="账号">{{ bankInfo.accountNo }}</NDescriptionsItem>
            <NDescriptionsItem label="开户行">{{ bankInfo.bankName }}</NDescriptionsItem>
          </NDescriptions>
        </template>
        <NText v-else depth="3" style="font-size: 13px">
          平台未配置收款账户信息，请联系顾问获取收款信息。
        </NText>
        <NSpace align="center" :size="8" style="margin-top: 8px">
          <NText depth="3" style="font-size: 13px">转账请备注订单号：</NText>
          <NInputGroup style="width: 280px">
            <NInput :value="order.orderNo" readonly size="small" />
            <NButton size="small" type="primary" @click="copyText(order.orderNo)">复制</NButton>
          </NInputGroup>
        </NSpace>
      </NCard>

      <!-- 状态信息条：全员可见（财务确认中/退款审批中 + 回单预览） -->
      <NSpace
        v-if="order.status === 'PENDING_CONFIRMATION' || order.status === 'REFUNDING'"
        :size="8"
        style="margin-bottom: 16px"
      >
        <template v-if="order.status === 'PENDING_CONFIRMATION'">
          <NTag type="info" :bordered="false">财务确认中</NTag>
          <NButton
            v-if="voucherPayment?.voucherFileKey"
            size="small"
            tertiary
            tag="a"
            :href="`/files/${voucherPayment.voucherFileKey}`"
            target="_blank"
          >
            预览回单
          </NButton>
        </template>
        <NTag v-else-if="order.status === 'REFUNDING'" type="warning" :bordered="false">
          退款审批中
        </NTag>
      </NSpace>

      <!-- 状态操作（仅 ORG_OWNER：与 order.create 同权限点，数据面后端判） -->
      <NSpace v-if="canOperate" :size="8" style="margin-bottom: 16px">
        <template v-if="order.status === 'PENDING_PAYMENT'">
          <NButton size="small" type="primary" @click="openPay">在线支付</NButton>
          <NUpload
            ref="uploadRef"
            :max="1"
            accept=".png,.jpg,.pdf"
            :default-upload="false"
            :show-file-list="true"
            style="display: inline-block"
            @change="handleVoucherChange"
          >
            <NButton size="small" tertiary>选择回单文件</NButton>
          </NUpload>
          <NButton size="small" type="primary" secondary :loading="uploading" @click="handleUploadVoucher">
            上传回单
          </NButton>
          <NPopconfirm @positive-click="handleCancel">
            <template #trigger>
              <NButton size="small" type="warning" :loading="cancelling">取消订单</NButton>
            </template>
            确认取消该订单？取消后不可恢复。
          </NPopconfirm>
        </template>
        <template v-else-if="['FULFILLING', 'COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.status)">
          <NButton size="small" type="warning" secondary @click="openRefund">
            {{ order.status === 'PARTIALLY_REFUNDED' ? '再次申请退款' : '申请退款' }}
          </NButton>
        </template>
      </NSpace>

      <!-- 订单信息 -->
      <NCard size="small" title="订单信息" style="margin-bottom: 16px">
        <NDescriptions :column="3" label-placement="left" size="small">
          <NDescriptionsItem label="订单号">{{ order.orderNo }}</NDescriptionsItem>
          <NDescriptionsItem label="创建时间">{{ fmtDate(order.createdAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="支付方式">{{ paymentMethodLabel(order.paymentMethod) }}</NDescriptionsItem>
          <NDescriptionsItem label="商品总额">¥{{ formatCents(order.totalCents) }}</NDescriptionsItem>
          <NDescriptionsItem label="优惠金额">¥{{ formatCents(order.discountCents) }}</NDescriptionsItem>
          <NDescriptionsItem label="应付金额">
            <NText strong style="color: var(--primary-color)">¥{{ formatCents(order.payableCents) }}</NText>
          </NDescriptionsItem>
          <NDescriptionsItem label="已退金额">¥{{ formatCents(order.refundedCents) }}</NDescriptionsItem>
          <NDescriptionsItem label="支付时间">{{ fmtDate(order.paidAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="账期截止">{{ fmtDate(order.dueAt) }}</NDescriptionsItem>
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

    <!-- 在线支付 Modal（微信/支付宝二选一） -->
    <NModal
      v-model:show="showPayModal"
      preset="card"
      title="在线支付"
      style="width: 520px"
      :mask-closable="false"
    >
      <NSpace vertical :size="12">
        <NRadioGroup v-model:value="payMethod">
          <NSpace :size="16">
            <NRadio value="WECHAT">微信支付</NRadio>
            <NRadio value="ALIPAY">支付宝</NRadio>
          </NSpace>
        </NRadioGroup>
        <NText depth="3" style="font-size: 12px">
          演示环境为 mock 渠道：发起后生成支付链接，扫码即视为支付成功回调。
        </NText>
        <template v-if="payUrl">
          <NText style="font-size: 13px">
            支付链接已生成（渠道单号 {{ channelOrderNo }}），请复制到手机打开完成支付：
          </NText>
          <NInputGroup>
            <NInput :value="payUrl" readonly />
            <NButton type="primary" @click="copyText(payUrl)">复制</NButton>
          </NInputGroup>
        </template>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showPayModal = false">关闭</NButton>
          <NButton type="primary" :loading="paying" @click="handlePay">
            {{ payUrl ? '重新发起' : '发起支付' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 申请退款 Modal -->
    <NModal
      v-model:show="showRefundModal"
      preset="card"
      title="申请退款"
      style="width: 520px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem label="退款原因" required>
          <NInput
            v-model:value="refundReason"
            type="textarea"
            placeholder="请说明退款原因（必填，500 字内）"
            :maxlength="500"
            show-count
          />
        </NFormItem>
        <NFormItem label="退款金额">
          <NSpace vertical :size="4" style="width: 100%">
            <NInputNumber
              v-model:value="refundAmountYuan"
              :min="0.01"
              :precision="2"
              clearable
              placeholder="留空 = 全额可退"
              style="width: 200px"
            >
              <template #suffix>元</template>
            </NInputNumber>
            <NText depth="3" style="font-size: 12px">
              剩余可退参考 ¥{{ formatCents(refundableCents) }}（应付 - 已退）；
              部分退款后再申请时默认留空，留空提交按平台全额可退额计算。
            </NText>
          </NSpace>
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRefundModal = false">取消</NButton>
          <NButton type="primary" :loading="refunding" @click="handleRefund">提交申请</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

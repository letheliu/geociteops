<script setup lang="ts">
// 退款管理（平台侧，任务 15，refund.manage：FINANCE/SUPER_ADMIN）：
// - 列表 admin.refunds.list：缺省 PENDING（FIFO createdAt asc 工作队列），行带
//   suggestedAmountCents（calcRefundable 同源建议执行金额）前置展示；状态筛选可查
//   EXECUTED/REJECTED 历史；
// - 审批 Modal：执行金额默认建议额、可酌减（前端校验 ≤ 建议额，后端兜底）；
//   线上渠道（微信/支付宝）提交即走渠道退款，线下（转账/账期）为打款后登记；
// - 驳回 Modal：reason 必填，订单回退申请前状态。
import { h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NForm, NFormItem, NInput,
  NInputNumber, NModal, NPopconfirm, NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { formatCents } from '../../utils/money'
import { paymentMethodLabel, refundStatusMeta } from '../../utils/order'

const router = useRouter()
const message = useMessage()

type RefundListResult = Awaited<ReturnType<typeof trpc.admin.refunds.list.query>>
type RefundRow = RefundListResult['items'][number]

const loading = ref(false)
const items = ref<RefundRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const statusFilter = ref<string | null>('PENDING')

const statusOptions: SelectOption[] = [
  { label: '待审批（默认）', value: 'PENDING' },
  { label: '已执行', value: 'EXECUTED' },
  { label: '已驳回', value: 'REJECTED' },
  { label: '全部状态', value: '' },
]

async function load() {
  loading.value = true
  try {
    const result = await trpc.admin.refunds.list.query({
      page: page.value,
      pageSize: pageSize.value,
      ...(statusFilter.value ? { status: statusFilter.value as RefundRow['status'] } : {}),
    })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '退款列表加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function handleSearch() {
  page.value = 1
  load()
}

function handlePageChange(p: number) {
  page.value = p
  load()
}

function handlePageSizeChange(ps: number) {
  pageSize.value = ps
  page.value = 1
  load()
}

function goOrder(row: RefundRow) {
  router.push({ name: 'admin-order-detail', params: { id: row.orderId } })
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

/** 通道性质：线上（微信/支付宝，走渠道退款）/ 线下（转账/账期，打款后登记） */
function isOnlineChannel(row: RefundRow): boolean {
  return row.payment?.method === 'WECHAT' || row.payment?.method === 'ALIPAY'
}

// ===== 审批 Modal（执行金额默认建议额，可酌减） =====
const showApproveModal = ref(false)
const approveRow = ref<RefundRow | null>(null)
const executeYuan = ref<number | null>(null)
const approving = ref(false)

function openApprove(row: RefundRow) {
  approveRow.value = row
  executeYuan.value = row.suggestedAmountCents / 100
  showApproveModal.value = true
}

async function handleApprove() {
  const row = approveRow.value
  if (!row) return
  const executeCents = Math.round((executeYuan.value ?? 0) * 100)
  if (!Number.isFinite(executeCents) || executeCents < 1) {
    message.warning('执行金额须为正数（元）')
    return
  }
  // 前端校验 ≤ 建议额（后端 RefundAmountExceededError 兜底）
  if (executeCents > row.suggestedAmountCents) {
    message.warning(`执行金额不能超过系统建议额 ¥${formatCents(row.suggestedAmountCents)}`)
    return
  }
  approving.value = true
  try {
    await trpc.admin.refunds.approve.mutate({
      refundId: row.id,
      executeAmountCents: executeCents,
    })
    // 全额/部分口径由后端判定（executeAmountCents 与 refundable 比较），前端只报执行金额
    message.success(`退款已执行：¥${formatCents(executeCents)}（配额回收与服务回退由系统处理）`)
    showApproveModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '审批失败')
  } finally {
    approving.value = false
  }
}

// ===== 驳回 Modal（reason 必填） =====
const showRejectModal = ref(false)
const rejectRow = ref<RefundRow | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

function openReject(row: RefundRow) {
  rejectRow.value = row
  rejectReason.value = ''
  showRejectModal.value = true
}

async function handleReject() {
  const row = rejectRow.value
  if (!row) return
  const reason = rejectReason.value.trim()
  if (!reason) {
    message.warning('请填写驳回原因')
    return
  }
  rejecting.value = true
  try {
    await trpc.admin.refunds.reject.mutate({ refundId: row.id, reason })
    message.success('退款申请已驳回，订单回退申请前状态')
    showRejectModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '驳回失败')
  } finally {
    rejecting.value = false
  }
}

const columns: DataTableColumns<RefundRow> = [
  {
    title: '申请时间',
    key: 'createdAt',
    width: 170,
    render: (row) => fmtDate(row.createdAt),
  },
  {
    title: '订单号',
    key: 'orderNo',
    width: 190,
    render: (row) =>
      h(NButton, { text: true, type: 'primary', onClick: () => goOrder(row) }, {
        default: () => row.order?.orderNo ?? row.orderId,
      }),
  },
  {
    title: '申请金额',
    key: 'amountCents',
    width: 110,
    render: (row) => `¥${formatCents(row.amountCents)}`,
  },
  {
    title: '建议金额',
    key: 'suggestedAmountCents',
    width: 110,
    render: (row) =>
      h(NText, { strong: true }, { default: () => `¥${formatCents(row.suggestedAmountCents)}` }),
  },
  {
    title: '原因',
    key: 'reason',
    minWidth: 180,
    ellipsis: { tooltip: true },
    render: (row) => row.reason || '—',
  },
  {
    title: '通道',
    key: 'method',
    width: 130,
    render: (row) => {
      const method = paymentMethodLabel(row.payment?.method)
      return h(NSpace, { size: 6, align: 'center', wrap: false }, {
        default: () => [
          h('span', method),
          h(NTag, { size: 'small', bordered: false, type: isOnlineChannel(row) ? 'info' : 'default' }, {
            default: () => (isOnlineChannel(row) ? '线上' : '线下'),
          }),
        ],
      })
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => {
      const meta = refundStatusMeta(row.status)
      return h(NTag, { size: 'small', bordered: false, type: meta.type }, { default: () => meta.label })
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row) =>
      row.status !== 'PENDING'
        ? '—'
        : h(NSpace, { size: 'small' }, {
            default: () => [
              h(NButton, { size: 'tiny', type: 'primary', onClick: () => openApprove(row) }, {
                default: () => '审批',
              }),
              h(NButton, { size: 'tiny', type: 'warning', onClick: () => openReject(row) }, {
                default: () => '驳回',
              }),
            ],
          }),
  },
]
</script>

<template>
  <div>
    <PageHeader title="退款管理" subtitle="客户退款申请的审批工作台（建议金额 = 系统按可退口径计算）" />

    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <NSelect
        v-model:value="statusFilter"
        :options="statusOptions"
        placeholder="全部状态"
        style="width: 180px"
        @update:value="handleSearch"
      />
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="items"
        :loading="loading"
        :bordered="false"
        :row-key="(row: RefundRow) => row.id"
        :pagination="{
          page,
          pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [10, 20, 50],
          onChange: handlePageChange,
          onUpdatePageSize: handlePageSizeChange,
        }"
        remote
      />
    </NCard>

    <!-- 审批 Modal：执行金额默认建议额、可酌减 -->
    <NModal
      v-model:show="showApproveModal"
      preset="card"
      title="退款审批"
      style="width: 520px"
      :mask-closable="false"
    >
      <NDescriptions v-if="approveRow" :column="2" label-placement="left" size="small" style="margin-bottom: 12px">
        <NDescriptionsItem label="订单号">{{ approveRow.order?.orderNo }}</NDescriptionsItem>
        <NDescriptionsItem label="申请金额">¥{{ formatCents(approveRow.amountCents) }}</NDescriptionsItem>
        <NDescriptionsItem label="系统建议额">¥{{ formatCents(approveRow.suggestedAmountCents) }}</NDescriptionsItem>
        <NDescriptionsItem label="原支付通道">{{ paymentMethodLabel(approveRow.payment?.method) }}</NDescriptionsItem>
      </NDescriptions>
      <NForm label-placement="left" label-width="110">
        <NFormItem label="执行金额" required>
          <NSpace vertical :size="4">
            <NInputNumber v-model:value="executeYuan" :min="0.01" :precision="2" style="width: 200px">
              <template #suffix>元</template>
            </NInputNumber>
            <NText depth="3" style="font-size: 12px">
              默认取系统建议额（当前可退总额），可在上限内酌减：执行金额等于建议额即全额退款，低于建议额则为部分退款。
            </NText>
          </NSpace>
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3)">
        {{
          approveRow && isOnlineChannel(approveRow)
            ? '线上渠道（微信/支付宝）：提交后自动发起渠道退款。'
            : '线下通道（对公转账/合同账期）：请先完成打款，再在此登记执行。'
        }}
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showApproveModal = false">取消</NButton>
          <NPopconfirm @positive-click="handleApprove">
            <template #trigger>
              <NButton type="primary" :loading="approving">确认执行</NButton>
            </template>
            确认按 ¥{{ formatCents(Math.round((executeYuan ?? 0) * 100)) }} 执行退款？提交后不可撤销。
          </NPopconfirm>
        </NSpace>
      </template>
    </NModal>

    <!-- 驳回 Modal（reason 必填） -->
    <NModal
      v-model:show="showRejectModal"
      preset="card"
      title="驳回退款申请"
      style="width: 480px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem label="订单">
          <NText>{{ rejectRow?.order?.orderNo }}（申请 ¥{{ formatCents(rejectRow?.amountCents ?? null) }}）</NText>
        </NFormItem>
        <NFormItem label="驳回原因" required>
          <NInput
            v-model:value="rejectReason"
            type="textarea"
            placeholder="将通知客户（如不符合退款条件 / 超出可退期限），200 字内"
            :maxlength="200"
            show-count
          />
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3)">
        驳回后订单回退申请前状态，客户可修正后再次申请。
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRejectModal = false">取消</NButton>
          <NButton type="warning" :loading="rejecting" @click="handleReject">确认驳回</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

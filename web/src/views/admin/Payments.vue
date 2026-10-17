<script setup lang="ts">
// 收款确认（平台侧，任务 15，payment.confirm：FINANCE/SUPER_ADMIN；菜单按权限隐藏）：
// - Tab VOUCHER 待确认回单：对公转账回单（BANK_TRANSFER/PENDING）列表——回单图片
//   预览（/files/{voucherFileKey}，GET 会话鉴权）+ 确认（NPopconfirm → confirm）
//   + 驳回（Modal reason 必填 → reject，订单回退待支付）；
// - Tab CREDIT 应收账期：合同账期应收（CONTRACT_CREDIT/PENDING）列表——dueAt 倒期
//   展示（剩余天数 / 已逾期）+ 确认到账（confirm：订单维持履行态，不触发重开）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NForm, NFormItem, NInput, NModal, NPopconfirm,
  NSpace, NTabs, NTabPane, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { formatCents } from '../../utils/money'
import { paymentMethodLabel } from '../../utils/order'

const router = useRouter()
const message = useMessage()

type PaymentListResult = Awaited<ReturnType<typeof trpc.admin.payments.list.query>>
type PaymentRow = PaymentListResult['items'][number]

const loading = ref(false)
const items = ref<PaymentRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const view = ref<'VOUCHER' | 'CREDIT'>('VOUCHER')

async function load() {
  loading.value = true
  try {
    const result = await trpc.admin.payments.list.query({
      view: view.value,
      page: page.value,
      pageSize: pageSize.value,
    })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '收款列表加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function handleTabChange() {
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

function goOrder(row: PaymentRow) {
  router.push({ name: 'admin-order-detail', params: { id: row.orderId } })
}

/** 账期倒期：剩余天数（负数 = 已逾期 N 天） */
function dueInDays(row: PaymentRow): number | null {
  if (!row.order?.dueAt) return null
  const diff = new Date(row.order.dueAt).getTime() - Date.now()
  return Math.ceil(diff / 86_400_000)
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

// ===== 确认收款 / 到账（VOUCHER 与 CREDIT 共用 confirm 端点） =====
const confirmingId = ref<string | null>(null)

async function handleConfirm(row: PaymentRow) {
  confirmingId.value = row.id
  try {
    await trpc.admin.payments.confirm.mutate({ paymentId: row.id })
    message.success(view.value === 'CREDIT' ? '应收已确认到账' : '回单已确认收款，服务开通处理中')
    await load()
  } catch (e: any) {
    message.error(e?.message || '确认失败')
  } finally {
    confirmingId.value = null
  }
}

// ===== 驳回回单（reason 必填，订单回退待支付） =====
const showRejectModal = ref(false)
const rejectRow = ref<PaymentRow | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

function openReject(row: PaymentRow) {
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
    await trpc.admin.payments.reject.mutate({ paymentId: row.id, reason })
    message.success('回单已驳回，订单回退待支付')
    showRejectModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '驳回失败')
  } finally {
    rejecting.value = false
  }
}

const voucherColumns: DataTableColumns<PaymentRow> = [
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
    title: '金额',
    key: 'amountCents',
    width: 120,
    render: (row) => `¥${formatCents(row.amountCents)}`,
  },
  { title: '通道', key: 'method', width: 100, render: (row) => paymentMethodLabel(row.method) },
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
    title: '提交时间',
    key: 'createdAt',
    width: 170,
    render: (row) => fmtDate(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 170,
    render: (row) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          h(NPopconfirm, { onPositiveClick: () => handleConfirm(row) }, {
            trigger: () =>
              h(NButton, { size: 'tiny', type: 'primary', loading: confirmingId.value === row.id }, {
                default: () => '确认收款',
              }),
            default: () => `确认已收到 ¥${formatCents(row.amountCents)}？确认后订单进入服务开通。`,
          }),
          h(NButton, { size: 'tiny', type: 'warning', onClick: () => openReject(row) }, {
            default: () => '驳回',
          }),
        ],
      }),
  },
]

const creditColumns: DataTableColumns<PaymentRow> = [
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
    title: '应收金额',
    key: 'amountCents',
    width: 120,
    render: (row) => `¥${formatCents(row.amountCents)}`,
  },
  {
    title: '开通时间',
    key: 'createdAt',
    width: 170,
    render: (row) => fmtDate(row.createdAt),
  },
  {
    title: '账期截止',
    key: 'dueAt',
    width: 220,
    render: (row) => {
      const days = dueInDays(row)
      const dueAt = fmtDate(row.order?.dueAt ?? null)
      if (days === null) return dueAt
      const tag =
        days < 0
          ? h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => `已逾期 ${-days} 天` })
          : h(NTag, { size: 'small', type: days <= 7 ? 'warning' : 'info', bordered: false }, {
              default: () => `剩余 ${days} 天`,
            })
      return h(NSpace, { size: 8, align: 'center', wrap: false }, {
        default: () => [h('span', dueAt), tag],
      })
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 130,
    render: (row) =>
      h(NPopconfirm, { onPositiveClick: () => handleConfirm(row) }, {
        trigger: () =>
          h(NButton, { size: 'tiny', type: 'primary', loading: confirmingId.value === row.id }, {
            default: () => '确认到账',
          }),
        default: () => `确认已收到 ¥${formatCents(row.amountCents)}？确认后应收流水结清。`,
      }),
  },
]

const columns = computed(() => (view.value === 'CREDIT' ? creditColumns : voucherColumns))
</script>

<template>
  <div>
    <PageHeader title="收款确认" subtitle="对公转账回单审核与合同账期应收跟进" />

    <NCard>
      <NTabs
        :value="view"
        type="line"
        @update:value="(v: string | number) => { view = v as 'VOUCHER' | 'CREDIT'; handleTabChange() }"
      >
        <NTabPane name="VOUCHER" tab="待确认回单">
          <NDataTable
            :columns="columns"
            :data="items"
            :loading="loading"
            :bordered="false"
            :row-key="(row: PaymentRow) => row.id"
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
          <NText depth="3" style="font-size: 12px">
            客户上传对公转账回单后在此审核；驳回需填原因（订单回退待支付，客户可重新上传）。
          </NText>
        </NTabPane>
        <NTabPane name="CREDIT" tab="应收账期">
          <NDataTable
            :columns="columns"
            :data="items"
            :loading="loading"
            :bordered="false"
            :row-key="(row: PaymentRow) => row.id"
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
          <NText depth="3" style="font-size: 12px">
            运营开通的合同账期应收流水；确认到账不改变订单履行状态，仅结清应收。
          </NText>
        </NTabPane>
      </NTabs>
    </NCard>

    <!-- 驳回回单 Modal（reason 必填） -->
    <NModal
      v-model:show="showRejectModal"
      preset="card"
      title="驳回回单"
      style="width: 480px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem label="订单">
          <NText>{{ rejectRow?.order?.orderNo }}（¥{{ formatCents(rejectRow?.amountCents ?? null) }}）</NText>
        </NFormItem>
        <NFormItem label="驳回原因" required>
          <NInput
            v-model:value="rejectReason"
            type="textarea"
            placeholder="将展示给客户（如金额不符 / 凭证模糊），200 字内"
            :maxlength="200"
            show-count
          />
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3)">
        驳回后订单回退待支付，客户可在订单详情重新上传回单或改用其他支付方式。
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

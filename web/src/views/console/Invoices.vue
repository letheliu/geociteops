<script setup lang="ts">
// 发票管理（客户侧，任务 14，规格 §6.3）：
// - 列表：org.invoices.list（任意客户角色可申请可看——开票为通用财务诉求），
//   状态 NTag（PENDING 待开具 / ISSUED 已开具 / REJECTED 已驳回）、金额（分→元）、
//   发票号、已开具且含文件时下载链接（/files/{fileKey}）；
// - 申请 Modal：勾选已支付订单（orders.list 过滤 paidAt 非空，NCheckboxGroup，
//   展示订单号 + 应付金额）→ org.invoices.request({ orderIds })（1-50 单合并开票）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NCheckbox, NCheckboxGroup, NDataTable, NModal, NSpace, NSpin,
  NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { formatCents } from '../../utils/money'

const message = useMessage()
const sessionStore = useSessionStore()

/**
 * 遗留 E7：申请开票按钮按 orgRole 守卫——开票申请本身是 orgProcedure()，但
 * 选订单需拉 orders.list（order.view）：ORG_VIEWER 权限点恒空集，点了只会
 * 报错 toast，故隐藏；OWNER/MEMBER 有 order.view 保留。
 */
const canRequestInvoice = computed(() => {
  const role = sessionStore.me?.orgRole
  return role === 'ORG_OWNER' || role === 'ORG_MEMBER'
})

/**
 * 发票行：与后端 toInvoiceListItem 投影的线上形状对齐。直接 Awaited<ReturnType<...>>
 * 推导 org.invoices.list 会因 orderIds/titleSnapshot 的 Prisma JsonValue 递归类型触发
 * TS2589（同 Credentials.vue 的做法），故本地声明（orderIds 消费处做安全转换）。
 */
interface InvoiceRow {
  id: string
  orderIds: unknown
  amountCents: number
  currency: string
  status: 'PENDING' | 'ISSUED' | 'REJECTED'
  invoiceNo: string | null
  fileKey: string | null
  remark: string | null
  createdAt: string
  updatedAt: string
}
/** 订单行：orders.list item（name 快照可空）；本地声明同上（规避 planSnapshot Json 递归） */
interface OrderRow {
  id: string
  orderNo: string
  status: string
  payableCents: number
  paidAt: string | null
}

const loading = ref(false)
const items = ref<InvoiceRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const INVOICE_STATUS_META: Record<string, { type: 'warning' | 'success' | 'error'; label: string }> = {
  PENDING: { type: 'warning', label: '待开具' },
  ISSUED: { type: 'success', label: '已开具' },
  REJECTED: { type: 'error', label: '已驳回' },
}

function statusMeta(status: string) {
  return INVOICE_STATUS_META[status] ?? { type: 'warning' as const, label: status }
}

async function load() {
  loading.value = true
  try {
    const result = await trpc.org.invoices.list.query({ page: page.value, pageSize: pageSize.value })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '发票列表加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

/** orderIds（Json 通道）安全转 string[] */
function orderIdList(row: InvoiceRow): string[] {
  const raw = row.orderIds as unknown
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

const columns: DataTableColumns<InvoiceRow> = [
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => {
      const meta = statusMeta(row.status)
      return h(NTag, { size: 'small', bordered: false, type: meta.type }, { default: () => meta.label })
    },
  },
  {
    title: '金额',
    key: 'amountCents',
    width: 110,
    render: (row) => `¥${formatCents(row.amountCents)}`,
  },
  {
    title: '关联订单',
    key: 'orderIds',
    minWidth: 200,
    render: (row) => {
      const ids = orderIdList(row)
      return ids.length > 0 ? `${ids.length} 笔（合并开票）` : '—'
    },
  },
  {
    title: '发票号',
    key: 'invoiceNo',
    width: 170,
    render: (row) => row.invoiceNo ?? '—',
  },
  {
    title: '备注',
    key: 'remark',
    minWidth: 160,
    render: (row) => row.remark ?? '—',
  },
  {
    title: '申请时间',
    key: 'createdAt',
    width: 170,
    render: (row) => fmtDate(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 90,
    render: (row) =>
      row.fileKey
        ? h(
            NButton,
            { size: 'tiny', tag: 'a', href: `/files/${row.fileKey}`, target: '_blank', tertiary: true },
            { default: () => '下载' },
          )
        : '—',
  },
]

function handlePageChange(next: number) {
  page.value = next
  load()
}

// ===== 申请开票（勾选已支付订单） =====
const showRequest = ref(false)
const requesting = ref(false)
const paidOrders = ref<OrderRow[]>([])
const selectedOrderIds = ref<string[]>([])
// 订单拉取加载态（遗留 D2）：Modal 打开到 orders.list 返回期间显示加载中，
// 不闪"暂无可开票"空态
const ordersLoading = ref(false)

async function openRequest() {
  selectedOrderIds.value = []
  paidOrders.value = []
  showRequest.value = true
  ordersLoading.value = true
  try {
    // 已支付订单数据源：orders.list 过滤 paidAt 非空（take 100 简化，超量后续再分页）
    const result = await trpc.orders.list.query({ page: 1, pageSize: 100 })
    paidOrders.value = result.items.filter((row) => row.paidAt !== null)
  } catch (e: any) {
    message.error(e?.message || '订单加载失败')
  } finally {
    ordersLoading.value = false
  }
}

async function handleRequest() {
  if (selectedOrderIds.value.length === 0) {
    message.warning('请至少勾选一笔已支付订单')
    return
  }
  requesting.value = true
  try {
    await trpc.org.invoices.request.mutate({ orderIds: selectedOrderIds.value })
    message.success('开票申请已提交，等待财务开具')
    showRequest.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '开票申请失败')
  } finally {
    requesting.value = false
  }
}
</script>

<template>
  <div style="max-width: 1200px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="发票管理" subtitle="已支付订单的开票申请与发票下载" />
      <!-- 遗留 E7：VIEWER 无 order.view，申请入口隐藏（列表/下载仍可见） -->
      <NButton v-if="canRequestInvoice" type="primary" @click="openRequest">+ 申请开票</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="items"
        :loading="loading"
        :bordered="false"
        :row-key="(row: InvoiceRow) => row.id"
        :pagination="{
          page,
          pageSize,
          itemCount: total,
          onChange: handlePageChange,
          showSizePicker: false,
        }"
      />
    </NCard>

    <!-- 申请开票 Modal（勾选已支付订单，合并开票上限 50 笔） -->
    <NModal
      v-model:show="showRequest"
      preset="card"
      title="申请开票"
      style="width: 560px"
      :mask-closable="false"
    >
      <!-- 加载态先行（遗留 D2）：拉取期间转圈，仅在拉取完成且无已支付订单时空态 -->
      <NSpace v-if="ordersLoading" justify="center" style="padding: 24px 0">
        <NSpin size="small" />
      </NSpace>
      <NAlert
        v-else-if="paidOrders.length === 0"
        type="info"
        :bordered="false"
        :closable="false"
      >
        暂无可开票的已支付订单——完成支付后即可在此申请。
      </NAlert>
      <template v-else>
        <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 12px">
          勾选需合并开票的已支付订单（1-50 笔），发票将按企业抬头开具。
        </NText>
        <NCheckboxGroup v-model:value="selectedOrderIds">
          <NSpace vertical :size="8">
            <NCheckbox v-for="order in paidOrders" :key="order.id" :value="order.id">
              {{ order.orderNo }} · ¥{{ formatCents(order.payableCents) }}
            </NCheckbox>
          </NSpace>
        </NCheckboxGroup>
      </template>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRequest = false">取消</NButton>
          <NButton
            type="primary"
            :loading="requesting"
            :disabled="selectedOrderIds.length === 0"
            @click="handleRequest"
          >
            提交申请（{{ selectedOrderIds.length }} 笔）
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<script setup lang="ts">
// 我的订单（客户侧，任务 14，规格 §6.2）：
// - 数据源 orders.list（order.view：MEMBER 可看本企业订单，VIEWER 由后端恒拒）——
//   ORG_VIEWER 直接输 URL 进入时不调接口，仅空态提示（遗留 D1）；
// - 表格列：订单号/创建时间/商品摘要（行项快照名 × 数量）/应付金额/状态 9 态 NTag/
//   支付方式/操作（查看详情）；
// - 远端分页（page/pageSize → total）；金额分→元（money.formatCents）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NEmpty, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { formatCents } from '../../utils/money'
import { orderStatusMeta, paymentMethodLabel } from '../../utils/order'

const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

// ORG_VIEWER：order.view 恒拒——不调接口，页面只渲染空态（避免报错 toast）
const isOrgViewer = computed(() => sessionStore.isOrgViewer)

type OrderRow = Awaited<ReturnType<typeof trpc.orders.list.query>>['items'][number]

const loading = ref(false)
const items = ref<OrderRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

async function load() {
  // VIEWER 空态短路：后端 order.view 恒拒，调接口只会得到报错 toast
  if (isOrgViewer.value) return
  loading.value = true
  try {
    const result = await trpc.orders.list.query({ page: page.value, pageSize: pageSize.value })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '订单列表加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 行项摘要："专业版 ×1 · 加购包 ×2"（快照名缺失回退 planId） */
function itemsSummary(row: OrderRow): string {
  if (row.items.length === 0) return '—'
  return row.items
    .map((item) => `${item.name ?? item.planId} ×${item.quantity}`)
    .join(' · ')
}

const columns: DataTableColumns<OrderRow> = [
  {
    title: '订单号',
    key: 'orderNo',
    width: 190,
    render: (row) =>
      h(NButton, { text: true, type: 'primary', onClick: () => goDetail(row) }, {
        default: () => row.orderNo,
      }),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 170,
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    title: '商品',
    key: 'items',
    minWidth: 220,
    render: itemsSummary,
  },
  {
    title: '应付金额',
    key: 'payableCents',
    width: 110,
    render: (row) => `¥${formatCents(row.payableCents)}`,
  },
  {
    title: '状态',
    key: 'status',
    width: 110,
    render: (row) => {
      const meta = orderStatusMeta(row.status)
      return h(NTag, { size: 'small', bordered: false, type: meta.type }, { default: () => meta.label })
    },
  },
  {
    title: '支付方式',
    key: 'paymentMethod',
    width: 100,
    render: (row) => paymentMethodLabel(row.paymentMethod),
  },
  {
    title: '操作',
    key: 'actions',
    width: 90,
    render: (row) =>
      h(NButton, { size: 'tiny', onClick: () => goDetail(row) }, { default: () => '详情' }),
  },
]

function goDetail(row: OrderRow) {
  router.push({ name: 'console-order-detail', params: { id: row.id } })
}

function handlePageChange(next: number) {
  page.value = next
  load()
}
</script>

<template>
  <div style="max-width: 1200px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="我的订单" subtitle="本企业全部订单与支付进度" />
      <NButton
        v-if="!isOrgViewer"
        tertiary
        size="small"
        @click="router.push({ name: 'console-services' })"
      >
        去商城下单
      </NButton>
    </NSpace>

    <!-- 只读账号空态（遗留 D1）：不调接口不渲染表格 -->
    <NCard v-if="isOrgViewer">
      <NEmpty description="只读账号无订单访问权限——如需查看或下单，请联系企业管理员调整角色。" />
    </NCard>

    <NCard v-else>
      <NDataTable
        :columns="columns"
        :data="items"
        :loading="loading"
        :bordered="false"
        :row-key="(row: OrderRow) => row.id"
        :pagination="{
          page,
          pageSize,
          itemCount: total,
          onChange: handlePageChange,
          showSizePicker: false,
        }"
      />
      <NText depth="3" style="font-size: 12px">
        待支付订单请在详情页完成在线支付或对公转账回单上传；退款与开票入口均在订单详情。
      </NText>
    </NCard>
  </div>
</template>

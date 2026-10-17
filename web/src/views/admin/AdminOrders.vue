<script setup lang="ts">
// 订单中心（平台侧，任务 15）：
// - 列表 admin.orders.list（order.view：OPERATOR/FINANCE/SUPER_ADMIN/SUPPORT 可见）：
//   状态 9 态 NSelect / organizationId 手输 / orderNo 模糊（q）筛选 + 远端分页；
// - 写操作（order.manage：OPERATOR/SUPER_ADMIN）按角色隐藏——代客下单 Modal
//   （organizationId 必填 + items 动态行 planId/quantity/workspaceId + discountCents
//   可选改价：填了改价时 remark 必填前端校验）、取消（NPopconfirm）、
//   账期开通 Modal（dueDays 1..3650）；FINANCE/SUPPORT 只读（数据面后端判）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputNumber, NModal,
  NPopconfirm, NSelect, NSpace, NTag, NText, NTooltip, useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { formatCents } from '../../utils/money'
import { ORDER_STATUS_META, orderStatusMeta, paymentMethodLabel } from '../../utils/order'

const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

type OrderListResult = Awaited<ReturnType<typeof trpc.admin.orders.list.query>>
type OrderRow = OrderListResult['items'][number]

/** order.manage（OPERATOR/SUPER_ADMIN）：写操作可见性；FINANCE/SUPPORT 只读 */
const canManage = computed(() =>
  sessionStore.me?.platformRole === 'OPERATOR' || sessionStore.me?.platformRole === 'SUPER_ADMIN',
)

const loading = ref(false)
const items = ref<OrderRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const statusFilter = ref<string | null>(null)
const orgFilter = ref('')
const qFilter = ref('')

const statusOptions: SelectOption[] = [
  { label: '全部状态', value: '' },
  ...Object.entries(ORDER_STATUS_META).map(([value, meta]) => ({ label: meta.label, value })),
]

async function load() {
  loading.value = true
  try {
    const result = await trpc.admin.orders.list.query({
      page: page.value,
      pageSize: pageSize.value,
      ...(statusFilter.value ? { status: statusFilter.value as OrderRow['status'] } : {}),
      ...(orgFilter.value.trim() ? { organizationId: orgFilter.value.trim() } : {}),
      ...(qFilter.value.trim() ? { q: qFilter.value.trim() } : {}),
    })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '订单列表加载失败')
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

function goDetail(row: OrderRow) {
  router.push({ name: 'admin-order-detail', params: { id: row.id } })
}

function itemsSummary(row: OrderRow): string {
  if (row.items.length === 0) return '—'
  return row.items.map((item) => `${item.name ?? item.planId} ×${item.quantity}`).join(' · ')
}

// ===== 取消 / 账期开通（行操作，仅 PENDING_PAYMENT 态有迁移路径） =====
async function handleCancel(row: OrderRow) {
  try {
    await trpc.admin.orders.cancel.mutate({ orderId: row.id })
    message.success(`订单 ${row.orderNo} 已取消`)
    await load()
  } catch (e: any) {
    message.error(e?.message || '取消失败')
  }
}

const showCreditModal = ref(false)
const creditRow = ref<OrderRow | null>(null)
const creditDueDays = ref<number | null>(30)
const openingCredit = ref(false)

function openCredit(row: OrderRow) {
  creditRow.value = row
  creditDueDays.value = 30
  showCreditModal.value = true
}

async function handleOpenCredit() {
  const row = creditRow.value
  if (!row) return
  const dueDays = creditDueDays.value
  if (!dueDays || !Number.isInteger(dueDays) || dueDays < 1 || dueDays > 3650) {
    message.warning('账期天数须为 1-3650 的整数')
    return
  }
  openingCredit.value = true
  try {
    const result = await trpc.admin.orders.openOnCredit.mutate({ orderId: row.id, dueDays })
    message.success(
      `账期已开通：${row.orderNo}，截止 ${new Date(result.dueAt).toLocaleDateString('zh-CN')}`,
    )
    showCreditModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '账期开通失败')
  } finally {
    openingCredit.value = false
  }
}

// ===== 代客下单 Modal =====
interface DraftItem {
  planId: string | null
  quantity: number
  workspaceId: string
}

const showCreate = ref(false)
const creating = ref(false)
const createOrgId = ref('')
const draftItems = ref<DraftItem[]>([{ planId: null, quantity: 1, workspaceId: '' }])
const discountYuan = ref<number | null>(null)
const createRemark = ref('')

/** 套餐下拉（catalog.list：在售套餐全量；NSelect tag 模式可手输 planId 兜底） */
const planOptions = ref<SelectOption[]>([])
/** planId → 商品 kind（终审 C1：SUBSCRIPTION/SERVICE 行数量锁 1 的前端判据） */
const planKindById = ref<Record<string, string>>({})
let planOptionsLoaded = false

async function ensurePlanOptions() {
  if (planOptionsLoaded) return
  try {
    const result = await trpc.catalog.list.query()
    planOptions.value = result.items.flatMap((product) =>
      product.plans.map((plan) => ({
        label: `${plan.name} · ${product.name}（¥${formatCents(plan.priceCents)}）`,
        value: plan.id,
      })),
    )
    for (const product of result.items) {
      for (const plan of product.plans) planKindById.value[plan.id] = product.kind
    }
    planOptionsLoaded = true
  } catch (e: any) {
    message.error(e?.message || '目录加载失败，可直接粘贴 planId')
  }
}

/**
 * 数量锁定（终审 C1）：SUBSCRIPTION/SERVICE 行 quantity 恒为 1——数量倍乘交付
 * 仅 ADDON 支持（后端 create 同校验拒单）。手输 planId（未知 kind）不锁，
 * 由后端校验兜底。
 */
function quantityLocked(row: DraftItem): boolean {
  const kind = row.planId ? planKindById.value[row.planId] : undefined
  return kind === 'SUBSCRIPTION' || kind === 'SERVICE'
}

/** 套餐选择变更：切到锁定类商品时数量归 1（防 ADDON 调过量后换行残留） */
function onPlanChange(row: DraftItem, planId: string | null) {
  row.planId = planId
  if (planId && planKindById.value[planId] !== 'ADDON') row.quantity = 1
}

function openCreate() {
  createOrgId.value = ''
  draftItems.value = [{ planId: null, quantity: 1, workspaceId: '' }]
  discountYuan.value = null
  createRemark.value = ''
  showCreate.value = true
  void ensurePlanOptions()
}

function addDraftItem() {
  draftItems.value.push({ planId: null, quantity: 1, workspaceId: '' })
}

function removeDraftItem(index: number) {
  draftItems.value.splice(index, 1)
}

async function handleCreate() {
  const organizationId = createOrgId.value.trim()
  if (!organizationId) {
    message.warning('请填写企业 ID（organizationId）')
    return
  }
  const rows = draftItems.value
  if (rows.length === 0) {
    message.warning('请至少添加一行商品')
    return
  }
  if (rows.some((r) => !r.planId)) {
    message.warning('每行商品都需选择套餐（或粘贴 planId）')
    return
  }
  if (rows.some((r) => !Number.isInteger(r.quantity) || r.quantity < 1)) {
    message.warning('数量须为 ≥1 的整数')
    return
  }
  const discountCents = Math.round((discountYuan.value ?? 0) * 100)
  const remark = createRemark.value.trim()
  // 改价联动备注：与后端 service 校验同语义（discountCents>0 → remark 必填）
  if (discountCents > 0 && !remark) {
    message.warning('填写改价（优惠金额）时必须填写下单备注（改价原因）')
    return
  }
  creating.value = true
  try {
    const result = await trpc.admin.orders.create.mutate({
      organizationId,
      items: rows.map((r) => ({
        planId: r.planId as string,
        // SUBSCRIPTION/SERVICE 恒 1（终审 C1，与后端校验同语义；未知 kind 不强改）
        quantity: quantityLocked(r) ? 1 : r.quantity,
        ...(r.workspaceId.trim() ? { workspaceId: r.workspaceId.trim() } : {}),
      })),
      ...(discountCents > 0 ? { discountCents } : {}),
      ...(remark ? { remark } : {}),
    })
    message.success(`代客下单成功：${result.order.orderNo}（应付 ¥${formatCents(result.order.payableCents)}）`)
    showCreate.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '下单失败')
  } finally {
    creating.value = false
  }
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
    title: '企业',
    key: 'organizationId',
    width: 160,
    ellipsis: { tooltip: true },
    render: (row) => row.organizationId,
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
    minWidth: 200,
    ellipsis: { tooltip: true },
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
    width: canManage.value ? 220 : 90,
    render: (row) => {
      const buttons = [
        h(NButton, { size: 'tiny', onClick: () => goDetail(row) }, { default: () => '详情' }),
      ]
      if (canManage.value && row.status === 'PENDING_PAYMENT') {
        buttons.push(
          h(NPopconfirm, { onPositiveClick: () => handleCancel(row) }, {
            trigger: () => h(NButton, { size: 'tiny', type: 'warning' }, { default: () => '取消' }),
            default: () => `确认取消订单 ${row.orderNo}？取消后不可恢复。`,
          }),
          h(NButton, { size: 'tiny', type: 'primary', secondary: true, onClick: () => openCredit(row) }, {
            default: () => '账期开通',
          }),
        )
      }
      return h(NSpace, { size: 'small' }, { default: () => buttons })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="订单中心" subtitle="全企业订单视图：代客下单、账期开通与状态跟踪" />

    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <NSpace :size="8">
        <NSelect
          v-model:value="statusFilter"
          :options="statusOptions"
          placeholder="全部状态"
          style="width: 150px"
          @update:value="handleSearch"
        />
        <NInput
          v-model:value="orgFilter"
          clearable
          placeholder="organizationId（留空 = 全部）"
          style="width: 240px"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        />
        <NInput
          v-model:value="qFilter"
          clearable
          placeholder="订单号（模糊）"
          style="width: 200px"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        />
        <NButton secondary @click="handleSearch">筛选</NButton>
      </NSpace>
      <NButton v-if="canManage" type="primary" @click="openCreate">+ 代客下单</NButton>
    </NSpace>

    <NAlert
      v-if="!canManage"
      type="info"
      :bordered="false"
      :closable="false"
      style="margin-bottom: 16px"
    >
      当前为只读视图：代客下单、取消与账期开通仅运营（OPERATOR）与超级管理员可执行。
    </NAlert>

    <NCard>
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
          showSizePicker: true,
          pageSizes: [10, 20, 50],
          onChange: handlePageChange,
          onUpdatePageSize: handlePageSizeChange,
        }"
        remote
      />
    </NCard>

    <!-- 账期开通 Modal（PENDING_PAYMENT → FULFILLING，先开通后收款） -->
    <NModal
      v-model:show="showCreditModal"
      preset="card"
      title="合同账期开通"
      style="width: 480px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="110">
        <NFormItem label="订单">
          <NText>{{ creditRow?.orderNo }}（应付 ¥{{ formatCents(creditRow?.payableCents ?? null) }}）</NText>
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

    <!-- 代客下单 Modal -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      title="代客下单"
      style="width: 720px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="110">
        <NFormItem label="企业 ID" required>
          <NInput v-model:value="createOrgId" placeholder="organizationId（必填）" />
        </NFormItem>
        <NFormItem label="商品明细" required>
          <NSpace vertical :size="8" style="width: 100%">
            <NSpace v-for="(row, index) in draftItems" :key="index" :size="8" :wrap="false" align="center">
              <NSelect
                :value="row.planId"
                :options="planOptions"
                filterable
                tag
                clearable
                placeholder="选择套餐（可粘贴 planId）"
                style="width: 300px"
                @update:value="(v: string | null) => onPlanChange(row, v)"
              />
              <NTooltip :disabled="!quantityLocked(row)">
                <template #trigger>
                  <NInputNumber
                    v-model:value="row.quantity"
                    :min="1"
                    :precision="0"
                    :disabled="quantityLocked(row)"
                    style="width: 100px"
                  />
                </template>
                订阅/服务类商品单笔一件（数量倍乘仅加购包支持）
              </NTooltip>
              <NInput v-model:value="row.workspaceId" placeholder="workspaceId（可选）" style="width: 180px" />
              <NButton
                size="small"
                type="error"
                quaternary
                :disabled="draftItems.length <= 1"
                @click="removeDraftItem(index)"
              >
                删除
              </NButton>
            </NSpace>
            <NButton size="small" dashed style="width: 120px" @click="addDraftItem">+ 添加商品</NButton>
          </NSpace>
        </NFormItem>
        <NFormItem label="改价（优惠）">
          <NSpace vertical :size="4">
            <NInputNumber v-model:value="discountYuan" :min="0" :precision="2" style="width: 200px">
              <template #suffix>元</template>
            </NInputNumber>
            <NText depth="3" style="font-size: 12px">
              可选；填写改价时必须填写下单备注（改价原因）。
            </NText>
          </NSpace>
        </NFormItem>
        <NFormItem label="下单备注">
          <NInput
            v-model:value="createRemark"
            type="textarea"
            placeholder="商务备注 / 改价原因（改价时必填，500 字内）"
            :maxlength="500"
            show-count
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="handleCreate">提交订单</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

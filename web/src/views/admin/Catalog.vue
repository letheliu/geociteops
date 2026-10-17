<script setup lang="ts">
// 服务目录管理（平台侧，任务 15）：产品与套餐的增改与上下架——仅 SUPER_ADMIN
// （catalog.manage 权限点经 '*' 通配，其余平台角色恒拒；入口菜单同权限隐藏）。
// - 数据源 admin.catalog.product.list（catalog.manage）：后台全量目录（含 inactive
//   产品与 plans 的 AdminView 投影），下架条目刷新后仍可见、可重新上架；
//   增改/上下架以 admin.catalog.* 返回的 admin 投影就地合并。
// - 产品：code/kind 创建后不可变（后端 update 不接受）；套餐：价格（元↔分）、
//   计费周期（null=一次性）、entitlements 以 JSON 文本编辑（提交前 JSON.parse
//   校验，须为 JSON 对象）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputNumber, NModal,
  NPopconfirm, NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { formatCents } from '../../utils/money'

type ProductKindValue = 'SUBSCRIPTION' | 'SERVICE' | 'ADDON'
type BillingPeriodValue = 'MONTH' | 'YEAR'

/** 本页统一行形状（catalog.list 种子 + admin 变更返回投影就地合并） */
interface AdminPlan {
  id: string
  productId: string
  name: string
  priceCents: number
  billingPeriod: BillingPeriodValue | null
  entitlements: unknown
  deliverables: unknown
  active: boolean
}
interface AdminProduct {
  id: string
  code: string
  name: string
  kind: ProductKindValue
  description: string
  active: boolean
  plans: AdminPlan[]
}

const message = useMessage()
const sessionStore = useSessionStore()

const isSuperAdmin = computed(() => sessionStore.me?.platformRole === 'SUPER_ADMIN')

const loading = ref(false)
const products = ref<AdminProduct[]>([])

const KIND_LABEL: Record<string, string> = {
  SUBSCRIPTION: '套餐订阅',
  SERVICE: '单项服务',
  ADDON: '加购包',
}

const PERIOD_LABEL: Record<string, string> = {
  MONTH: '/ 月',
  YEAR: '/ 年',
}

function periodLabel(period: BillingPeriodValue | null): string {
  return period ? (PERIOD_LABEL[period] ?? period) : '一次性'
}

/** entitlements JSON 摘要（表格列展示，完整内容在编辑 Modal 内） */
function entitlementsSummary(entitlements: unknown): string {
  const text = JSON.stringify(entitlements)
  return text && text !== '{}' && text !== 'null' ? text : '—'
}

async function load() {
  loading.value = true
  try {
    // 后台全量目录（含 inactive）：下架条目可见可再上架（任务 15 审查修复）
    const result = await trpc.admin.catalog.product.list.query()
    products.value = result.items as unknown as AdminProduct[]
  } catch (e: any) {
    message.error(e?.message || '目录加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isSuperAdmin.value) load()
})

/** admin 变更返回的产品投影就地合并（存在替换、不存在前插） */
function mergeProduct(view: AdminProduct) {
  const idx = products.value.findIndex((p) => p.id === view.id)
  if (idx >= 0) products.value.splice(idx, 1, view)
  else products.value.unshift(view)
}

function mergePlan(productId: string, view: AdminPlan) {
  const product = products.value.find((p) => p.id === productId)
  if (!product) return
  const idx = product.plans.findIndex((p) => p.id === view.id)
  if (idx >= 0) product.plans.splice(idx, 1, view)
  else product.plans.push(view)
}

// ===== 产品 新建/编辑 =====
const showProductModal = ref(false)
const productSaving = ref(false)
const productEditing = ref<AdminProduct | null>(null)
const productForm = ref({
  code: '',
  name: '',
  kind: 'SUBSCRIPTION' as ProductKindValue,
  description: '',
})

const kindOptions: SelectOption[] = (['SUBSCRIPTION', 'SERVICE', 'ADDON'] as ProductKindValue[]).map(
  (kind) => ({ label: KIND_LABEL[kind], value: kind }),
)

function openProductCreate() {
  productEditing.value = null
  productForm.value = { code: '', name: '', kind: 'SUBSCRIPTION', description: '' }
  showProductModal.value = true
}

function openProductEdit(row: AdminProduct) {
  productEditing.value = row
  productForm.value = {
    code: row.code,
    name: row.name,
    kind: row.kind,
    description: row.description,
  }
  showProductModal.value = true
}

async function handleProductSubmit() {
  const f = productForm.value
  if (!f.name.trim()) {
    message.warning('请填写商品名称')
    return
  }
  if (!productEditing.value && !f.code.trim()) {
    message.warning('请填写商品 code（创建后不可修改）')
    return
  }
  productSaving.value = true
  try {
    if (productEditing.value) {
      const view = (await trpc.admin.catalog.product.update.mutate({
        productId: productEditing.value.id,
        name: f.name.trim(),
        description: f.description,
      })) as unknown as AdminProduct
      mergeProduct(view)
      message.success('商品已更新')
    } else {
      const view = (await trpc.admin.catalog.product.create.mutate({
        code: f.code.trim(),
        name: f.name.trim(),
        kind: f.kind,
        description: f.description,
      })) as unknown as AdminProduct
      mergeProduct(view)
      message.success('商品已创建，请继续添加套餐')
    }
    showProductModal.value = false
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    productSaving.value = false
  }
}

async function handleProductToggle(row: AdminProduct, active: boolean) {
  try {
    const view = (await trpc.admin.catalog.product.setActive.mutate({
      productId: row.id,
      active,
    })) as unknown as AdminProduct
    mergeProduct(view)
    message.success(active ? '商品已上架' : '商品已下架（商城不再展示，存量订单不受影响）')
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

// ===== 套餐 新建/编辑（entitlements JSON 文本编辑） =====
const showPlanModal = ref(false)
const planSaving = ref(false)
const planProduct = ref<AdminProduct | null>(null)
const planEditing = ref<AdminPlan | null>(null)
const planForm = ref({
  name: '',
  priceYuan: null as number | null,
  billingPeriod: null as BillingPeriodValue | null,
  entitlementsText: '{}',
})

const periodOptions: SelectOption[] = [
  { label: '一次性（无周期）', value: '' },
  { label: '按月', value: 'MONTH' },
  { label: '按年', value: 'YEAR' },
]

/** NSelect 空串占位一次性；提交时 null → 不传（创建）/ 显式 null（更新=清除） */
function handlePeriodSelect(value: string | number | null) {
  planForm.value.billingPeriod = value ? (value as BillingPeriodValue) : null
}

function openPlanCreate(product: AdminProduct) {
  planProduct.value = product
  planEditing.value = null
  planForm.value = { name: '', priceYuan: null, billingPeriod: null, entitlementsText: '{}' }
  showPlanModal.value = true
}

function openPlanEdit(product: AdminProduct, plan: AdminPlan) {
  planProduct.value = product
  planEditing.value = plan
  planForm.value = {
    name: plan.name,
    priceYuan: plan.priceCents / 100,
    billingPeriod: plan.billingPeriod,
    entitlementsText: JSON.stringify(plan.entitlements ?? {}, null, 2),
  }
  showPlanModal.value = true
}

/** entitlements 文本 → JSON 对象；非法（非 JSON / 非对象）时返回 null */
function parseEntitlements(): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(planForm.value.entitlementsText.trim() || '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function handlePlanSubmit() {
  const product = planProduct.value
  if (!product) return
  const f = planForm.value
  if (!f.name.trim()) {
    message.warning('请填写套餐名称')
    return
  }
  const priceCents = Math.round((f.priceYuan ?? -1) * 100)
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    message.warning('价格须为非负金额（元）')
    return
  }
  const entitlements = parseEntitlements()
  if (!entitlements) {
    message.warning('entitlements 须为合法 JSON 对象（如 {"maxQueries": 100}，空为 {}）')
    return
  }
  planSaving.value = true
  try {
    if (planEditing.value) {
      const view = (await trpc.admin.catalog.plan.update.mutate({
        planId: planEditing.value.id,
        name: f.name.trim(),
        priceCents,
        // null = 清除（转一次性）
        billingPeriod: f.billingPeriod,
        entitlements,
      })) as unknown as AdminPlan
      mergePlan(product.id, view)
      message.success('套餐已更新')
    } else {
      const view = (await trpc.admin.catalog.plan.create.mutate({
        productId: product.id,
        name: f.name.trim(),
        priceCents,
        ...(f.billingPeriod ? { billingPeriod: f.billingPeriod } : {}),
        entitlements,
      })) as unknown as AdminPlan
      mergePlan(product.id, view)
      message.success('套餐已创建')
    }
    showPlanModal.value = false
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    planSaving.value = false
  }
}

async function handlePlanToggle(product: AdminProduct, plan: AdminPlan, active: boolean) {
  try {
    const view = (await trpc.admin.catalog.plan.setActive.mutate({
      planId: plan.id,
      active,
    })) as unknown as AdminPlan
    mergePlan(product.id, view)
    message.success(active ? '套餐已上架' : '套餐已下架（商城不再展示，存量订单不受影响）')
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

// ===== 套餐表格（产品行展开内嵌） =====
const planColumns: DataTableColumns<AdminPlan> = [
  { title: '套餐', key: 'name', minWidth: 140 },
  {
    title: '价格',
    key: 'priceCents',
    width: 130,
    render: (row) => `¥${formatCents(row.priceCents)}${row.billingPeriod ? PERIOD_LABEL[row.billingPeriod] ?? '' : ''}`,
  },
  { title: '计费周期', key: 'billingPeriod', width: 100, render: (row) => periodLabel(row.billingPeriod) },
  {
    title: 'entitlements',
    key: 'entitlements',
    minWidth: 220,
    ellipsis: { tooltip: true },
    render: (row) => entitlementsSummary(row.entitlements),
  },
  {
    title: '状态',
    key: 'active',
    width: 90,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: row.active ? 'success' : 'default' }, {
        default: () => (row.active ? '在售' : '已下架'),
      }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render: (row) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, { size: 'tiny', onClick: () => openPlanEdit(productOf(row), row) }, {
            default: () => '编辑',
          }),
          row.active
            ? h(NPopconfirm, { onPositiveClick: () => handlePlanToggle(productOf(row), row, false) }, {
                trigger: () => h(NButton, { size: 'tiny', type: 'warning' }, { default: () => '下架' }),
                default: () => '确认下架该套餐？商城将不再展示。',
              })
            : h(NButton, { size: 'tiny', type: 'success', onClick: () => handlePlanToggle(productOf(row), row, true) }, {
                default: () => '上架',
              }),
        ],
      }),
  },
]

// renderExpand 闭包拿不到当前产品行的便捷引用：经 plan.productId 反查所属产品
function productOf(plan: AdminPlan): AdminProduct {
  return (
    products.value.find((p) => p.id === plan.productId) ?? {
      id: plan.productId,
      code: '',
      name: '',
      kind: 'SERVICE',
      description: '',
      active: false,
      plans: [],
    }
  )
}

const productColumns: DataTableColumns<AdminProduct> = [
  {
    type: 'expand',
    renderExpand: (row) =>
      h('div', { style: { padding: '4px 0 8px' } }, [
        h(NSpace, { justify: 'space-between', align: 'center', style: { 'margin-bottom': '8px' } }, {
          default: () => [
            h(NText, { depth: '3', style: 'font-size: 12px' }, {
              default: () => `套餐（${row.plans.length}）——价格 / 周期 / entitlements 配额声明`,
            }),
            h(NButton, { size: 'tiny', type: 'primary', onClick: () => openPlanCreate(row) }, {
              default: () => '+ 新建套餐',
            }),
          ],
        }),
        h(NDataTable, {
          columns: planColumns,
          data: row.plans,
          bordered: false,
          size: 'small',
          rowKey: (plan: AdminPlan) => plan.id,
          pagination: false,
        }),
      ]),
  },
  { title: 'code', key: 'code', width: 140 },
  { title: '商品', key: 'name', minWidth: 140 },
  {
    title: '类型',
    key: 'kind',
    width: 110,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: 'info' }, { default: () => KIND_LABEL[row.kind] ?? row.kind }),
  },
  {
    title: '描述',
    key: 'description',
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => row.description || '—',
  },
  {
    title: '状态',
    key: 'active',
    width: 90,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: row.active ? 'success' : 'default' }, {
        default: () => (row.active ? '在售' : '已下架'),
      }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render: (row) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, { size: 'tiny', onClick: () => openProductEdit(row) }, { default: () => '编辑' }),
          row.active
            ? h(NPopconfirm, { onPositiveClick: () => handleProductToggle(row, false) }, {
                trigger: () => h(NButton, { size: 'tiny', type: 'warning' }, { default: () => '下架' }),
                default: () => '确认下架该商品？商城将不再展示其全部套餐。',
              })
            : h(NButton, { size: 'tiny', type: 'success', onClick: () => handleProductToggle(row, true) }, {
                default: () => '上架',
              }),
        ],
      }),
  },
]
</script>

<template>
  <div>
    <PageHeader title="服务目录" subtitle="商品与套餐管理、上下架控制（仅超级管理员）" />

    <NAlert v-if="!isSuperAdmin" type="error" :bordered="false" :closable="false">
      服务目录管理仅超级管理员（SUPER_ADMIN）可访问（catalog.manage 权限点）。
    </NAlert>

    <template v-else>
      <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
        <NText depth="3" style="font-size: 12px">
          全量目录（含已下架条目）：下架后商城不再展示，可随时重新上架；code/kind 创建后不可修改。
        </NText>
        <NButton type="primary" @click="openProductCreate">+ 新建商品</NButton>
      </NSpace>

      <NCard>
        <NDataTable
          :columns="productColumns"
          :data="products"
          :loading="loading"
          :bordered="false"
          :row-key="(row: AdminProduct) => row.id"
          :pagination="false"
        />
      </NCard>
    </template>

    <!-- 产品 新建/编辑（code/kind 创建后不可变） -->
    <NModal
      v-model:show="showProductModal"
      preset="card"
      :title="productEditing ? '编辑商品' : '新建商品'"
      style="width: 520px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem label="code">
          <NInput
            v-model:value="productForm.code"
            :disabled="!!productEditing"
            placeholder="对外业务键，创建后不可修改（如 geo-pro）"
          />
        </NFormItem>
        <NFormItem label="名称">
          <NInput v-model:value="productForm.name" placeholder="商品名称" />
        </NFormItem>
        <NFormItem label="类型">
          <NSelect v-model:value="productForm.kind" :options="kindOptions" :disabled="!!productEditing" />
        </NFormItem>
        <NFormItem label="描述">
          <NInput
            v-model:value="productForm.description"
            type="textarea"
            placeholder="商城展示用描述（可空）"
            :maxlength="2000"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showProductModal = false">取消</NButton>
          <NButton type="primary" :loading="productSaving" @click="handleProductSubmit">
            {{ productEditing ? '保存' : '创建' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 套餐 新建/编辑（entitlements JSON 文本编辑） -->
    <NModal
      v-model:show="showPlanModal"
      preset="card"
      :title="planEditing ? '编辑套餐' : '新建套餐'"
      style="width: 560px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="110">
        <NFormItem label="所属商品">
          <NText>{{ planProduct?.name }}（{{ planProduct?.code }}）</NText>
        </NFormItem>
        <NFormItem label="套餐名称">
          <NInput v-model:value="planForm.name" placeholder="如 专业版 / 诊断加购包" />
        </NFormItem>
        <NFormItem label="价格">
          <NInputNumber v-model:value="planForm.priceYuan" :min="0" :precision="2" style="width: 200px">
            <template #suffix>元</template>
          </NInputNumber>
        </NFormItem>
        <NFormItem label="计费周期">
          <NSelect
            :value="planForm.billingPeriod ?? ''"
            :options="periodOptions"
            style="width: 200px"
            @update:value="handlePeriodSelect"
          />
        </NFormItem>
        <NFormItem label="entitlements">
          <NInput
            v-model:value="planForm.entitlementsText"
            type="textarea"
            :rows="5"
            placeholder='配额声明 JSON 对象，如 {"maxWorkspaces": 3, "maxQueries": 1000}'
          />
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3)">
        entitlements 须为 JSON 对象（商城配额展示与配额扣减的依据）；提交前会做 JSON.parse 校验。
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showPlanModal = false">取消</NButton>
          <NButton type="primary" :loading="planSaving" @click="handlePlanSubmit">
            {{ planEditing ? '保存' : '创建' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

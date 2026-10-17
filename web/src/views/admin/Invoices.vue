<script setup lang="ts">
// 发票管理（平台侧，任务 15，invoice.manage：FINANCE/SUPER_ADMIN）：
// - 列表 admin.invoices.list：全企业（状态筛选，缺省 PENDING 待开具），
//   已开具且含文件时下载（/files/{fileKey}）；
// - 登记 Modal：发票号（必填，全局唯一）+ PDF 上传（NUpload 手动模式 → base64，
//   ≤7MB，后端白名单 pdf/png/jpg）→ issue；
// - 驳回 Modal：reason 必填（remark=reason，通知客户重新申请）。
import { h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NForm, NFormItem, NInput, NModal, NSelect, NSpace,
  NTag, NText, NUpload, useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption, UploadFileInfo } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { fileToBase64 } from '../../utils/file'
import { formatCents } from '../../utils/money'
import { invoiceStatusMeta } from '../../utils/order'

const message = useMessage()

/**
 * 发票行：与后端 toInvoiceListItem 投影的线上形状对齐（本地声明规避
 * orderIds/titleSnapshot 的 Prisma Json 递归类型 TS2589，同 console/Invoices 做法）。
 */
interface InvoiceRow {
  id: string
  organizationId: string
  orderIds: unknown
  titleSnapshot: unknown
  amountCents: number
  currency: string
  status: 'PENDING' | 'ISSUED' | 'REJECTED'
  invoiceNo: string | null
  fileKey: string | null
  fileUrl: string | null
  remark: string | null
  createdAt: string
  updatedAt: string
}

const loading = ref(false)
const items = ref<InvoiceRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const statusFilter = ref<string | null>('PENDING')

const statusOptions: SelectOption[] = [
  { label: '待开具（默认）', value: 'PENDING' },
  { label: '已开具', value: 'ISSUED' },
  { label: '已驳回', value: 'REJECTED' },
  { label: '全部状态', value: '' },
]

async function load() {
  loading.value = true
  try {
    const result = (await trpc.admin.invoices.list.query({
      page: page.value,
      pageSize: pageSize.value,
      ...(statusFilter.value ? { status: statusFilter.value as InvoiceRow['status'] } : {}),
    })) as unknown as { items: InvoiceRow[]; total: number }
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '发票列表加载失败')
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

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

/** orderIds（Json 通道）安全转 string[] */
function orderIdList(row: InvoiceRow): string[] {
  const raw = row.orderIds as unknown
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** 开票抬头摘要：billingProfile 快照常见键容错提取 */
function titleSummary(snapshot: unknown): string {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const record = snapshot as Record<string, unknown>
    for (const key of ['name', 'title', 'companyName']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return '—'
}

/** 登记 Modal 内展示的合并开票订单笔数 */
function issueOrderCount(): number {
  return issueRow.value ? orderIdList(issueRow.value).length : 0
}

// ===== 登记（签发）Modal：发票号 + 可选 PDF 上传 =====
const showIssueModal = ref(false)
const issueRow = ref<InvoiceRow | null>(null)
const issueNo = ref('')
const issueFile = ref<File | null>(null)
const issuing = ref(false)
const uploadRef = ref<{ clear: () => void } | null>(null)

function handleIssueFileChange({ fileList }: { fileList: UploadFileInfo[] }) {
  const last = fileList[fileList.length - 1]
  issueFile.value = last?.file ?? null
}

function openIssue(row: InvoiceRow) {
  issueRow.value = row
  issueNo.value = ''
  issueFile.value = null
  // 遗留 D2：打开时清空 NUpload 文件列表——取消/登记成功后重开 Modal，
  // 旧文件不再显示（issueFile 状态与上传组件的展示列表必须同步清理）
  uploadRef.value?.clear()
  showIssueModal.value = true
}

async function handleIssue() {
  const row = issueRow.value
  if (!row) return
  const invoiceNo = issueNo.value.trim()
  if (!invoiceNo) {
    message.warning('请填写发票号')
    return
  }
  const file = issueFile.value
  if (file && file.size > 7 * 1024 * 1024) {
    message.warning('发票文件不能超过 7MB')
    return
  }
  issuing.value = true
  try {
    await trpc.admin.invoices.issue.mutate({
      invoiceId: row.id,
      invoiceNo,
      ...(file ? { fileName: file.name, contentBase64: await fileToBase64(file) } : {}),
    })
    message.success('发票已登记开具，客户侧可下载')
    showIssueModal.value = false
    uploadRef.value?.clear()
    await load()
  } catch (e: any) {
    message.error(e?.message || '登记失败')
  } finally {
    issuing.value = false
  }
}

// ===== 驳回 Modal（reason 必填） =====
const showRejectModal = ref(false)
const rejectRow = ref<InvoiceRow | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

function openReject(row: InvoiceRow) {
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
    await trpc.admin.invoices.reject.mutate({ invoiceId: row.id, reason })
    message.success('开票申请已驳回')
    showRejectModal.value = false
    await load()
  } catch (e: any) {
    message.error(e?.message || '驳回失败')
  } finally {
    rejecting.value = false
  }
}

const columns: DataTableColumns<InvoiceRow> = [
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => {
      const meta = invoiceStatusMeta(row.status)
      return h(NTag, { size: 'small', bordered: false, type: meta.type }, { default: () => meta.label })
    },
  },
  {
    title: '企业',
    key: 'organizationId',
    width: 150,
    ellipsis: { tooltip: true },
    render: (row) => row.organizationId,
  },
  {
    title: '开票抬头',
    key: 'titleSnapshot',
    minWidth: 150,
    ellipsis: { tooltip: true },
    render: (row) => titleSummary(row.titleSnapshot),
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
    width: 110,
    render: (row) => {
      const ids = orderIdList(row)
      return ids.length > 0 ? `${ids.length} 笔（合并）` : '—'
    },
  },
  {
    title: '发票号',
    key: 'invoiceNo',
    width: 160,
    render: (row) => row.invoiceNo ?? '—',
  },
  {
    title: '备注',
    key: 'remark',
    minWidth: 140,
    ellipsis: { tooltip: true },
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
    width: 170,
    render: (row) => {
      if (row.status === 'PENDING') {
        return h(NSpace, { size: 'small' }, {
          default: () => [
            h(NButton, { size: 'tiny', type: 'primary', onClick: () => openIssue(row) }, {
              default: () => '登记',
            }),
            h(NButton, { size: 'tiny', type: 'warning', onClick: () => openReject(row) }, {
              default: () => '驳回',
            }),
          ],
        })
      }
      if (row.status === 'ISSUED' && row.fileUrl) {
        return h(
          NButton,
          { size: 'tiny', tertiary: true, tag: 'a', href: row.fileUrl, target: '_blank' },
          { default: () => '下载' },
        )
      }
      return '—'
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="发票管理" subtitle="客户开票申请的登记（发票号 + PDF）与驳回" />

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
        :row-key="(row: InvoiceRow) => row.id"
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

    <!-- 登记签发 Modal：发票号 + 可选 PDF -->
    <NModal
      v-model:show="showIssueModal"
      preset="card"
      title="登记签发"
      style="width: 520px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem label="申请">
          <NText>
            {{ titleSummary(issueRow?.titleSnapshot ?? null) }} · ¥{{ formatCents(issueRow?.amountCents ?? null) }}
            · {{ issueOrderCount() }} 笔订单
          </NText>
        </NFormItem>
        <NFormItem label="发票号" required>
          <NInput v-model:value="issueNo" placeholder="全局唯一（≤64 字符）" :maxlength="64" />
        </NFormItem>
        <NFormItem label="发票 PDF">
          <NSpace vertical :size="4" style="width: 100%">
            <NUpload
              ref="uploadRef"
              :max="1"
              accept=".pdf,.png,.jpg"
              :default-upload="false"
              :show-file-list="true"
              @change="handleIssueFileChange"
            >
              <NButton size="small" tertiary>选择发票文件</NButton>
            </NUpload>
            <NText depth="3" style="font-size: 12px">
              可选；pdf/png/jpg，≤7MB，登记后客户侧可下载。
            </NText>
          </NSpace>
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showIssueModal = false">取消</NButton>
          <NButton type="primary" :loading="issuing" @click="handleIssue">登记开具</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 驳回 Modal（reason 必填） -->
    <NModal
      v-model:show="showRejectModal"
      preset="card"
      title="驳回开票申请"
      style="width: 480px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem label="申请">
          <NText>¥{{ formatCents(rejectRow?.amountCents ?? null) }} · {{ rejectRow?.organizationId }}</NText>
        </NFormItem>
        <NFormItem label="驳回原因" required>
          <NInput
            v-model:value="rejectReason"
            type="textarea"
            placeholder="将作为备注展示给客户（如抬头信息不全），200 字内"
            :maxlength="200"
            show-count
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRejectModal = false">取消</NButton>
          <NButton type="warning" :loading="rejecting" @click="handleReject">确认驳回</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

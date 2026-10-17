<script setup lang="ts">
// Workspace 管理（平台侧）：
// - 列表：admin.workspace.list（分页 + 状态/关键字筛选）；列表项不含 platformSummary
//   （后端仅 Workspace 全字段投影），凭证概况进详情页查看；
// - 新建：组织二选一（已有组织 NSelect 搜索 / 新建企业 NSwitch 切 NInput），
//   成功后展示一次性 API Key（仅此一次，关闭不可再查）；
// - 操作：进入（enterWorkspace 显式传参跳 dashboard）、详情、暂停/恢复/归档（NPopconfirm）。
import { computed, h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputGroup, NModal, NPopconfirm,
  NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { enterWorkspace } from '../../utils/enter-workspace'
import { router } from '../../router'

const message = useMessage()

type WorkspaceListResult = Awaited<ReturnType<typeof trpc.admin.workspace.list.query>>
type WorkspaceRow = WorkspaceListResult['items'][number]

const loading = ref(false)
const items = ref<WorkspaceRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const statusFilter = ref<string | null>(null)
const keyword = ref('')

const statusOptions = [
  { label: 'ACTIVE', value: 'ACTIVE' },
  { label: 'SUSPENDED', value: 'SUSPENDED' },
  { label: 'ARCHIVED', value: 'ARCHIVED' },
]

const STATUS_TAG: Record<string, { type: 'success' | 'warning' | 'default'; label: string }> = {
  ACTIVE: { type: 'success', label: 'ACTIVE' },
  SUSPENDED: { type: 'warning', label: 'SUSPENDED' },
  ARCHIVED: { type: 'default', label: 'ARCHIVED' },
}

async function load() {
  loading.value = true
  try {
    const result = await trpc.admin.workspace.list.query({
      page: page.value,
      pageSize: pageSize.value,
      ...(statusFilter.value ? { status: statusFilter.value as WorkspaceRow['status'] } : {}),
      ...(keyword.value.trim() ? { q: keyword.value.trim() } : {}),
    })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '加载失败')
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

/** 列表数据里出现过的组织（后端无独立组织列表端点，P0 以此为下拉来源） */
const orgOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const row of items.value) seen.set(row.organization.id, row.organization.name)
  return Array.from(seen, ([value, label]) => ({ label, value }))
})

async function handleEnter(row: WorkspaceRow) {
  try {
    await enterWorkspace(row.id)
  } catch (e: any) {
    message.error(e?.message || '进入失败')
  }
}

async function handleSuspend(row: WorkspaceRow) {
  try {
    await trpc.admin.workspace.suspend.mutate({ workspaceId: row.id })
    message.success('已暂停')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

async function handleResume(row: WorkspaceRow) {
  try {
    await trpc.admin.workspace.resume.mutate({ workspaceId: row.id })
    message.success('已恢复')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

async function handleArchive(row: WorkspaceRow) {
  try {
    await trpc.admin.workspace.archive.mutate({ workspaceId: row.id })
    message.success('已归档')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

const columns: DataTableColumns<WorkspaceRow> = [
  {
    title: '名称',
    key: 'name',
    minWidth: 180,
    render(row) {
      return h(
        NButton,
        { text: true, type: 'primary', onClick: () => router.push({ name: 'admin-workspace-detail', params: { id: row.id } }) },
        { default: () => row.name },
      )
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render(row) {
      const meta = STATUS_TAG[row.status] ?? { type: 'default' as const, label: row.status }
      return h(NTag, { size: 'small', type: meta.type, bordered: false }, { default: () => meta.label })
    },
  },
  { title: '所属企业', key: 'organization', minWidth: 140, render: (row) => row.organization?.name ?? '—' },
  { title: '域名', key: 'domain', minWidth: 160, ellipsis: { tooltip: true }, render: (row) => row.domain || '—' },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 170,
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 300,
    render(row) {
      const buttons = [
        h(
          NButton,
          { size: 'tiny', type: 'primary', disabled: row.status !== 'ACTIVE', onClick: () => handleEnter(row) },
          { default: () => '进入' },
        ),
        h(
          NButton,
          { size: 'tiny', onClick: () => router.push({ name: 'admin-workspace-detail', params: { id: row.id } }) },
          { default: () => '详情' },
        ),
      ]
      if (row.status === 'ACTIVE') {
        buttons.push(
          h(NPopconfirm, { onPositiveClick: () => handleSuspend(row) }, {
            trigger: () => h(NButton, { size: 'tiny', type: 'warning' }, { default: () => '暂停' }),
            default: () => '确认暂停该 Workspace？暂停后客户侧不可用。',
          }),
        )
      }
      if (row.status === 'SUSPENDED') {
        buttons.push(
          h(NButton, { size: 'tiny', type: 'success', onClick: () => handleResume(row) }, { default: () => '恢复' }),
        )
      }
      if (row.status !== 'ARCHIVED') {
        buttons.push(
          h(NPopconfirm, { onPositiveClick: () => handleArchive(row) }, {
            trigger: () => h(NButton, { size: 'tiny', type: 'error' }, { default: () => '归档' }),
            default: () => '确认归档？归档后不可恢复。',
          }),
        )
      }
      return h(NSpace, { size: 'small' }, { default: () => buttons })
    },
  },
]

// ===== 新建 Workspace =====
const showModal = ref(false)
const creating = ref(false)
const createNewOrg = ref(false)
const createForm = ref({
  organizationId: null as string | null,
  newOrganizationName: '',
  name: '',
  defaultBrandName: '',
  domain: '',
})
/** 创建成功后的一次性 API Key（仅展示一次，关闭即清空） */
const issuedKey = ref<string | null>(null)

function openCreate() {
  createNewOrg.value = orgOptions.value.length === 0
  createForm.value = { organizationId: null, newOrganizationName: '', name: '', defaultBrandName: '', domain: '' }
  issuedKey.value = null
  showModal.value = true
}

async function handleCreate() {
  const f = createForm.value
  if (!f.name.trim() || !f.defaultBrandName.trim()) {
    message.warning('请填写名称与默认品牌名')
    return
  }
  if (createNewOrg.value) {
    if (!f.newOrganizationName.trim()) {
      message.warning('请填写新企业名称')
      return
    }
  } else if (!f.organizationId) {
    message.warning('请选择所属企业')
    return
  }
  creating.value = true
  try {
    const result = await trpc.admin.workspace.create.mutate({
      name: f.name.trim(),
      defaultBrandName: f.defaultBrandName.trim(),
      ...(f.domain.trim() ? { domain: f.domain.trim() } : {}),
      ...(createNewOrg.value
        ? { newOrganizationName: f.newOrganizationName.trim() }
        : { organizationId: f.organizationId! }),
    })
    issuedKey.value = result.apiKey
    message.success('Workspace 已创建')
    await load()
  } catch (e: any) {
    message.error(e?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

function handleCloseCreate() {
  // 关闭即清空一次性 Key：此后任何入口都无法再取回明文
  issuedKey.value = null
  showModal.value = false
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制')
  } catch {
    message.error('复制失败，请手动选择复制')
  }
}
</script>

<template>
  <div>
    <PageHeader title="Workspace 管理" subtitle="客户工作区的开通、状态与凭证管理" />

    <NSpace justify="space-between" style="margin-bottom: 16px">
      <NSpace>
        <NSelect
          v-model:value="statusFilter"
          :options="statusOptions"
          clearable
          placeholder="状态"
          style="width: 150px"
          @update:value="handleSearch"
        />
        <NInput
          v-model:value="keyword"
          clearable
          placeholder="名称 / 域名关键字"
          style="width: 220px"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        />
        <NButton @click="handleSearch">查询</NButton>
      </NSpace>
      <NButton type="primary" @click="openCreate">+ 新建 Workspace</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="items"
        :loading="loading"
        :bordered="false"
        :row-key="(row: WorkspaceRow) => row.id"
        :pagination="{
          page: page,
          pageSize: pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [10, 20, 50],
          onChange: handlePageChange,
          onUpdatePageSize: handlePageSizeChange,
        }"
        remote
      />
    </NCard>

    <NModal
      :show="showModal"
      preset="card"
      :title="issuedKey ? 'Workspace 已创建' : '新建 Workspace'"
      style="width: 560px"
      :mask-closable="false"
      @update:show="(v: boolean) => { if (!v) handleCloseCreate() }"
    >
      <!-- 成功态：一次性 API Key -->
      <NSpace v-if="issuedKey" vertical :size="12">
        <NText type="warning" style="font-size: 13px">
          初始 API Key 仅此一次展示，关闭后不可再查看，请立即复制并妥善保管。
        </NText>
        <NInputGroup>
          <NInput :value="issuedKey" readonly />
          <NButton type="primary" @click="copyText(issuedKey)">复制</NButton>
        </NInputGroup>
      </NSpace>

      <!-- 表单态 -->
      <NForm v-else label-placement="left" label-width="110">
        <NFormItem label="新建企业">
          <NSpace align="center" :size="8">
            <NSwitch v-model:value="createNewOrg" size="small" />
            <NText depth="3" style="font-size: 12px">
              {{ createNewOrg ? '输入新企业名称' : '从已有企业中选择' }}
            </NText>
          </NSpace>
        </NFormItem>
        <NFormItem v-if="createNewOrg" label="企业名称">
          <NInput v-model:value="createForm.newOrganizationName" placeholder="新企业全称" />
        </NFormItem>
        <NFormItem v-else label="所属企业">
          <NSelect
            v-model:value="createForm.organizationId"
            :options="orgOptions"
            filterable
            placeholder="搜索选择企业（仅列出当前列表中出现的组织）"
          />
        </NFormItem>
        <NFormItem label="名称">
          <NInput v-model:value="createForm.name" placeholder="Workspace 名称" />
        </NFormItem>
        <NFormItem label="默认品牌名">
          <NInput v-model:value="createForm.defaultBrandName" placeholder="引用归属展示用的品牌名" />
        </NFormItem>
        <NFormItem label="域名（可选）">
          <NInput v-model:value="createForm.domain" placeholder="example.com" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <template v-if="issuedKey">
            <NButton type="primary" @click="handleCloseCreate">我已保存，关闭</NButton>
          </template>
          <template v-else>
            <NButton @click="handleCloseCreate">取消</NButton>
            <NButton type="primary" :loading="creating" @click="handleCreate">创建</NButton>
          </template>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

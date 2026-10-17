<script setup lang="ts">
// 审计日志（平台侧）：admin.audit.list 分页表格 + action 筛选。
import { h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NInput, NSelect, NSpace, NTag, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()

type AuditListResult = Awaited<ReturnType<typeof trpc.admin.audit.list.query>>
type AuditRow = AuditListResult['items'][number]

const loading = ref(false)
const items = ref<AuditRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const actionFilter = ref<string | null>(null)
const workspaceFilter = ref('')

/** 已知 action 值（服务端 audit.record 的调用点全集；NSelect tag 模式可自由输入其他值） */
const actionOptions = [
  'auth.login',
  'auth.logout',
  'auth.change_password',
  'workspace.create',
  'workspace.update',
  'workspace.suspend',
  'workspace.resume',
  'workspace.archive',
  'workspace.transfer',
  'workspace.set_credentials',
  'workspace.set_competitors',
  'workspace.enter',
  'user.create',
  'user.reset_password',
  'user.set_status',
].map((a) => ({ label: a, value: a }))

async function load() {
  loading.value = true
  try {
    const result = await trpc.admin.audit.list.query({
      page: page.value,
      pageSize: pageSize.value,
      ...(actionFilter.value ? { action: actionFilter.value } : {}),
      ...(workspaceFilter.value.trim() ? { workspaceId: workspaceFilter.value.trim() } : {}),
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

const columns: DataTableColumns<AuditRow> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 180,
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    title: 'action',
    key: 'action',
    width: 200,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: 'info' }, { default: () => row.action }),
  },
  { title: 'actorType', key: 'actorType', width: 100 },
  { title: 'actorId', key: 'actorId', ellipsis: { tooltip: true }, render: (row) => row.actorId ?? '—' },
  { title: 'target', key: 'target', ellipsis: { tooltip: true }, render: (row) => row.target ?? '—' },
  { title: 'ip', key: 'ip', width: 140, render: (row) => row.ip ?? '—' },
]
</script>

<template>
  <div>
    <PageHeader title="审计日志" subtitle="平台操作与认证事件流水（只读）" />

    <NSpace style="margin-bottom: 16px">
      <NSelect
        v-model:value="actionFilter"
        :options="actionOptions"
        filterable
        tag
        clearable
        placeholder="action（可输入自定义值）"
        style="width: 240px"
        @update:value="handleSearch"
      />
      <NInput
        v-model:value="workspaceFilter"
        clearable
        placeholder="workspaceId"
        style="width: 260px"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <NButton @click="handleSearch">查询</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="items"
        :loading="loading"
        :bordered="false"
        :row-key="(row: AuditRow) => row.id"
        :pagination="{
          page: page,
          pageSize: pageSize,
          itemCount: total,
          showSizePicker: true,
          pageSizes: [20, 50, 100],
          onChange: handlePageChange,
          onUpdatePageSize: handlePageSizeChange,
        }"
        remote
      />
    </NCard>
  </div>
</template>

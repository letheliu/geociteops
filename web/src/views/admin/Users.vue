<script setup lang="ts">
// 员工账号管理（平台侧）：列表/新建（一次性密码展示）/重置密码（一次性新临时密码）/禁用启用。
import { h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputGroup, NModal, NPopconfirm,
  NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()

type UserListResult = Awaited<ReturnType<typeof trpc.admin.user.list.query>>
type UserRow = UserListResult['items'][number]
// platformRole 在模型上可空（CUSTOMER 无角色），员工列表实为非空；收窄便于索引与提交
type PlatformRoleValue = NonNullable<UserRow['platformRole']>

const loading = ref(false)
const items = ref<UserRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营',
  FINANCE: '财务',
  SUPPORT: '支持',
}

const roleOptions = (['SUPER_ADMIN', 'OPERATOR', 'FINANCE', 'SUPPORT'] as PlatformRoleValue[]).map(
  (r) => ({ label: `${ROLE_LABELS[r] ?? r}（${r}）`, value: r }),
)

async function load() {
  loading.value = true
  try {
    const result = await trpc.admin.user.list.query({ page: page.value, pageSize: pageSize.value })
    items.value = result.items
    total.value = result.total
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function handlePageChange(p: number) {
  page.value = p
  load()
}

function handlePageSizeChange(ps: number) {
  pageSize.value = ps
  page.value = 1
  load()
}

// ===== 一次性密码展示（新建/重置共用） =====
const secretModal = ref(false)
const secretText = ref('')
const secretTitle = ref('')

function showSecret(title: string, password: string) {
  secretTitle.value = title
  secretText.value = password
  secretModal.value = true
}

function closeSecret() {
  // 关闭即清空：临时密码仅此一次，服务端只存哈希
  secretText.value = ''
  secretModal.value = false
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制')
  } catch {
    message.error('复制失败，请手动选择复制')
  }
}

// ===== 新建员工 =====
const showCreate = ref(false)
const creating = ref(false)
const createForm = ref({ username: '', displayName: '', platformRole: 'OPERATOR' as PlatformRoleValue })

function openCreate() {
  createForm.value = { username: '', displayName: '', platformRole: 'OPERATOR' }
  showCreate.value = true
}

async function handleCreate() {
  const f = createForm.value
  if (!f.username.trim() || !f.displayName.trim()) {
    message.warning('请填写用户名与姓名')
    return
  }
  creating.value = true
  try {
    const result = await trpc.admin.user.create.mutate({
      username: f.username.trim(),
      displayName: f.displayName.trim(),
      platformRole: f.platformRole,
    })
    showCreate.value = false
    showSecret('员工已创建', result.password)
    await load()
  } catch (e: any) {
    message.error(e?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

async function handleResetPassword(row: UserRow) {
  try {
    const result = await trpc.admin.user.resetPassword.mutate({ userId: row.id })
    showSecret(`重置 ${row.username} 的密码`, result.password)
  } catch (e: any) {
    message.error(e?.message || '重置失败')
  }
}

async function handleToggleStatus(row: UserRow) {
  try {
    const next = row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    await trpc.admin.user.setStatus.mutate({ userId: row.id, status: next })
    message.success(next === 'DISABLED' ? '已禁用' : '已启用')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

const columns: DataTableColumns<UserRow> = [
  { title: '用户名', key: 'username', width: 150 },
  { title: '姓名', key: 'displayName', width: 140 },
  {
    title: '平台角色',
    key: 'platformRole',
    width: 140,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: 'info' }, {
        default: () => (row.platformRole ? (ROLE_LABELS[row.platformRole] ?? row.platformRole) : '—'),
      }),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) =>
      h(NTag, {
        size: 'small',
        bordered: false,
        type: row.status === 'ACTIVE' ? 'success' : 'default',
      }, { default: () => (row.status === 'ACTIVE' ? '启用' : '禁用') }),
  },
  {
    title: '最近登录',
    key: 'lastLoginAt',
    width: 170,
    render: (row) => (row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString('zh-CN') : '—'),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 170,
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 260,
    render(row) {
      return h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, { size: 'tiny', onClick: () => handleResetPassword(row) }, { default: () => '重置密码' }),
          row.status === 'ACTIVE'
            ? h(NPopconfirm, { onPositiveClick: () => handleToggleStatus(row) }, {
                trigger: () => h(NButton, { size: 'tiny', type: 'warning' }, { default: () => '禁用' }),
                default: () => '确认禁用该账号？禁用后其会话立即失效。',
              })
            : h(NButton, { size: 'tiny', type: 'success', onClick: () => handleToggleStatus(row) }, { default: () => '启用' }),
        ],
      })
    },
  },
]
</script>

<template>
  <div>
    <PageHeader title="员工账号" subtitle="平台员工（PLATFORM 用户）的账号与角色管理" />

    <NSpace justify="end" style="margin-bottom: 16px">
      <NButton type="primary" @click="openCreate">+ 新建员工</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="items"
        :loading="loading"
        :bordered="false"
        :row-key="(row: UserRow) => row.id"
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

    <!-- 新建员工 -->
    <NModal v-model:show="showCreate" preset="card" title="新建员工" style="width: 480px" :mask-closable="false">
      <NForm label-placement="left" label-width="90">
        <NFormItem label="用户名">
          <NInput v-model:value="createForm.username" placeholder="登录用户名（3-64 字符）" />
        </NFormItem>
        <NFormItem label="姓名">
          <NInput v-model:value="createForm.displayName" placeholder="展示姓名" />
        </NFormItem>
        <NFormItem label="平台角色">
          <NSelect v-model:value="createForm.platformRole" :options="roleOptions" />
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 8px">
        未显式提供密码时由系统生成临时密码，创建成功后一次性展示，员工首次登录需改密。
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="handleCreate">创建</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 一次性密码展示（新建 / 重置共用） -->
    <NModal
      :show="secretModal"
      preset="card"
      :title="secretTitle"
      style="width: 520px"
      :mask-closable="false"
      @update:show="(v: boolean) => { if (!v) closeSecret() }"
    >
      <NSpace vertical :size="12">
        <NText type="warning" style="font-size: 13px">
          临时密码仅此一次展示，关闭后不可再查看，请立即复制并转交本人（首次登录将强制改密）。
        </NText>
        <NInputGroup>
          <NInput :value="secretText" readonly />
          <NButton type="primary" @click="copyText(secretText)">复制</NButton>
        </NInputGroup>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton type="primary" @click="closeSecret">我已保存，关闭</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

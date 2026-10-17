<script setup lang="ts">
// 成员管理（客户侧，任务 9，仅 ORG_OWNER——org.members.* 全部挂 org.manage）：
// - 页面级拦截：非 OWNER 直接渲染 403 结果，不发列表请求（后端也会拒，双保险）；
// - 表格：username/displayName/orgRole/status/最近登录/操作；
// - 新建 Modal：orgRole NSelect[ORG_MEMBER/ORG_VIEWER] + displayName + 可选 username/email
//   （不显式填密码 → 系统生成，成功后一次性展示，模式照 admin/Users.vue）；
// - 每行展开"工作区授权"：NSelect 选 workspace（org.workspaces.list）× access
//   NSelect[MANAGE/OPERATE/VIEW] → members.setAccess（upsert 语义，重复保存即调整）；
// - 禁用/启用 NPopconfirm（DISABLED 联动吊销会话，提示"会话立即失效"）；重置密码（一次性展示）。
import { computed, h, onMounted, reactive, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputGroup, NModal, NPopconfirm,
  NResult, NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'

const message = useMessage()
const sessionStore = useSessionStore()

type MemberRow = Awaited<ReturnType<typeof trpc.org.members.list.query>>[number]
type WorkspaceRow = Awaited<ReturnType<typeof trpc.org.workspaces.list.query>>['items'][number]

const isOwner = computed(() => sessionStore.isOrgOwner)

const loading = ref(false)
const items = ref<MemberRow[]>([])

const ORG_ROLE_META: Record<string, { type: 'warning' | 'info' | 'default'; label: string }> = {
  ORG_OWNER: { type: 'warning', label: '企业管理员' },
  ORG_MEMBER: { type: 'info', label: '成员' },
  ORG_VIEWER: { type: 'default', label: '只读' },
}

function orgRoleMeta(role: string | null) {
  if (!role) return { type: 'default' as const, label: '—' }
  return ORG_ROLE_META[role] ?? { type: 'default' as const, label: role }
}

async function load() {
  if (!isOwner.value) return
  loading.value = true
  try {
    items.value = await trpc.org.members.list.query()
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

// 工作区授权下拉数据源（与首页"我的 Workspace"同源，take 100 简化）
const workspaceOptions = ref<SelectOption[]>([])

async function loadWorkspaces() {
  try {
    const result = await trpc.org.workspaces.list.query({ page: 1, pageSize: 100 })
    workspaceOptions.value = result.items.map((w: WorkspaceRow) => ({ label: w.name, value: w.id }))
  } catch (e: any) {
    message.error(e?.message || '工作区列表加载失败')
  }
}

onMounted(() => {
  if (!isOwner.value) return
  load()
  loadWorkspaces()
})

// ===== 一次性密码展示（新建/重置共用，模式照 admin/Users.vue） =====
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

// ===== 新建成员 =====
type OrgMemberRole = 'ORG_MEMBER' | 'ORG_VIEWER'

const showCreate = ref(false)
const creating = ref(false)
const createForm = ref({
  displayName: '',
  username: '',
  email: '',
  orgRole: 'ORG_MEMBER' as OrgMemberRole,
})

const roleOptions: SelectOption[] = [
  { label: '成员（ORG_MEMBER，按工作区授权）', value: 'ORG_MEMBER' },
  { label: '只读（ORG_VIEWER，任何工作区最多 VIEW）', value: 'ORG_VIEWER' },
]

function openCreate() {
  createForm.value = { displayName: '', username: '', email: '', orgRole: 'ORG_MEMBER' }
  showCreate.value = true
}

async function handleCreate() {
  const f = createForm.value
  if (!f.displayName.trim()) {
    message.warning('请填写姓名')
    return
  }
  creating.value = true
  try {
    const result = await trpc.org.members.create.mutate({
      displayName: f.displayName.trim(),
      orgRole: f.orgRole,
      ...(f.username.trim() ? { username: f.username.trim() } : {}),
      ...(f.email.trim() ? { email: f.email.trim() } : {}),
    })
    showCreate.value = false
    showSecret('成员已创建', result.password)
    await load()
  } catch (e: any) {
    message.error(e?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

// ===== 重置密码 / 禁用启用 =====
async function handleResetPassword(row: MemberRow) {
  try {
    const result = await trpc.org.members.resetPassword.mutate({ userId: row.user.id })
    showSecret(`重置 ${row.user.username || row.user.displayName} 的密码`, result.password)
  } catch (e: any) {
    message.error(e?.message || '重置失败')
  }
}

async function handleToggleStatus(row: MemberRow) {
  try {
    const next = row.user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    await trpc.org.members.setStatus.mutate({ userId: row.user.id, status: next })
    message.success(next === 'DISABLED' ? '已禁用' : '已启用')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

// ===== 工作区授权（展开行）：members.setAccess upsert =====
type AccessValue = 'MANAGE' | 'OPERATE' | 'VIEW'

const accessOptions: SelectOption[] = [
  { label: 'MANAGE（管理）', value: 'MANAGE' },
  { label: 'OPERATE（操作）', value: 'OPERATE' },
  { label: 'VIEW（只读）', value: 'VIEW' },
]

/** 展开行的草稿（按 userId 隔离）：workspace 未选/权限默认 VIEW */
const accessDrafts = reactive(
  new Map<string, { workspaceId: string | null; access: AccessValue }>(),
)
const savingAccessId = ref<string | null>(null)

function draftFor(userId: string) {
  let d = accessDrafts.get(userId)
  if (!d) {
    d = reactive({ workspaceId: null, access: 'VIEW' as AccessValue })
    accessDrafts.set(userId, d)
  }
  return d
}

async function handleSetAccess(row: MemberRow) {
  const d = draftFor(row.user.id)
  if (!d.workspaceId) {
    message.warning('请先选择 Workspace')
    return
  }
  savingAccessId.value = row.user.id
  try {
    await trpc.org.members.setAccess.mutate({
      userId: row.user.id,
      workspaceId: d.workspaceId,
      access: d.access,
    })
    const wsName = workspaceOptions.value.find((o) => o.value === d.workspaceId)?.label ?? d.workspaceId
    message.success(`已授权：${wsName} × ${d.access}`)
  } catch (e: any) {
    message.error(e?.message || '授权失败')
  } finally {
    savingAccessId.value = null
  }
}

function renderExpand(row: MemberRow) {
  // OWNER 天然拥有本企业全部 Workspace 的 MANAGE（合成规则），无单 workspace 授权概念
  if (row.user.orgRole === 'ORG_OWNER') {
    return h(
      NText,
      { depth: '3', style: 'font-size: 13px' },
      { default: () => '企业管理员天然拥有本企业全部 Workspace 的管理权限，无需单独授权。' },
    )
  }
  const d = draftFor(row.user.id)
  return h('div', { style: 'padding: 4px 0' }, [
    h(NSpace, { align: 'center', size: 8, wrap: true }, {
      default: () => [
        h(NText, { depth: '3', style: 'font-size: 13px' }, { default: () => '授予/调整：' }),
        h(NSelect, {
          value: d.workspaceId,
          options: workspaceOptions.value,
          filterable: true,
          placeholder: '选择 Workspace',
          style: 'width: 260px',
          onUpdateValue: (v: string) => {
            d.workspaceId = v
          },
        }),
        h(NSelect, {
          value: d.access,
          options: accessOptions,
          style: 'width: 170px',
          onUpdateValue: (v: AccessValue) => {
            d.access = v
          },
        }),
        h(
          NButton,
          {
            size: 'small',
            type: 'primary',
            loading: savingAccessId.value === row.user.id,
            onClick: () => handleSetAccess(row),
          },
          { default: () => '保存' },
        ),
        h(
          NText,
          { depth: '3', style: 'font-size: 12px' },
          {
            default: () =>
              '重复保存即覆盖调整；只读成员（ORG_VIEWER）即使授予更高权限也只生效 VIEW。',
          },
        ),
      ],
    }),
  ])
}

const columns: DataTableColumns<MemberRow> = [
  { type: 'expand', renderExpand },
  { title: '用户名', key: 'username', width: 150, render: (row) => row.user.username || '—' },
  { title: '姓名', key: 'displayName', width: 140, render: (row) => row.user.displayName },
  {
    title: '企业角色',
    key: 'orgRole',
    width: 120,
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: orgRoleMeta(row.user.orgRole).type },
        { default: () => orgRoleMeta(row.user.orgRole).label },
      ),
  },
  {
    title: '状态',
    key: 'status',
    width: 90,
    render: (row) =>
      h(
        NTag,
        {
          size: 'small',
          bordered: false,
          type: row.user.status === 'ACTIVE' ? 'success' : 'default',
        },
        { default: () => (row.user.status === 'ACTIVE' ? '启用' : '禁用') },
      ),
  },
  {
    title: '最近登录',
    key: 'lastLoginAt',
    width: 170,
    render: (row) =>
      row.user.lastLoginAt ? new Date(row.user.lastLoginAt).toLocaleString('zh-CN') : '—',
  },
  {
    title: '操作',
    key: 'actions',
    width: 220,
    render(row) {
      return h(NSpace, { size: 'small' }, {
        default: () => [
          h(
            NButton,
            { size: 'tiny', onClick: () => handleResetPassword(row) },
            { default: () => '重置密码' },
          ),
          row.user.status === 'ACTIVE'
            ? h(NPopconfirm, { onPositiveClick: () => handleToggleStatus(row) }, {
                trigger: () =>
                  h(NButton, { size: 'tiny', type: 'warning' }, { default: () => '禁用' }),
                default: () => '确认禁用该账号？禁用后其会话立即失效。',
              })
            : h(
                NButton,
                { size: 'tiny', type: 'success', onClick: () => handleToggleStatus(row) },
                { default: () => '启用' },
              ),
        ],
      })
    },
  },
]
</script>

<template>
  <div style="max-width: 1200px; margin: 0 auto; padding: 24px">
    <!-- 页面级拦截：org.members.* 全挂 org.manage，MEMBER/VIEWER 无权（后端恒拒，此处不发请求） -->
    <NResult
      v-if="!isOwner"
      status="403"
      title="无权访问"
      description="成员管理仅企业管理员（ORG_OWNER）可用。"
      style="margin-top: 96px"
    />

    <template v-else>
      <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
        <PageHeader title="成员管理" subtitle="企业成员的账号、角色与工作区授权" />
        <NButton type="primary" @click="openCreate">+ 新建成员</NButton>
      </NSpace>

      <NCard>
        <NDataTable
          :columns="columns"
          :data="items"
          :loading="loading"
          :bordered="false"
          :row-key="(row: MemberRow) => row.user.id"
          :pagination="false"
        />
      </NCard>
    </template>

    <!-- 新建成员 -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      title="新建成员"
      style="width: 500px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="100">
        <NFormItem label="姓名">
          <NInput v-model:value="createForm.displayName" placeholder="展示姓名（必填）" />
        </NFormItem>
        <NFormItem label="企业角色">
          <NSelect v-model:value="createForm.orgRole" :options="roleOptions" />
        </NFormItem>
        <NFormItem label="用户名（可选）">
          <NInput v-model:value="createForm.username" placeholder="登录用户名（3-64 字符，留空自动生成）" />
        </NFormItem>
        <NFormItem label="邮箱（可选）">
          <NInput v-model:value="createForm.email" placeholder="name@company.com" />
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 8px">
        不填密码时由系统生成临时密码，创建成功后一次性展示，成员首次登录需改密。
        工作区权限在列表行展开的"工作区授权"中单独授予。
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

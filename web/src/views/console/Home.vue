<script setup lang="ts">
// 客户控制台首页——"我的 Workspace"（规格 §4.3）：
// - 数据源 org.workspaces.list（任意企业成员可见本企业全部；take 100 简化，超量后续再分页）；
// - 卡片网格：名称/状态 NTag/域名/进入——客户进入是纯前端路由跳转（显式传参 dashboard，
//   与 admin enterWorkspace 的 push 同模式，但不调 admin.workspace.enter——平台侧审计入口，orgProcedure 会拒）；
// - 新建（仅 ORG_OWNER）：org.workspaces.create（企业边界由后端从会话派生，无组织字段），
//   成功展示一次性 apiKey（照 admin/Workspaces.vue 模式，关闭即清空不可再查）；
// - me().workspaces（Header 切换下拉数据源）不含新建项——创建成功后同时 fetchMe 刷新；
// - 空态 NEmpty：OWNER 引导创建第一个；MEMBER/VIEWER 提示联系管理员授权。
import { computed, onMounted, ref } from 'vue'
import {
  NButton, NCard, NEmpty, NForm, NFormItem, NGrid, NGridItem, NInput, NInputGroup,
  NModal, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import { useRouter } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'

const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

type WorkspaceRow = Awaited<ReturnType<typeof trpc.org.workspaces.list.query>>['items'][number]

const loading = ref(false)
const items = ref<WorkspaceRow[]>([])

const STATUS_TAG: Record<string, { type: 'success' | 'warning' | 'default'; label: string }> = {
  ACTIVE: { type: 'success', label: 'ACTIVE' },
  SUSPENDED: { type: 'warning', label: 'SUSPENDED' },
  ARCHIVED: { type: 'default', label: 'ARCHIVED' },
}

function statusMeta(status: string) {
  return STATUS_TAG[status] ?? { type: 'default' as const, label: status }
}

async function load() {
  loading.value = true
  try {
    const result = await trpc.org.workspaces.list.query({ page: 1, pageSize: 100 })
    items.value = result.items
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function enter(row: WorkspaceRow) {
  router.push({ name: 'dashboard', params: { workspaceId: row.id } })
}

const orgName = computed(() => sessionStore.me?.organization?.name ?? '')
const emptyDescription = computed(() =>
  sessionStore.isOrgOwner
    ? '企业还没有 Workspace，创建一个开始 GEO 监测。'
    : '暂无授权的工作区，请联系企业管理员开通。',
)

// ===== 新建 Workspace（仅 ORG_OWNER） =====
const showModal = ref(false)
const creating = ref(false)
const createForm = ref({ name: '', defaultBrandName: '', domain: '' })
/** 创建成功后的一次性 API Key（仅展示一次，关闭即清空） */
const issuedKey = ref<string | null>(null)

function openCreate() {
  createForm.value = { name: '', defaultBrandName: '', domain: '' }
  issuedKey.value = null
  showModal.value = true
}

async function handleCreate() {
  const f = createForm.value
  if (!f.name.trim() || !f.defaultBrandName.trim()) {
    message.warning('请填写名称与默认品牌名')
    return
  }
  creating.value = true
  try {
    const result = await trpc.org.workspaces.create.mutate({
      name: f.name.trim(),
      defaultBrandName: f.defaultBrandName.trim(),
      ...(f.domain.trim() ? { domain: f.domain.trim() } : {}),
    })
    issuedKey.value = result.apiKey
    message.success('Workspace 已创建')
    await load()
    // 列表数据源是 org.workspaces.list 而非 me()；同步刷新会话让 Header 切换下拉含新工作区
    sessionStore.fetchMe()
  } catch (e: any) {
    message.error(e?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

function handleCloseCreate() {
  // in-flight 创建中不可关：mutation 返回的一次性 Key 尚未展示，关闭即永久丢失
  if (creating.value) return
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
  <div style="max-width: 1200px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="我的 Workspace" :subtitle="orgName" />
      <NButton v-if="sessionStore.isOrgOwner" type="primary" @click="openCreate">
        + 新建 Workspace
      </NButton>
    </NSpace>

    <!-- 企业设置入口（任务 9）：企业信息全员可见；成员管理/API 凭证仅 OWNER
         （VIEWER/MEMBER 无权，后端 org.manage / credential.write 也会拒） -->
    <NSpace :size="8" style="margin-bottom: 8px">
      <NText depth="3" style="font-size: 13px; line-height: 28px">企业设置：</NText>
      <NButton size="small" tertiary @click="router.push({ name: 'console-org-info' })">
        企业信息
      </NButton>
      <NButton
        v-if="sessionStore.isOrgOwner"
        size="small"
        tertiary
        @click="router.push({ name: 'console-members' })"
      >
        成员管理
      </NButton>
      <NButton
        v-if="sessionStore.isOrgOwner"
        size="small"
        tertiary
        @click="router.push({ name: 'console-credentials' })"
      >
        API 凭证
      </NButton>
    </NSpace>

    <NEmpty v-if="!loading && items.length === 0" :description="emptyDescription" style="margin-top: 96px">
      <template #extra>
        <NButton v-if="sessionStore.isOrgOwner" type="primary" @click="openCreate">
          创建第一个 Workspace
        </NButton>
      </template>
    </NEmpty>

    <NGrid v-else :cols="3" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <NGridItem v-for="row in items" :key="row.id" span="3 m:2 l:1">
        <NCard size="small" style="height: 100%">
          <template #header>
            <NText strong style="font-size: 15px">{{ row.name }}</NText>
          </template>
          <template #header-extra>
            <NTag size="small" :bordered="false" :type="statusMeta(row.status).type">
              {{ statusMeta(row.status).label }}
            </NTag>
          </template>
          <NSpace vertical :size="6">
            <NText depth="3" style="font-size: 13px">域名：{{ row.domain || '—' }}</NText>
            <NText depth="3" style="font-size: 13px">品牌名：{{ row.defaultBrandName }}</NText>
          </NSpace>
          <template #footer>
            <NButton
              size="small"
              type="primary"
              :disabled="row.status !== 'ACTIVE'"
              @click="enter(row)"
            >
              进入
            </NButton>
          </template>
        </NCard>
      </NGridItem>
    </NGrid>

    <NModal
      :show="showModal"
      preset="card"
      :title="issuedKey ? 'Workspace 已创建' : '新建 Workspace'"
      style="width: 520px"
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

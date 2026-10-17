<script setup lang="ts">
// Workspace 详情（平台侧）：基本信息表单（update）、状态操作、顾问分配（任务 6）、
// 竞品编辑（setCompetitors）、平台凭证（PlatformCredentials 组件，数据来自 admin.workspace.get）。
// 顾问分配操作（assignment.manage）仅 SUPER_ADMIN 可见；OPERATOR 只读列表（P1 遗留 2c，任务 15 修复）。
import { computed, onMounted, ref } from 'vue'
import {
  NButton, NCard, NForm, NFormItem, NInput, NPopconfirm, NSelect, NSpace, NSwitch, NTag, NText, NSpin,
  NEmpty, useMessage,
} from 'naive-ui'
import { useRoute } from 'vue-router'
import PageHeader from '../../components/common/PageHeader.vue'
import PlatformCredentials from '../../components/admin/PlatformCredentials.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { enterWorkspace } from '../../utils/enter-workspace'

const route = useRoute()
const message = useMessage()
const sessionStore = useSessionStore()

const workspaceId = computed(() => route.params.id as string)

/**
 * 详情数据形状（手写而非 Awaited<ReturnType<...>> 推导：
 * admin.workspace.get 的返回含 Prisma Workspace 全量关系投影，经 tRPC 客户端
 * 类型映射会触发 TS2589 深度爆炸；此处只声明页面用到的字段，结构兼容即可赋值）。
 */
interface WorkspaceDetailData {
  workspace: {
    name: string
    domain: string | null
    llmsTxtUrl: string | null
    defaultBrandName: string
    status: string
    organization: { id: string; name: string }
  }
  platformSummary: {
    competitors: string[]
    platforms: Record<string, { configured: boolean; hint: string }>
  }
}

/** 顾问分配视图（admin.workspace.listOperators 返回） */
interface OperatorAssignment {
  user: { id: string; username: string; displayName: string }
  isPrimary: boolean
}

const loading = ref(true)
const detail = ref<WorkspaceDetailData | null>(null)

const STATUS_TAG: Record<string, { type: 'success' | 'warning' | 'default'; label: string }> = {
  ACTIVE: { type: 'success', label: 'ACTIVE' },
  SUSPENDED: { type: 'warning', label: 'SUSPENDED' },
  ARCHIVED: { type: 'default', label: 'ARCHIVED' },
}

const form = ref({ name: '', defaultBrandName: '', domain: '', llmsTxtUrl: '' })
const savingBasic = ref(false)

/** 竞品编辑（NSelect tag 模式自由输入） */
const competitors = ref<string[]>([])
const savingCompetitors = ref(false)

/** 顾问分配（任务 6）：OPERATOR ↔ WorkspaceMember（access=OPERATE，isPrimary=负责顾问） */
const operators = ref<OperatorAssignment[]>([])
const assignUsername = ref('')
const assignIsPrimary = ref(false)
const assigning = ref(false)

async function loadOperators() {
  try {
    operators.value = await trpc.admin.workspace.listOperators.query({
      workspaceId: workspaceId.value,
    })
  } catch (e: any) {
    message.error(e?.message || '顾问列表加载失败')
  }
}

async function load() {
  loading.value = true
  try {
    detail.value = await trpc.admin.workspace.get.query({ workspaceId: workspaceId.value })
    form.value = {
      name: detail.value.workspace.name,
      defaultBrandName: detail.value.workspace.defaultBrandName,
      domain: detail.value.workspace.domain ?? '',
      llmsTxtUrl: detail.value.workspace.llmsTxtUrl ?? '',
    }
    competitors.value = [...detail.value.platformSummary.competitors]
    await loadOperators()
  } catch (e: any) {
    detail.value = null
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

const statusTag = computed(() => {
  const s = detail.value?.workspace.status ?? ''
  return STATUS_TAG[s] ?? { type: 'default' as const, label: s }
})

/** 顾问分配操作（assignment.manage）仅 SUPER_ADMIN：OPERATOR 对分配列表只读 */
const canManageAssignment = computed(() => sessionStore.me?.platformRole === 'SUPER_ADMIN')

async function handleSaveBasic() {
  const f = form.value
  if (!f.name.trim() || !f.defaultBrandName.trim()) {
    message.warning('名称与默认品牌名必填')
    return
  }
  savingBasic.value = true
  try {
    // domain/llmsTxtUrl 的 update 入参为 min(1).optional()：空串不可提交（后端无置空语义），留空即不改
    await trpc.admin.workspace.update.mutate({
      workspaceId: workspaceId.value,
      name: f.name.trim(),
      defaultBrandName: f.defaultBrandName.trim(),
      ...(f.domain.trim() ? { domain: f.domain.trim() } : {}),
      ...(f.llmsTxtUrl.trim() ? { llmsTxtUrl: f.llmsTxtUrl.trim() } : {}),
    })
    message.success('已保存')
    await load()
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    savingBasic.value = false
  }
}

async function handleSuspend() {
  try {
    await trpc.admin.workspace.suspend.mutate({ workspaceId: workspaceId.value })
    message.success('已暂停')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

async function handleResume() {
  try {
    await trpc.admin.workspace.resume.mutate({ workspaceId: workspaceId.value })
    message.success('已恢复')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

async function handleArchive() {
  try {
    await trpc.admin.workspace.archive.mutate({ workspaceId: workspaceId.value })
    message.success('已归档')
    await load()
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

async function handleEnter() {
  try {
    await enterWorkspace(workspaceId.value)
  } catch (e: any) {
    message.error(e?.message || '进入失败')
  }
}

async function handleSaveCompetitors() {
  savingCompetitors.value = true
  try {
    const list = competitors.value.map((c) => c.trim()).filter(Boolean)
    await trpc.admin.workspace.setCompetitors.mutate({
      workspaceId: workspaceId.value,
      competitors: list,
    })
    message.success('竞品已保存')
    await load()
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    savingCompetitors.value = false
  }
}

/** 分配顾问：userId 字段接受用户名（服务端先按 id 命中、未命中按 username 解析） */
async function handleAssignOperator() {
  const username = assignUsername.value.trim()
  if (!username) {
    message.warning('请输入顾问用户名')
    return
  }
  assigning.value = true
  try {
    await trpc.admin.workspace.assignOperator.mutate({
      workspaceId: workspaceId.value,
      userId: username,
      isPrimary: assignIsPrimary.value,
    })
    message.success('已分配')
    assignUsername.value = ''
    assignIsPrimary.value = false
    await loadOperators()
  } catch (e: any) {
    message.error(e?.message || '分配失败')
  } finally {
    assigning.value = false
  }
}

async function handleUnassignOperator(userId: string) {
  try {
    await trpc.admin.workspace.unassignOperator.mutate({
      workspaceId: workspaceId.value,
      userId,
    })
    message.success('已移除')
    await loadOperators()
  } catch (e: any) {
    message.error(e?.message || '移除失败')
  }
}
</script>

<template>
  <div>
    <PageHeader title="Workspace 详情" :subtitle="detail ? detail.workspace.name : ''" />

    <NSpin :show="loading">
      <NEmpty
        v-if="!loading && !detail"
        description="无法加载 Workspace（不存在或无权限）"
        style="padding: 48px 0"
      />
      <NSpace v-else-if="detail" vertical :size="16">
        <NCard title="状态与操作">
          <NSpace align="center" :size="12" :wrap="true">
            <NTag :type="statusTag.type" :bordered="false" size="large" style="font-weight: 600">
              {{ statusTag.label }}
            </NTag>
            <NText depth="3" style="font-size: 13px">
              所属企业：{{ detail.workspace.organization?.name ?? '—' }}
            </NText>
            <NButton size="small" type="primary" :disabled="detail.workspace.status !== 'ACTIVE'" @click="handleEnter">
              进入 Workspace
            </NButton>
            <NPopconfirm v-if="detail.workspace.status === 'ACTIVE'" @positive-click="handleSuspend">
              <template #trigger>
                <NButton size="small" type="warning">暂停</NButton>
              </template>
              确认暂停？暂停后客户侧不可用。
            </NPopconfirm>
            <NButton v-if="detail.workspace.status === 'SUSPENDED'" size="small" type="success" @click="handleResume">
              恢复
            </NButton>
            <NPopconfirm v-if="detail.workspace.status !== 'ARCHIVED'" @positive-click="handleArchive">
              <template #trigger>
                <NButton size="small" type="error">归档</NButton>
              </template>
              确认归档？归档后不可恢复。
            </NPopconfirm>
          </NSpace>
        </NCard>

        <NCard title="基本信息">
          <NForm label-placement="left" label-width="110" style="max-width: 560px">
            <NFormItem label="名称">
              <NInput v-model:value="form.name" />
            </NFormItem>
            <NFormItem label="默认品牌名">
              <NInput v-model:value="form.defaultBrandName" />
            </NFormItem>
            <NFormItem label="域名">
              <NInput v-model:value="form.domain" placeholder="example.com（留空则保持不变）" />
            </NFormItem>
            <NFormItem label="llms.txt URL">
              <NInput v-model:value="form.llmsTxtUrl" placeholder="https://…（留空则保持不变）" />
            </NFormItem>
          </NForm>
          <NSpace justify="start">
            <NButton type="primary" :loading="savingBasic" @click="handleSaveBasic">保存基本信息</NButton>
          </NSpace>
        </NCard>

        <NCard title="顾问分配">
          <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 12px">
            平台顾问（OPERATOR）被分配后才能经 x-workspace-id 进入该 Workspace；负责顾问在同一 Workspace 内唯一。
            <template v-if="!canManageAssignment">分配与移除操作仅超级管理员（SUPER_ADMIN）可执行。</template>
          </div>
          <NSpace vertical :size="8">
            <NSpace v-for="op in operators" :key="op.user.id" align="center" :size="8">
              <NTag v-if="op.isPrimary" type="info" size="small" :bordered="false">负责顾问</NTag>
              <NText>{{ op.user.displayName }}</NText>
              <NText depth="3" style="font-size: 12px">@{{ op.user.username }}</NText>
              <NPopconfirm v-if="canManageAssignment" @positive-click="handleUnassignOperator(op.user.id)">
                <template #trigger>
                  <NButton size="tiny" type="error" quaternary>移除</NButton>
                </template>
                确认移除该顾问的分配？移除后其将无法进入此 Workspace。
              </NPopconfirm>
            </NSpace>
            <NText v-if="operators.length === 0" depth="3" style="font-size: 13px">
              尚未分配顾问
            </NText>
          </NSpace>
          <NSpace v-if="canManageAssignment" align="center" :size="12" style="margin-top: 16px" :wrap="true">
            <NInput
              v-model:value="assignUsername"
              placeholder="顾问用户名"
              style="width: 220px"
              @keydown.enter="handleAssignOperator"
            />
            <NSwitch v-model:value="assignIsPrimary" size="small" />
            <NText depth="3" style="font-size: 13px">设为负责顾问</NText>
            <NButton type="primary" size="small" :loading="assigning" @click="handleAssignOperator">
              分配
            </NButton>
          </NSpace>
        </NCard>

        <NCard title="竞品配置">
          <NSelect
            v-model:value="competitors"
            multiple
            filterable
            tag
            clearable
            placeholder="输入域名后回车添加，如 competitor.com"
            :options="competitors.map((c) => ({ label: c, value: c }))"
            style="max-width: 560px"
          />
          <NSpace justify="start" style="margin-top: 12px">
            <NButton type="primary" :loading="savingCompetitors" @click="handleSaveCompetitors">保存竞品</NButton>
          </NSpace>
        </NCard>

        <NCard title="AI 平台凭证">
          <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 12px">
            凭证明文不入库也不回显；重新配置为整体覆盖写密文，hint 仅显示 key 末 4 位。
          </div>
          <PlatformCredentials
            :workspace-id="workspaceId"
            :platform-summary="detail.platformSummary.platforms"
            @saved="load"
          />
        </NCard>
      </NSpace>
    </NSpin>
  </div>
</template>

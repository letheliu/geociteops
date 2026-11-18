<script setup lang="ts">
// API 凭证（客户侧，任务 9）：
// - workspace NSelect（数据源 org.workspaces.list）→ org.credentials.list { workspaceId }
//   （任意企业成员可看列表，脱敏视图）；
// - 创建（仅 OWNER，credential.write）：name 输入 → org.credentials.issue → 一次性 plaintext
//   展示（照 admin 一次性 Key 模式，仅 ref + 关闭即清）；
// - 吊销（仅 OWNER）NPopconfirm；非 OWNER 只读降级——创建/吊销按钮隐藏 + 提示条。
import { computed, h, onMounted, ref } from 'vue'
import {
  NAlert, NButton, NCard, NDataTable, NForm, NFormItem, NInput, NInputGroup, NModal,
  NPopconfirm, NSelect, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { useI18n } from '@/i18n'
const { t, locale: appLocale } = useI18n()


const message = useMessage()
const sessionStore = useSessionStore()

/**
 * 凭证行：与后端 ApiCredentialSummary（脱敏视图，keyHash 不出边界）的线上形状对齐——
 * JSON 通道下日期是 ISO 字符串、keyPrefix 可空。直接 Awaited<ReturnType<...>> 推导
 * 该端点会因 scopes 的 Prisma JsonValue 递归类型触发 TS2589，故本地声明（scopes 未用，略）。
 */
interface CredentialRow {
  id: string
  name: string
  keyPrefix: string | null
  /** ISO 字符串（JSON 通道无 Date 反序列化），null = 从未使用 */
  lastUsedAt: string | null
  /** ISO 字符串，非空即已吊销 */
  revokedAt: string | null
}
type WorkspaceRow = Awaited<ReturnType<typeof trpc.org.workspaces.list.query>>['items'][number]

const isOwner = computed(() => sessionStore.isOrgOwner)

// ===== workspace 选择（授权下拉数据源） =====
const workspaceOptions = ref<SelectOption[]>([])
const selectedWorkspaceId = ref<string | null>(null)

async function loadWorkspaces() {
  try {
    const result = await trpc.org.workspaces.list.query({ page: 1, pageSize: 100 })
    workspaceOptions.value = result.items.map((w: WorkspaceRow) => ({ label: w.name, value: w.id }))
  } catch (e: any) {
    message.error(e?.message || t("工作区列表加载失败"))
  }
}

// ===== 凭证列表 =====
const loading = ref(false)
const items = ref<CredentialRow[]>([])

async function loadCredentials() {
  if (!selectedWorkspaceId.value) {
    items.value = []
    return
  }
  loading.value = true
  try {
    items.value = await trpc.org.credentials.list.query({ workspaceId: selectedWorkspaceId.value })
  } catch (e: any) {
    message.error(e?.message || t("加载失败"))
  } finally {
    loading.value = false
  }
}

function handleWorkspaceChange(value: string) {
  selectedWorkspaceId.value = value
  loadCredentials()
}

onMounted(loadWorkspaces)

// ===== 创建（一次性明文 Key） =====
const showCreate = ref(false)
const creating = ref(false)
const createName = ref('')

// 一次性明文 Key（仅展示一次，关闭即清空不可再查）
const secretModal = ref(false)
const secretText = ref('')

function openCreate() {
  createName.value = ''
  showCreate.value = true
}

async function handleCreate() {
  const workspaceId = selectedWorkspaceId.value
  if (!workspaceId) {
    message.warning(t("请先选择 Workspace"))
    return
  }
  const name = createName.value.trim()
  if (!name) {
    message.warning(t("请填写凭证名称"))
    return
  }
  creating.value = true
  try {
    const result = await trpc.org.credentials.issue.mutate({ workspaceId, name })
    showCreate.value = false
    secretText.value = result.plaintext
    secretModal.value = true
    message.success(t("凭证已创建"))
    await loadCredentials()
  } catch (e: any) {
    message.error(e?.message || t("创建失败"))
  } finally {
    creating.value = false
  }
}

function closeSecret() {
  // 关闭即清空：明文 Key 仅此一次，服务端只存哈希
  secretText.value = ''
  secretModal.value = false
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t("已复制"))
  } catch {
    message.error(t("复制失败，请手动选择复制"))
  }
}

// ===== 吊销 =====
async function handleRevoke(row: CredentialRow) {
  try {
    await trpc.org.credentials.revoke.mutate({ credentialId: row.id })
    message.success(t("已吊销"))
    await loadCredentials()
  } catch (e: any) {
    message.error(e?.message || t("吊销失败"))
  }
}

const columns: DataTableColumns<CredentialRow> = [
  { title: t("名称"), key: 'name', minWidth: 160 },
  {
    title: t("Key 前缀"),
    key: 'keyPrefix',
    width: 140,
    render: (row) => (row.keyPrefix ? `${row.keyPrefix}••••` : '—'),
  },
  {
    title: t("最近使用"),
    key: 'lastUsedAt',
    width: 170,
    render: (row) => (row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString(appLocale.value) : t("从未使用")),
  },
  {
    title: t("状态"),
    key: 'revokedAt',
    width: 100,
    render: (row) =>
      row.revokedAt
        ? h(NTag, { size: 'small', bordered: false, type: 'default' }, { default: () => t("已吊销") })
        : h(NTag, { size: 'small', bordered: false, type: 'success' }, { default: () => t("有效") }),
  },
  {
    title: t("操作"),
    key: 'actions',
    width: 120,
    render(row) {
      if (row.revokedAt || !isOwner.value) return '—'
      return h(NPopconfirm, { onPositiveClick: () => handleRevoke(row) }, {
        trigger: () => h(NButton, { size: 'tiny', type: 'error' }, { default: () => t("吊销") }),
        default: () => t("确认吊销该凭证？吊销后使用该 Key 的调用立即失效，不可恢复。"),
      })
    },
  },
]
</script>

<template>
  <div style="max-width: 1000px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader :title="t('API 凭证')" :subtitle="t('工作区 SDK Key 的签发与吊销（服务端接入用）')" />
      <NButton
        v-if="isOwner"
        type="primary"
        :disabled="!selectedWorkspaceId"
        @click="openCreate"
      > {{ t('+ 创建凭证') }} </NButton>
    </NSpace>

    <NAlert
      v-if="!isOwner"
      type="info"
      :bordered="false"
      :closable="false"
      style="margin-bottom: 16px"
    > {{ t('当前为只读视图：凭证的创建与吊销仅企业管理员（ORG_OWNER）可操作。') }} </NAlert>

    <NSpace vertical :size="16">
      <NSelect
        :value="selectedWorkspaceId"
        :options="workspaceOptions"
        filterable
        :placeholder="t('选择 Workspace 查看其凭证')"
        @update:value="handleWorkspaceChange"
      />
      <NCard>
        <NDataTable
          v-if="selectedWorkspaceId"
          :columns="columns"
          :data="items"
          :loading="loading"
          :bordered="false"
          :row-key="(row: CredentialRow) => row.id"
          :pagination="false"
        />
        <NText v-else depth="3" style="font-size: 13px"> {{ t('请先选择 Workspace——API 凭证按工作区隔离，创建后在一次性弹窗展示完整 Key。') }} </NText>
      </NCard>
    </NSpace>

    <!-- 创建凭证 -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      :title="t('创建 API 凭证')"
      style="width: 480px"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem :label="t('名称')">
          <NInput v-model:value="createName" :placeholder="t('凭证用途备注（1-100 字符）')" />
        </NFormItem>
      </NForm>
      <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 8px"> {{ t('完整 Key 仅在创建成功后展示一次（服务端只存哈希），请立即复制并妥善保管。') }} </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ t('取消') }}</NButton>
          <NButton type="primary" :loading="creating" @click="handleCreate">{{ t('创建') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 一次性明文 Key 展示 -->
    <NModal
      :show="secretModal"
      preset="card"
      :title="t('API Key 已创建')"
      style="width: 560px"
      :mask-closable="false"
      @update:show="(v: boolean) => { if (!v) closeSecret() }"
    >
      <NSpace vertical :size="12">
        <NText type="warning" style="font-size: 13px"> {{ t('完整 API Key 仅此一次展示，关闭后不可再查看，请立即复制并妥善保管。') }} </NText>
        <NInputGroup>
          <NInput :value="secretText" readonly />
          <NButton type="primary" @click="copyText(secretText)">{{ t('复制') }}</NButton>
        </NInputGroup>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton type="primary" @click="closeSecret">{{ t('我已保存，关闭') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

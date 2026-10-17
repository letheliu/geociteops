<script setup lang="ts">
// 工作区设置（任务 10 客户侧分叉）：
// - 读数据：统一 workspace.get（protected 8 字段投影含 platformSummary，平台/客户
//   两通道通吃，不随身份分叉）；
// - 写操作按 sessionStore.isCustomer 分叉（响应式，切换账号安全）：
//   客户 → org.workspaces.update/setCompetitors/setPlatformCredentials（同形状只换前缀）；
//   平台用户（含 OPERATOR 被分配的）→ admin.workspace.*（现状不变）；
// - 权限降级（客户 MEMBER/VIEWER，§2.2：基础信息/竞品/凭证均 OWNER）：
//   三块一致只读——表单 disabled + 保存按钮隐藏 + NAlert 提示（口径同任务 9 三页），
//   凭证组件传 readonly 隐藏"重新配置"；
// - 基础信息 domain/llmsTxtUrl 为 min(1).optional()，空串不可提交——留空即不改；
// - 竞品编辑（NSelect tag 模式自由输入）。
// workspaceId 一律取 route.params.workspaceId（路由参数为唯一事实来源，不读 store）。
import { computed, onMounted, ref, watch } from 'vue'
import {
  NAlert, NButton, NCard, NForm, NFormItem, NInput, NSelect, NSpace, NSpin, NEmpty, NTag,
  useMessage,
} from 'naive-ui'
import { useRoute } from 'vue-router'
import PageHeader from '../components/common/PageHeader.vue'
import PlatformCredentials from '../components/admin/PlatformCredentials.vue'
import { trpc } from '../composables/useTrpc'
import { useSessionStore } from '../stores/session'

type WorkspaceProjection = Awaited<ReturnType<typeof trpc.workspace.get.query>>

const route = useRoute()
const message = useMessage()
const sessionStore = useSessionStore()

const workspaceId = computed(() => route.params.workspaceId as string)

/** 客户用户：写操作走 org.workspaces.*；平台用户走 admin.*（现状） */
const isCustomer = computed(() => sessionStore.isCustomer)
/** 三块（基础信息/竞品/凭证）统一的可写判定：客户仅 ORG_OWNER 可写，平台用户恒可写 */
const canWrite = computed(() => !sessionStore.isCustomer || sessionStore.isOrgOwner)

const loading = ref(true)
const ws = ref<WorkspaceProjection | null>(null)

const form = ref({ name: '', defaultBrandName: '', domain: '', llmsTxtUrl: '' })
const savingBasic = ref(false)

/** 竞品编辑（NSelect tag 模式自由输入） */
const competitors = ref<string[]>([])
const savingCompetitors = ref(false)

/** load 序号（与 WorkspaceLayout 的 fetchSeq 同款简单节流）：工作区快速切换时丢弃迟到旧响应 */
let loadSeq = 0

async function load() {
  // 护栏：无 workspaceId（路由参数缺失/无效）时清态不发请求
  if (!workspaceId.value) {
    loadSeq++
    ws.value = null
    form.value = { name: '', defaultBrandName: '', domain: '', llmsTxtUrl: '' }
    competitors.value = []
    loading.value = false
    return
  }
  const seq = ++loadSeq
  loading.value = true
  try {
    const data = await trpc.workspace.get.query()
    if (seq !== loadSeq) return
    ws.value = data
    form.value = {
      name: data.name,
      defaultBrandName: data.defaultBrandName,
      domain: data.domain ?? '',
      llmsTxtUrl: data.llmsTxtUrl ?? '',
    }
    competitors.value = [...data.competitors]
  } catch {
    if (seq !== loadSeq) return
    ws.value = null
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

onMounted(load)

// 工作区切换（/console/w/a/settings → /console/w/b/settings）时 vue-router 复用组件
// 实例、onMounted 不重跑——若不重载，表单/竞品/platformSummary 仍是 a 的数据而
// workspaceId 已是 b，保存会把 a 的数据写进 b（审查 Important 项）。无需 immediate：
// 首载由 onMounted 承担。
watch(
  () => route.params.workspaceId,
  () => load(),
)

async function handleSaveBasic() {
  const f = form.value
  if (!f.name.trim() || !f.defaultBrandName.trim()) {
    message.warning('名称与默认品牌名必填')
    return
  }
  savingBasic.value = true
  try {
    // 写操作分叉（任务 10）：org.workspaces 与 admin.workspace 同形状只换前缀
    const mutate = sessionStore.isCustomer
      ? trpc.org.workspaces.update.mutate
      : trpc.admin.workspace.update.mutate
    await mutate({
      workspaceId: workspaceId.value,
      name: f.name.trim(),
      defaultBrandName: f.defaultBrandName.trim(),
      ...(f.domain.trim() ? { domain: f.domain.trim() } : {}),
      ...(f.llmsTxtUrl.trim() ? { llmsTxtUrl: f.llmsTxtUrl.trim() } : {}),
    })
    message.success('基本信息已保存')
    await load()
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    savingBasic.value = false
  }
}

async function handleSaveCompetitors() {
  savingCompetitors.value = true
  try {
    const list = competitors.value.map((c) => c.trim()).filter(Boolean)
    // 写操作分叉（任务 10）：同形状只换前缀
    const mutate = sessionStore.isCustomer
      ? trpc.org.workspaces.setCompetitors.mutate
      : trpc.admin.workspace.setCompetitors.mutate
    await mutate({
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
</script>

<template>
  <div>
    <PageHeader title="设置" subtitle="工作区基础信息、竞品与 AI 平台凭证" />

    <NSpin :show="loading">
      <NEmpty v-if="!loading && !ws" description="无法加载工作区信息（缺少工作区上下文或无权限）" style="padding: 48px 0" />
      <NSpace v-else-if="ws" vertical :size="16">
        <NAlert
          v-if="!canWrite"
          type="info"
          :bordered="false"
          :closable="false"
        >
          工作区设置（基础信息、竞品、AI 平台凭证）仅企业管理员（ORG_OWNER）可修改，当前为只读。
        </NAlert>

        <NCard title="基本信息">
          <template #header-extra>
            <NTag :bordered="false" size="small">{{ ws.status }}</NTag>
          </template>
          <NForm label-placement="left" label-width="110" style="max-width: 560px">
            <NFormItem label="名称">
              <NInput v-model:value="form.name" :disabled="!canWrite" />
            </NFormItem>
            <NFormItem label="默认品牌名">
              <NInput v-model:value="form.defaultBrandName" :disabled="!canWrite" />
            </NFormItem>
            <NFormItem label="域名">
              <NInput
                v-model:value="form.domain"
                :disabled="!canWrite"
                placeholder="example.com（留空则保持不变）"
              />
            </NFormItem>
            <NFormItem label="llms.txt URL">
              <NInput
                v-model:value="form.llmsTxtUrl"
                :disabled="!canWrite"
                placeholder="https://…（留空则保持不变）"
              />
            </NFormItem>
          </NForm>
          <NSpace v-if="canWrite" justify="start">
            <NButton type="primary" :loading="savingBasic" @click="handleSaveBasic">保存基本信息</NButton>
          </NSpace>
        </NCard>

        <NCard title="竞品配置">
          <NSelect
            v-model:value="competitors"
            multiple
            filterable
            tag
            clearable
            :disabled="!canWrite"
            placeholder="输入竞品名后回车添加，如 Midjourney"
            :options="competitors.map((c) => ({ label: c, value: c }))"
            style="max-width: 560px"
          />
          <NSpace v-if="canWrite" justify="start" style="margin-top: 12px">
            <NButton type="primary" :loading="savingCompetitors" @click="handleSaveCompetitors">保存竞品</NButton>
          </NSpace>
        </NCard>

        <NCard title="AI 平台凭证">
          <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 12px">
            凭证明文不入库也不回显；重新配置为整体覆盖写密文，hint 仅显示 key 末 4 位。
          </div>
          <PlatformCredentials
            :workspace-id="workspaceId"
            :platform-summary="ws.platformSummary"
            :endpoint="isCustomer ? 'org' : 'admin'"
            :readonly="!canWrite"
            @saved="load"
          />
        </NCard>
      </NSpace>
    </NSpin>
  </div>
</template>

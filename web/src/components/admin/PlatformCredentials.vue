<script setup lang="ts">
// 平台凭证配置组件（平台管理/工作区设置/客户 Settings 共用）：
// - 每平台一张卡片：configured 状态 + hint（key 末 4 位，服务端脱敏投影）；
// - "重新配置"打开 Modal：字段全部为空（写密文语义，绝不回显旧值），
//   保存 = 整体覆盖该平台已存配置（REQUIRED_KEYS 缺项会导致平台判为未配置）；
// - 组件自含保存调用，端点由 endpoint prop 分叉（任务 10）：
//   'admin' → admin.workspace.setPlatformCredentials（平台侧，默认，旧用法零改动）；
//   'org'   → org.workspaces.setPlatformCredentials（客户侧，同形状只换前缀）；
// - readonly（客户 MEMBER/VIEWER，§2.2 凭证权限=OWNER）：隐藏"重新配置"按钮，
//   仅展示 configured/hint；
// - 成功后 emit('saved') 供父组件刷新 platformSummary。
import { computed, ref } from 'vue'
import {
  NButton, NForm, NFormItem, NInput, NModal, NSpace, NTag, NText, useMessage,
} from 'naive-ui'
import { trpc } from '../../api/client'
import { DEFAULT_PLATFORMS } from './platform-defs'
import type { PlatformDef } from './platform-defs'

const props = withDefaults(
  defineProps<{
    /** 目标工作区（保存时显式传给 setPlatformCredentials） */
    workspaceId: string
    /** 服务端脱敏概况：platformSummary[key] = { configured, hint } */
    platformSummary: Record<string, { configured: boolean; hint: string }>
    /** 平台定义列表，缺省用内置 7 平台 */
    platforms?: PlatformDef[]
    /** 保存端点分叉：admin.workspace.*（默认）或 org.workspaces.*（客户侧） */
    endpoint?: 'admin' | 'org'
    /** 只读降级：隐藏"重新配置"按钮，仅展示状态/hint */
    readonly?: boolean
  }>(),
  { platforms: () => DEFAULT_PLATFORMS, endpoint: 'admin', readonly: false },
)

const emit = defineEmits<{ saved: [platform: string] }>()

const message = useMessage()

const showModal = ref(false)
const saving = ref(false)
const activePlatform = ref<PlatformDef | null>(null)
/** Modal 内各字段输入值（envKey → 输入内容；全空起步，不回显旧值） */
const fieldValues = ref<Record<string, string>>({})

const platformDefs = computed(() => props.platforms)

function summaryOf(key: string): { configured: boolean; hint: string } {
  return props.platformSummary[key] ?? { configured: false, hint: '' }
}

function openConfigure(p: PlatformDef) {
  activePlatform.value = p
  const values: Record<string, string> = {}
  for (const f of p.fields) values[f.envKey] = ''
  fieldValues.value = values
  showModal.value = true
}

async function handleSave() {
  const p = activePlatform.value
  if (!p) return
  const values: Record<string, string> = {}
  for (const f of p.fields) {
    const v = (fieldValues.value[f.envKey] ?? '').trim()
    if (f.required && !v) {
      message.warning(`请填写 ${p.label} 的${f.label}`)
      return
    }
    if (v) values[f.envKey] = v
  }
  if (Object.keys(values).length === 0) {
    message.warning('至少填写一个字段（留空保存将清空该平台配置，如需清除请联系处理）')
    return
  }
  saving.value = true
  try {
    // 端点分叉（任务 10）：org.workspaces 与 admin.workspace 输入输出同形状，只换前缀
    const mutate =
      props.endpoint === 'org'
        ? trpc.org.workspaces.setPlatformCredentials.mutate
        : trpc.admin.workspace.setPlatformCredentials.mutate
    await mutate({
      workspaceId: props.workspaceId,
      platform: p.key,
      values,
    })
    message.success(`${p.label} 凭证已保存`)
    showModal.value = false
    emit('saved', p.key)
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NSpace vertical :size="12">
    <div
      v-for="p in platformDefs"
      :key="p.key"
      style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap"
    >
      <span style="font-size: 14px; font-weight: 600; min-width: 200px">{{ p.label }}</span>
      <NTag
        :type="summaryOf(p.key).configured ? 'success' : 'default'"
        :bordered="false"
        size="small"
        style="font-weight: 600"
      >
        {{ summaryOf(p.key).configured ? '已配置' : '未配置' }}
      </NTag>
      <NText v-if="summaryOf(p.key).hint" depth="3" style="font-size: 12px">
        ····{{ summaryOf(p.key).hint }}
      </NText>
      <NButton
        v-if="!readonly"
        size="tiny"
        quaternary
        type="primary"
        @click="openConfigure(p)"
      >
        {{ summaryOf(p.key).configured ? '重新配置' : '配置' }}
      </NButton>
    </div>

    <NModal
      v-model:show="showModal"
      preset="card"
      :title="`配置 ${activePlatform?.label ?? ''} 凭证`"
      style="width: 520px"
    >
      <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 12px">
        出于安全考虑不回显已保存的凭证；保存将整体覆盖该平台的现有配置（未填写的可选项会被清除）。
      </div>
      <NForm label-placement="left" label-width="auto">
        <NFormItem v-for="f in activePlatform?.fields ?? []" :key="f.envKey" :label="f.label">
          <NInput
            v-model:value="fieldValues[f.envKey]"
            type="password"
            show-password-on="click"
            :placeholder="f.required ? '必填' : '可选，留空不覆盖为空'"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="handleSave">保存</NButton>
        </NSpace>
      </template>
    </NModal>
  </NSpace>
</template>

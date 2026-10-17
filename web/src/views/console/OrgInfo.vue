<script setup lang="ts">
// 企业信息（客户侧，任务 9）：
// - 数据源 org.info.get（任意企业成员可见）；保存 org.info.update { name?, creditCode?, industry? }
//   （org.manage——仅 ORG_OWNER，后端对 MEMBER/VIEWER 恒拒）；
// - 非 OWNER 只读降级：表单禁用 + 保存按钮隐藏 + 提示条（与成员/凭证页的降级口径一致）；
// - 可选字段留空不提交（后端 zod 对空串会判 min(1) 失败，只发已填字段）。
import { computed, onMounted, reactive, ref } from 'vue'
import {
  NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NTag, useMessage,
} from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'

const message = useMessage()
const sessionStore = useSessionStore()

type OrgInfo = Awaited<ReturnType<typeof trpc.org.info.get.query>>

const loading = ref(false)
const saving = ref(false)
const info = ref<OrgInfo | null>(null)
const form = reactive({ name: '', creditCode: '', industry: '' })

const isOwner = computed(() => sessionStore.isOrgOwner)

const STATUS_TAG: Record<string, { type: 'success' | 'warning' | 'default'; label: string }> = {
  ACTIVE: { type: 'success', label: '正常' },
  SUSPENDED: { type: 'warning', label: '已停用' },
}

function statusMeta(status: string) {
  return STATUS_TAG[status] ?? { type: 'default' as const, label: status }
}

async function load() {
  loading.value = true
  try {
    info.value = await trpc.org.info.get.query()
    form.name = info.value.name
    form.creditCode = info.value.creditCode ?? ''
    form.industry = info.value.industry ?? ''
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function handleSave() {
  const name = form.name.trim()
  if (!name) {
    message.warning('企业名称不能为空')
    return
  }
  saving.value = true
  try {
    info.value = await trpc.org.info.update.mutate({
      name,
      ...(form.creditCode.trim() ? { creditCode: form.creditCode.trim() } : {}),
      ...(form.industry.trim() ? { industry: form.industry.trim() } : {}),
    })
    message.success('已保存')
  } catch (e: any) {
    message.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div style="max-width: 720px; margin: 0 auto; padding: 24px">
    <NSpace justify="space-between" align="center" style="margin-bottom: 16px">
      <PageHeader title="企业信息" :subtitle="sessionStore.me?.organization?.name" />
      <NTag v-if="info" size="small" :bordered="false" :type="statusMeta(info.status).type">
        {{ statusMeta(info.status).label }}
      </NTag>
    </NSpace>

    <NAlert
      v-if="!isOwner"
      type="info"
      :bordered="false"
      :closable="false"
      style="margin-bottom: 16px"
    >
      企业信息仅企业管理员（ORG_OWNER）可修改，当前为只读。
    </NAlert>

    <NCard :loading="loading">
      <NForm label-placement="left" label-width="110">
        <NFormItem label="企业名称">
          <NInput
            v-model:value="form.name"
            :disabled="!isOwner"
            placeholder="企业全称（1-100 字符）"
          />
        </NFormItem>
        <NFormItem label="统一社会信用代码">
          <NInput
            v-model:value="form.creditCode"
            :disabled="!isOwner"
            placeholder="选填（1-64 字符）"
          />
        </NFormItem>
        <NFormItem label="所属行业">
          <NInput
            v-model:value="form.industry"
            :disabled="!isOwner"
            placeholder="选填，如：汽车 / 快消 / 金融（1-64 字符）"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton v-if="isOwner" type="primary" :loading="saving" @click="handleSave">
            保存
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </div>
</template>

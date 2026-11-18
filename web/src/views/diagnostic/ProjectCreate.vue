<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { NSteps, NStep, NForm, NFormItem, NInput, NButton, NSpace, NCard, useMessage } from 'naive-ui'
import { trpc } from '../../api/client'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const router = useRouter()
const message = useMessage()
const currentStep = ref(1)
const loading = ref(false)

const form = ref({
  name: '',
  brandName: '',
  brandAliases: '',
  brandDomain: '',
  targetAudiences: '',
  coreScenarios: '',
  competitors: '',
})

async function handleCreate() {
  loading.value = true
  try {
    const project = await (trpc as any).diagnostic.projects.create.mutate({
      name: form.value.name,
      brandName: form.value.brandName,
      brandAliases: form.value.brandAliases ? form.value.brandAliases.split('\n').map((s: string) => s.trim()).filter(Boolean) : [],
      brandDomain: form.value.brandDomain || undefined,
      targetAudiences: form.value.targetAudiences.split('\n').map((s: string) => s.trim()).filter(Boolean),
      coreScenarios: form.value.coreScenarios.split('\n').map((s: string) => s.trim()).filter(Boolean),
      competitors: form.value.competitors ? form.value.competitors.split('\n').map((line: string) => {
        const parts = line.split(',').map((s: string) => s.trim())
        return { name: parts[0], domain: parts[1] || undefined }
      }) : [],
    })
    message.success(t("项目创建成功"))
    router.push({ name: 'diagnostic-query-planner', params: { id: (project as any).id } })
  } catch (err: any) {
    message.error(err.message || t("创建失败"))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <NCard :title="t('新建诊断项目')" style="max-width: 720px; margin: 0 auto">
    <NSteps :current="currentStep">
      <NStep :title="t('品牌上下文')" :description="t('基本信息')" />
      <NStep :title="t('问题规划')" :description="t('下一步配置')" />
      <NStep :title="t('激活')" :description="t('完成创建')" />
    </NSteps>

    <NForm v-if="currentStep === 1" label-placement="top" style="margin-top: 24px">
      <NFormItem :label="t('项目名称')">
        <NInput v-model:value="form.name" :placeholder="t('例如：品牌 GEO 诊断')" />
      </NFormItem>
      <NFormItem :label="t('品牌名称')">
        <NInput v-model:value="form.brandName" :placeholder="t('主要品牌名')" />
      </NFormItem>
      <NFormItem :label="t('品牌别名（每行一个）')">
        <NInput v-model:value="form.brandAliases" type="textarea" :rows="3" :placeholder="t('品牌的其他名称')" />
      </NFormItem>
      <NFormItem :label="t('品牌域名')">
        <NInput v-model:value="form.brandDomain" placeholder="https://example.com" />
      </NFormItem>
      <NFormItem :label="t('目标用户（每行一个）')">
        <NInput v-model:value="form.targetAudiences" type="textarea" :rows="3" :placeholder="t('例如：技术决策者')" />
      </NFormItem>
      <NFormItem :label="t('核心场景（每行一个）')">
        <NInput v-model:value="form.coreScenarios" type="textarea" :rows="3" :placeholder="t('例如：寻找分析工具')" />
      </NFormItem>
      <NFormItem :label="t('竞品（每行一个，名称,域名）')">
        <NInput v-model:value="form.competitors" type="textarea" :rows="3" :placeholder="t('竞品A, competitor-a.com')" />
      </NFormItem>
      <NSpace justify="end">
        <NButton @click="currentStep = 2" :disabled="!form.name || !form.brandName">{{ t('下一步') }}</NButton>
      </NSpace>
    </NForm>

    <div v-if="currentStep === 2" style="margin-top: 24px">
      <p>{{ t('下一步将配置诊断问题集。现在先完成创建，之后可在问题规划页面配置。') }}</p>
      <NSpace justify="end">
        <NButton @click="currentStep = 1">{{ t('上一步') }}</NButton>
        <NButton @click="currentStep = 3">{{ t('下一步') }}</NButton>
      </NSpace>
    </div>

    <div v-if="currentStep === 3" style="margin-top: 24px">
      <p>{{ t('确认信息后创建诊断项目。创建后可以在问题规划页面配置四类诊断问题。') }}</p>
      <NSpace justify="end">
        <NButton @click="currentStep = 2">{{ t('上一步') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleCreate">{{ t('创建项目') }}</NButton>
      </NSpace>
    </div>
  </NCard>
</template>

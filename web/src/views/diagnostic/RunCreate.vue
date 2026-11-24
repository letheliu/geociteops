<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NSteps, NStep, NButton, NSpace, NCard, NCheckbox, NCheckboxGroup, NInputNumber, NInput, NTag, NSpin, useMessage } from 'naive-ui'
import { trpc } from '../../api/client'
import { calculateRequestUnits } from '../../domain/diagnostic'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const route = useRoute()
const router = useRouter()
const message = useMessage()

const projectId = route.params.projectId as string
const currentStep = ref(1)
const loading = ref(false)
const project = ref<any>(null)
const queries = ref<any[]>([])

const selectedQueryIds = ref<string[]>([])
const selectedPlatforms = ref<string[]>([])
const samplesPerQuery = ref(2)
const locale = ref('zh-CN')
const timezone = ref('Asia/Shanghai')

const requestUnits = computed(() =>
  calculateRequestUnits(selectedQueryIds.value.length, selectedPlatforms.value.length, samplesPerQuery.value)
)
const exceedsLimit = computed(() => requestUnits.value > 500)
const confirmedRunId = ref<string | null>(null)

onMounted(async () => {
  try {
    project.value = await (trpc as any).diagnostic.projects.get.query({ id: projectId })
    queries.value = await (trpc as any).diagnostic.queries.list.query({ projectId })
  } catch (err: any) {
    message.error(err.message)
  }
})

const confirmedQueries = computed(() => queries.value.filter((q: any) => q.status === 'CONFIRMED'))
const platforms = ['deepseek', 'doubao', 'qwen', 'ernie', 'perplexity', 'chatgpt', 'gemini', 'kimi', 'yuanbao']

async function handleCreateDraft() {
  loading.value = true
  try {
    const draft = await (trpc as any).diagnostic.runs.createDraft.mutate({
      projectId, queryIds: selectedQueryIds.value, platforms: selectedPlatforms.value,
      samplesPerQuery: samplesPerQuery.value, locale: locale.value, timezone: timezone.value,
    })
    await handleValidate((draft as any).id)
  } catch (err: any) {
    message.error(err.message)
  } finally {
    loading.value = false
  }
}

async function handleValidate(runId: string) {
  try {
    const result = await (trpc as any).diagnostic.runs.validate.query({ runId })
    if (result.valid) {
      await handleMarkReady(runId)
    } else {
      message.warning(result.errors.map((e: any) => e.message).join(', '))
    }
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleMarkReady(runId: string) {
  try {
    const ready = await (trpc as any).diagnostic.runs.markReady.mutate({ runId })
    confirmedRunId.value = (ready as any).id
    message.success(t("运行范围已冻结"))
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleStart() {
  if (!confirmedRunId.value) return
  loading.value = true
  try {
    await (trpc as any).diagnostic.runs.start.mutate({ runId: confirmedRunId.value })
    message.success(t("诊断已开始"))
    router.push({ name: 'diagnostic-run-progress', params: { runId: confirmedRunId.value } })
  } catch (err: any) {
    message.error(err.message)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <NCard :title="t('创建诊断运行')" style="max-width: 800px; margin: 0 auto">
    <NSteps :current="currentStep">
      <NStep :title="t('选择问题')" :description="t('至少一条确认 Query')" />
      <NStep :title="t('配置平台')" :description="t('平台与采样')" />
      <NStep :title="t('确认执行')" :description="t('冻结并开始')" />
    </NSteps>

    <div v-if="currentStep === 1" style="margin-top: 24px">
      <p>{{ t('已确认问题：') }}{{ confirmedQueries.length }} {{ t('条') }}</p>
      <NCheckboxGroup v-model:value="selectedQueryIds">
        <div v-for="q in confirmedQueries" :key="q.id">
          <NCheckbox :value="q.id" :label="`[${q.queryType}] ${q.queryText}`" />
        </div>
      </NCheckboxGroup>
      <NSpace justify="end" style="margin-top: 16px">
        <NButton @click="currentStep = 2" :disabled="selectedQueryIds.length === 0">{{ t('下一步') }}</NButton>
      </NSpace>
    </div>

    <div v-if="currentStep === 2" style="margin-top: 24px">
      <p>{{ t('选择平台（每个都需要配置凭证）') }}</p>
      <NCheckboxGroup v-model:value="selectedPlatforms">
        <div v-for="p in platforms" :key="p">
          <NCheckbox :value="p" :label="p" />
        </div>
      </NCheckboxGroup>
      <div style="margin-top: 16px">
        <p>{{ t('采样次数（1-3）：') }}<NInputNumber v-model:value="samplesPerQuery" :min="1" :max="3" /></p>
        <p>{{ t('语言：') }}<NInput v-model:value="locale" placeholder="zh-CN" /></p>
        <p>{{ t('时区：') }}<NInput v-model:value="timezone" placeholder="Asia/Shanghai" /></p>
      </div>
      <NSpace justify="end" style="margin-top: 16px">
        <NButton @click="currentStep = 1">{{ t('上一步') }}</NButton>
        <NButton @click="currentStep = 3" :disabled="selectedPlatforms.length === 0">{{ t('下一步') }}</NButton>
      </NSpace>
    </div>

    <div v-if="currentStep === 3" style="margin-top: 24px">
      <p>
        {{ selectedQueryIds.length }} Query × {{ selectedPlatforms.length }} {{ t('平台 ×') }} {{ samplesPerQuery }} {{ t('采样 =') }} <strong>{{ requestUnits }} {{ t('次请求') }}</strong>
      </p>
      <NTag v-if="exceedsLimit" type="error">{{ t('超过 500 次上限') }}</NTag>

      <div style="margin-top: 16px">
        <NButton v-if="!confirmedRunId" type="primary" :loading="loading" :disabled="exceedsLimit" @click="handleCreateDraft"> {{ t('验证并冻结范围') }} </NButton>
        <NButton v-else type="primary" :loading="loading" @click="handleStart"> {{ t('开始执行') }} </NButton>
      </div>
    </div>
  </NCard>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NSpace, NCard, NTag, NEmpty, NSpin, NSelect, useMessage } from 'naive-ui'
import { trpc } from '../../api/client'
import { DIAGNOSTIC_ACTION_HORIZON_LABELS } from '../../domain/diagnostic'

const message = useMessage()
const actions = ref<any[]>([])
const loading = ref(true)
const horizonFilter = ref<string | null>(null)

const HORIZONS = ['DAYS_30', 'DAYS_60', 'DAYS_90']

const groupedActions = ref<Record<string, any[]>>({})

async function loadActions() {
  loading.value = true
  try {
    actions.value = await (trpc as any).diagnostic.actions.list.query({ runId: '', horizon: horizonFilter.value || undefined })
    groupActions()
  } finally {
    loading.value = false
  }
}

function groupActions() {
  const groups: Record<string, any[]> = {}
  for (const h of HORIZONS) {
    groups[h] = actions.value.filter((a: any) => a.horizon === h)
  }
  groupedActions.value = groups
}

async function handleAccept(actionId: string) {
  try {
    await (trpc as any).diagnostic.actions.accept.mutate({ actionId })
    message.success('已接受')
    await loadActions()
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleDismiss(actionId: string) {
  try {
    await (trpc as any).diagnostic.actions.dismiss.mutate({ actionId })
    message.success('已忽略')
    await loadActions()
  } catch (err: any) {
    message.error(err.message)
  }
}

onMounted(loadActions)
</script>

<template>
  <NSpace vertical :size="16">
    <h2 style="margin: 0">行动中心</h2>

    <NSpace>
      <NSelect v-model:value="horizonFilter" :options="HORIZONS.map(h => ({ label: DIAGNOSTIC_ACTION_HORIZON_LABELS[h], value: h }))" placeholder="全部阶段" clearable style="width: 200px" />
    </NSpace>

    <NSpin :show="loading">
      <div v-for="h in HORIZONS" :key="h">
        <NCard v-if="groupedActions[h]?.length" :title="DIAGNOSTIC_ACTION_HORIZON_LABELS[h]" size="small" style="margin-bottom: 16px">
          <div v-for="a in groupedActions[h]" :key="a.id" style="padding: 8px 0; border-bottom: 1px solid #eee;">
            <NSpace vertical :size="8">
              <NSpace align="center">
                <strong>{{ a.title }}</strong>
                <NTag :type="a.status === 'ACCEPTED' ? 'success' : a.status === 'CONVERTED' ? 'info' : a.status === 'DISMISSED' ? 'default' : 'warning'" size="tiny">{{ a.status }}</NTag>
              </NSpace>
              <p style="margin: 0; color: #666;">{{ a.description }}</p>
              <NSpace v-if="a.status === 'PROPOSED'" :size="4">
                <NButton size="tiny" type="primary" @click="handleAccept(a.id)">接受</NButton>
                <NButton size="tiny" @click="handleDismiss(a.id)">忽略</NButton>
              </NSpace>
            </NSpace>
          </div>
        </NCard>
      </div>
      <NEmpty v-if="!groupedActions[HORIZONS[0]]?.length && !groupedActions[HORIZONS[1]]?.length && !groupedActions[HORIZONS[2]]?.length" description="暂无行动" />
    </NSpin>
  </NSpace>
</template>

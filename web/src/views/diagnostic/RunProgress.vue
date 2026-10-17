<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NCard, NProgress, NTag, NSpin, useMessage } from 'naive-ui'
import { useDiagnosticRun } from '../../composables/useDiagnosticRun'
import { DIAGNOSTIC_RUN_STATUS_COLORS } from '../../domain/diagnostic'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const runId = route.params.runId as string
const { run, loading, refresh, startPolling } = useDiagnosticRun(runId)

startPolling()

async function handleCancel() {
  try {
    const { trpc } = await import('../../api/client')
    await (trpc as any).diagnostic.runs.cancel.mutate({ runId })
    message.success('已取消')
    await refresh()
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleRetryFailed() {
  try {
    const { trpc } = await import('../../api/client')
    await (trpc as any).diagnostic.runs.retryFailed.mutate({ runId })
    message.success('已重试失败样本')
    await refresh()
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleRetryDispatch() {
  try {
    const { trpc } = await import('../../api/client')
    await (trpc as any).diagnostic.runs.retryDispatch.mutate({ runId })
    message.success('已重新派发')
    await refresh()
  } catch (err: any) {
    message.error(err.message)
  }
}
</script>

<template>
  <NSpin :show="loading">
    <div v-if="run">
      <NSpace vertical :size="16">
        <h2 style="margin: 0">运行进度</h2>

        <NCard size="small">
          <NSpace vertical>
            <NSpace justify="space-between">
              <span>状态：<NTag :type="DIAGNOSTIC_RUN_STATUS_COLORS[run.status]" size="small">{{ run.status }}</NTag></span>
              <NSpace>
                <NButton v-if="run.status === 'RUNNING'" size="small" @click="handleCancel">取消</NButton>
                <NButton v-if="run.dispatchStatus === 'FAILED'" size="small" @click="handleRetryDispatch">重试派发</NButton>
                <NButton v-if="['PARTIAL', 'FAILED'].includes(run.status)" size="small" @click="handleRetryFailed">重试失败</NButton>
                <NButton v-if="['COMPLETED', 'PARTIAL'].includes(run.status)" size="small" type="primary" @click="router.push({ name: 'diagnostic-report', params: { runId } })">
                  查看报告
                </NButton>
              </NSpace>
            </NSpace>
            <NProgress :value="run.totalUnits > 0 ? (run.completedUnits / run.totalUnits) * 100 : 0" :indicator-placement="'inside'" />
            <span>{{ run.completedUnits || 0 }} / {{ run.totalUnits || 0 }} 完成，{{ run.failedUnits || 0 }} 失败</span>
          </NSpace>
        </NCard>
      </NSpace>
    </div>
  </NSpin>
</template>

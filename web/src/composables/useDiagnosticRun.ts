import { ref, onMounted, onUnmounted, watch } from 'vue'
import { trpc } from '../api/client'

const TERMINAL_STATUSES = ['PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED']

export function useDiagnosticRun(runId: string) {
  const run = ref<any>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let isPolling = false

  async function refresh() {
    if (!runId) return
    loading.value = true
    error.value = null
    try {
      run.value = await (trpc as any).diagnostic.runs.get.query({ runId })
      if (run.value && TERMINAL_STATUSES.includes(run.value.status)) {
        stopPolling()
      }
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  function startPolling() {
    if (isPolling) return
    isPolling = true
    const interval = document.hidden ? 15000 : 3000
    pollTimer = setInterval(async () => {
      if (!runId) return
      try {
        const updated = await (trpc as any).diagnostic.runs.get.query({ runId })
        run.value = updated
        if (TERMINAL_STATUSES.includes(updated.status)) {
          stopPolling()
        }
      } catch {
        // silent
      }
    }, interval)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    isPolling = false
  }

  function handleVisibilityChange() {
    if (!isPolling) return
    stopPolling()
    startPolling()
  }

  onMounted(() => {
    refresh()
    document.addEventListener('visibilitychange', handleVisibilityChange)
  })

  onUnmounted(() => {
    stopPolling()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  })

  return { run, loading, error, refresh, startPolling, stopPolling }
}

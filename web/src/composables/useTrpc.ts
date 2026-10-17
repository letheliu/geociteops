import { ref } from 'vue'
import { trpc } from '../api/client'

export function useTrpcQuery<T>(
  fetcher: (client: typeof trpc) => Promise<T>,
  options?: { immediate?: boolean },
) {
  const data = ref<T | null>(null)
  const error = ref<Error | null>(null)
  const loading = ref(false)

  async function execute() {
    loading.value = true
    error.value = null
    try {
      data.value = await fetcher(trpc)
    } catch (e: any) {
      error.value = e
    } finally {
      loading.value = false
    }
  }

  if (options?.immediate !== false) {
    execute()
  }

  return { data, error, loading, execute, refresh: execute }
}

export function useTrpcMutation<TInput, TOutput>(
  mutator: (client: typeof trpc, input: TInput) => Promise<TOutput>,
) {
  const data = ref<TOutput | null>(null)
  const error = ref<Error | null>(null)
  const loading = ref(false)

  async function mutate(input: TInput) {
    loading.value = true
    error.value = null
    try {
      data.value = await mutator(trpc, input)
      return data.value
    } catch (e: any) {
      error.value = e
      throw e
    } finally {
      loading.value = false
    }
  }

  return { data, error, loading, mutate }
}

export { trpc }

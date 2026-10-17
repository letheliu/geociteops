<script setup lang="ts">
import { computed } from 'vue'
import { NCode } from 'naive-ui'

const props = defineProps<{ data: any }>()

const text = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})
</script>

<template>
  <pre style="background: var(--code-color); padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; max-height: 400px; margin: 0"><NCode :code="text" language="json" /></pre>
</template>

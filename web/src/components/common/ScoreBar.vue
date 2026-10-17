<script setup lang="ts">
import { computed } from 'vue'
import { NProgress } from 'naive-ui'

const props = defineProps<{ score: number }>()

const color = computed(() => {
  if (props.score >= 80) return '#18a058'
  if (props.score >= 60) return '#f0a020'
  return '#d03050'
})
</script>

<template>
  <div style="display: flex; align-items: center; gap: 8px; min-width: 120px">
    <NProgress
      type="line"
      :percentage="score"
      :color="color"
      :rail-color="color + '20'"
      :show-indicator="false"
      style="flex: 1"
    />
    <span :style="{ color, fontWeight: 600, fontSize: '13px', minWidth: '32px' }">{{ score }}</span>
  </div>
</template>

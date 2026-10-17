<script setup lang="ts">
import { NPageHeader } from 'naive-ui'
import { useRouter } from 'vue-router'

defineProps<{ title: string; subtitle?: string }>()

const router = useRouter()
</script>

<template>
  <div style="margin-bottom: 20px">
    <h2 style="margin: 0; font-size: 20px; font-weight: 600">{{ title }}</h2>
    <p v-if="subtitle" style="margin: 4px 0 0; font-size: 13px; color: var(--text-color-3)">{{ subtitle }}</p>
  </div>
</template>

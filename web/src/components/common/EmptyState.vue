<script setup lang="ts">
import { NEmpty } from 'naive-ui'

defineProps<{ description?: string }>()
</script>

<template>
  <div style="padding: 48px 0">
    <NEmpty :description="description || '暂无数据'" />
  </div>
</template>

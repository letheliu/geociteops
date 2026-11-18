<script setup lang="ts">
import { NEmpty } from 'naive-ui'
import { useI18n } from '@/i18n'
const { t } = useI18n()


defineProps<{ description?: string }>()
</script>

<template>
  <div style="padding: 48px 0">
    <NEmpty :description="description || t('暂无数据')" />
  </div>
</template>

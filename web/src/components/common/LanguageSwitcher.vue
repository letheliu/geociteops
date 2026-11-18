<script setup lang="ts">
import { NSelect } from 'naive-ui'
import { useI18n, type AppLocale } from '@/i18n'

const { locale, setLocale } = useI18n()

const options = [
  { label: '中文', value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
]

function handleChange(value: AppLocale) {
  setLocale(value)
}
</script>

<template>
  <NSelect
    :value="locale"
    :options="options"
    size="small"
    style="width: 108px"
    :consistent-menu-width="false"
    @update:value="handleChange"
  />
</template>

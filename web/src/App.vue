<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterView } from 'vue-router'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NLoadingBarProvider,
  darkTheme,
  zhCN,
  dateZhCN,
} from 'naive-ui'
import { useAppStore } from './stores/app'

const appStore = useAppStore()

const theme = computed(() => (appStore.darkMode ? darkTheme : null))

watch(
  () => appStore.darkMode,
  (val) => {
    localStorage.setItem('geo-dark-mode', val ? '1' : '0')
  },
)
</script>

<template>
  <NConfigProvider :theme="theme" :locale="zhCN" :date-locale="dateZhCN">
    <NLoadingBarProvider>
      <NMessageProvider>
        <NDialogProvider>
          <RouterView />
        </NDialogProvider>
      </NMessageProvider>
    </NLoadingBarProvider>
  </NConfigProvider>
</template>

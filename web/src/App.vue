<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NLoadingBarProvider,
  darkTheme,
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
} from 'naive-ui'
import { useAppStore } from './stores/app'
import { useI18n } from './i18n'
import { router, updateDocumentTitle } from './router'
import LanguageSwitcher from './components/common/LanguageSwitcher.vue'

const appStore = useAppStore()
const route = useRoute()
const { locale } = useI18n()

const theme = computed(() => (appStore.darkMode ? darkTheme : null))
const naiveLocale = computed(() => (locale.value === 'en-US' ? enUS : zhCN))
const naiveDateLocale = computed(() => (locale.value === 'en-US' ? dateEnUS : dateZhCN))

watch(
  () => appStore.darkMode,
  (val) => {
    localStorage.setItem('geo-dark-mode', val ? '1' : '0')
  },
)

watch(
  locale,
  (val) => {
    document.documentElement.lang = val
    updateDocumentTitle(router.currentRoute.value.name)
  },
  { immediate: true },
)
</script>

<template>
  <NConfigProvider :theme="theme" :locale="naiveLocale" :date-locale="naiveDateLocale">
    <NLoadingBarProvider>
      <NMessageProvider>
        <NDialogProvider>
          <RouterView :key="locale" />
          <LanguageSwitcher v-if="route.meta.public" class="public-locale-switcher" />
        </NDialogProvider>
      </NMessageProvider>
    </NLoadingBarProvider>
  </NConfigProvider>
</template>

<style>
.public-locale-switcher {
  position: fixed;
  top: 16px;
  right: 20px;
  z-index: 1000;
}
</style>

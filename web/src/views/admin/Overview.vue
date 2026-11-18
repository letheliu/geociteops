<script setup lang="ts">
// 平台管理总览：欢迎信息 + 占位（订单与收款看板 P2 上线）
import { computed } from 'vue'
import { NCard, NSpace, NText } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { useSessionStore } from '../../stores/session'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const sessionStore = useSessionStore()

const displayName = computed(() => {
  const me = sessionStore.me
  return me ? me.displayName || me.username : ''
})
</script>

<template>
  <div>
    <PageHeader :title="t('平台管理')" :subtitle="t('总览')" />

    <NSpace vertical :size="16">
      <NCard>
        <template #header>{{ t('欢迎，') }}{{ displayName }}</template> {{ t('从左侧菜单进入 Workspace 管理、员工账号与审计日志。') }} </NCard>

      <NCard :title="t('订单与收款')">
        <NText depth="3">{{ t('订单与收款看板将在 P2 上线。') }}</NText>
      </NCard>
    </NSpace>
  </div>
</template>

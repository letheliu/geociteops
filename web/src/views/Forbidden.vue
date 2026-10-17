<script setup lang="ts">
// 403 页（公开）：守卫两类越界都落这里——客户误入 /admin（requires: 'platform'）、
// 平台用户误入 /console 首页（requires: 'customer'）。返回按钮按会话身份分流：
// 客户回 /console（控制台首页），平台用户/未知身份回 /admin（由守卫重判）。
import { NResult, NButton } from 'naive-ui'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const sessionStore = useSessionStore()

const homePath = computed(() => (sessionStore.isCustomer ? '/console' : '/admin'))
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--body-color)">
    <NResult
      status="403"
      title="无权访问"
      description="当前账号没有访问该页面的权限。"
    >
      <template #footer>
        <NButton @click="router.push(homePath)">返回</NButton>
      </template>
    </NResult>
  </div>
</template>

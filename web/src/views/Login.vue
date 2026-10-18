<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCard, NForm, NFormItem, NInput, NSpace, NText, useMessage } from 'naive-ui'
import { trpc } from '../composables/useTrpc'
import { useSessionStore } from '../stores/session'
import { postLoginTarget } from '../utils/post-login'

const router = useRouter()
const route = useRoute()
const message = useMessage()
const sessionStore = useSessionStore()

const form = ref({ username: '', password: '' })
const loading = ref(false)

/** 自助注册入口显隐（M2 §3.0）：服务端 auth.registrationEnabled 为 false 时不展示 */
const registrationEnabled = ref(false)

onMounted(async () => {
  try {
    registrationEnabled.value = await trpc.auth.registrationEnabled.query()
  } catch {
    registrationEnabled.value = false
  }
})

async function handleLogin() {
  const username = form.value.username.trim()
  if (!username || !form.value.password) {
    message.warning('请输入用户名和密码')
    return
  }
  loading.value = true
  try {
    await sessionStore.login(username, form.value.password)
    // 落点按 userType 分治（规格 §4.1）；mustChangePassword 由路由守卫接管跳转
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    router.push(postLoginTarget(sessionStore.me, redirect))
  } catch (e: any) {
    message.error(e?.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--body-color)">
    <NCard style="width: 420px; max-width: 90vw" title="GEO Console" size="medium">
      <NForm @submit.prevent="handleLogin">
        <NFormItem label="用户名">
          <NInput
            v-model:value="form.username"
            placeholder="用户名"
            :input-props="{ autocomplete: 'username' }"
          />
        </NFormItem>
        <NFormItem label="密码">
          <NInput
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="密码"
            :input-props="{ autocomplete: 'current-password' }"
          />
        </NFormItem>
        <NButton type="primary" block :loading="loading" @click="handleLogin">登录</NButton>
        <NSpace v-if="registrationEnabled" justify="center" align="center" :size="6">
          <NText depth="3" style="font-size: 13px">还没有账号？</NText>
          <NButton text type="primary" @click="router.push({ name: 'register' })">注册试用</NButton>
        </NSpace>
      </NForm>
    </NCard>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NButton, NAlert, useMessage } from 'naive-ui'
import { trpc } from '../composables/useTrpc'
import { useSessionStore } from '../stores/session'
import { postLoginTarget } from '../utils/post-login'

/** 与服务端密码策略对齐（src/core/auth/password.ts）：长度 ≥10，不含用户名 */
const MIN_LENGTH = 10

const router = useRouter()
const route = useRoute()
const message = useMessage()
const sessionStore = useSessionStore()

const form = ref({ oldPassword: '', newPassword: '', confirmPassword: '' })
const loading = ref(false)

const forced = () => !!sessionStore.me?.mustChangePassword

async function handleSubmit() {
  const { oldPassword, newPassword, confirmPassword } = form.value
  if (!oldPassword) {
    message.warning('请输入当前密码')
    return
  }
  if (newPassword.length < MIN_LENGTH) {
    message.warning(`新密码长度不足，至少 ${MIN_LENGTH} 位`)
    return
  }
  const username = sessionStore.me?.username ?? ''
  if (username && (newPassword === username || newPassword.toLowerCase().includes(username.toLowerCase()))) {
    message.warning('新密码不能与用户名相同或包含用户名')
    return
  }
  if (newPassword !== confirmPassword) {
    message.warning('两次输入的新密码不一致')
    return
  }
  loading.value = true
  try {
    await trpc.auth.changePassword.mutate({ oldPassword, newPassword })
    // 改密成功：服务端已换发会话 Cookie，刷新 me 使 mustChangePassword 归 false
    await sessionStore.fetchMe()
    message.success('密码已修改')
    // 改密后落点与登录一致：redirect 优先，否则按 userType 分治（规格 §4.1）
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    router.push(postLoginTarget(sessionStore.me, redirect))
  } catch (e: any) {
    message.error(e?.message || '修改失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--body-color)">
    <NCard style="width: 460px; max-width: 90vw" title="修改密码" size="medium">
      <NAlert v-if="forced()" type="warning" :show-icon="true" style="margin-bottom: 16px">
        当前使用临时密码，修改密码后方可进入系统
      </NAlert>
      <NForm @submit.prevent="handleSubmit">
        <NFormItem label="当前密码">
          <NInput
            v-model:value="form.oldPassword"
            type="password"
            show-password-on="click"
            placeholder="当前密码"
            :input-props="{ autocomplete: 'current-password' }"
          />
        </NFormItem>
        <NFormItem label="新密码">
          <NInput
            v-model:value="form.newPassword"
            type="password"
            show-password-on="click"
            :placeholder="`至少 ${MIN_LENGTH} 位，且不包含用户名`"
            :input-props="{ autocomplete: 'new-password' }"
          />
        </NFormItem>
        <NFormItem label="确认新密码">
          <NInput
            v-model:value="form.confirmPassword"
            type="password"
            show-password-on="click"
            placeholder="再次输入新密码"
            :input-props="{ autocomplete: 'new-password' }"
          />
        </NFormItem>
        <NButton type="primary" block :loading="loading" @click="handleSubmit">提交修改</NButton>
      </NForm>
    </NCard>
  </div>
</template>

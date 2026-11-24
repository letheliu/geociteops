<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NText, useMessage } from 'naive-ui'
import { trpc } from '../composables/useTrpc'
import { useSessionStore } from '../stores/session'
import { postLoginTarget } from '../utils/post-login'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const router = useRouter()
const route = useRoute()
const message = useMessage()
const sessionStore = useSessionStore()

const form = ref({ username: '', password: '' })
const loading = ref(false)

/** 自助注册入口显隐（M2 §3.0）：服务端 auth.registrationEnabled 为 false 时不展示 */
const registrationEnabled = ref(false)

/** 公开演示（DEMO_MODE）。密码不在这个响应里。 */
const demoStatus = ref<{ enabled: boolean; username: string | null; note: string | null } | null>(null)

onMounted(async () => {
  try {
    registrationEnabled.value = await trpc.auth.registrationEnabled.query()
  } catch {
    registrationEnabled.value = false
  }
  try {
    const status = await trpc.auth.demoStatus.query()
    demoStatus.value = status
    if (status.enabled && status.username && !form.value.username) {
      form.value.username = status.username
    }
  } catch {
    demoStatus.value = null
  }
})

async function handleLogin() {
  const username = form.value.username.trim()
  if (!username || !form.value.password) {
    message.warning(t("请输入用户名和密码"))
    return
  }
  loading.value = true
  try {
    await sessionStore.login(username, form.value.password)
    // 落点按 userType 分治（规格 §4.1）；mustChangePassword 由路由守卫接管跳转
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    router.push(postLoginTarget(sessionStore.me, redirect))
  } catch (e: any) {
    message.error(e?.message || t("登录失败"))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--body-color)">
    <NCard style="width: 420px; max-width: 90vw" title="GEO Console" size="medium">
      <NAlert v-if="demoStatus?.enabled" type="info" :bordered="false" style="margin-bottom: 16px">
        {{ t('这是公开只读演示。用户名是 {username}。密码由部署这套实例的人设置，仓库里没有保存密码。', { username: demoStatus.username ?? '' }) }}
        <div v-if="demoStatus.note">{{ t('部署者留下的登录说明：{hint}', { hint: demoStatus.note }) }}</div>
      </NAlert>
      <NForm @submit.prevent="handleLogin">
        <NFormItem :label="t('用户名')">
          <NInput
            v-model:value="form.username"
            :placeholder="t('用户名')"
            :input-props="{ autocomplete: 'username' }"
          />
        </NFormItem>
        <NFormItem :label="t('密码')">
          <NInput
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            :placeholder="t('密码')"
            :input-props="{ autocomplete: 'current-password' }"
          />
        </NFormItem>
        <NButton type="primary" block :loading="loading" @click="handleLogin">{{ t('登录') }}</NButton>
        <NSpace v-if="registrationEnabled && !demoStatus?.enabled" justify="center" align="center" :size="6">
          <NText depth="3" style="font-size: 13px">{{ t('还没有账号？') }}</NText>
          <NButton text type="primary" @click="router.push({ name: 'register' })">{{ t('注册试用') }}</NButton>
        </NSpace>
      </NForm>
    </NCard>
  </div>
</template>

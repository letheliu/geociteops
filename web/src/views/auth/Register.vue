<script setup lang="ts">
// 自助注册（M2 §3.0）：访客填 4 个字段 → 服务端开 7 天试用租户 → 直接进工作台。
// - 字段校验与服务端 zod schema 对齐（username 3..64 / email 可选格式 / password 非空 / brandName ≤64）；
// - 注册开关随 auth.registrationEnabled 显隐：关闭时本页只显示关闭文案，不提交；
// - 注册成功服务端已签发登录态（Set-Cookie），此处只需刷新 me 并按登录后的落点跳转。
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NText, useMessage } from 'naive-ui'
import { trpc } from '../../composables/useTrpc'
import { useSessionStore } from '../../stores/session'
import { postLoginTarget } from '../../utils/post-login'

const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()

/** 与服务端 usernameSchema（src/platform/identity/username-schema.ts）同口径 */
const USERNAME_MIN = 3
const USERNAME_MAX = 64

const registrationEnabled = ref<boolean | null>(null)
const loading = ref(false)
const form = ref({ username: '', email: '', password: '', brandName: '' })

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function loadRegistrationEnabled() {
  try {
    registrationEnabled.value = await trpc.auth.registrationEnabled.query()
  } catch {
    // 探测失败按"关闭"处理：宁可少一个入口，也不要让用户填完表单才被拒
    registrationEnabled.value = false
  }
}

onMounted(loadRegistrationEnabled)

function validate(): string | null {
  const username = form.value.username.trim()
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return `用户名长度需在 ${USERNAME_MIN}-${USERNAME_MAX} 位`
  }
  const email = form.value.email.trim()
  if (email && !EMAIL_PATTERN.test(email)) return '邮箱格式不正确'
  if (!form.value.password) return '请输入密码'
  return null
}

async function handleRegister() {
  if (!registrationEnabled.value) return
  const invalid = validate()
  if (invalid) {
    message.warning(invalid)
    return
  }
  loading.value = true
  try {
    const email = form.value.email.trim()
    const brandName = form.value.brandName.trim()
    await trpc.auth.register.mutate({
      username: form.value.username.trim(),
      password: form.value.password,
      ...(email ? { email } : {}),
      ...(brandName ? { brandName } : {}),
    })
    // 注册即登录（服务端 Set-Cookie）：刷新 me 后走与登录相同的落点规则
    await sessionStore.fetchMe()
    router.push(postLoginTarget(sessionStore.me))
  } catch (e: any) {
    message.error(e?.message || '注册失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--body-color)">
    <NCard style="width: 460px; max-width: 90vw" title="注册试用" size="medium">
      <template #header-extra>
        <NButton text type="primary" @click="router.push({ name: 'login' })">已有账号，登录</NButton>
      </template>

      <NSpace vertical :size="12">
        <NAlert v-if="registrationEnabled === false" type="warning" :bordered="false">
          当前未开放自助注册，请联系平台开通。
        </NAlert>

        <template v-else>
          <NText depth="3" style="font-size: 13px">
            注册即开通 7 天试用租户：1 个工作区、10 条查询、单次监测采样上限 3。试用到期后数据保留为只读。
          </NText>
          <NForm @submit.prevent="handleRegister">
            <NFormItem label="用户名">
              <NInput
                v-model:value="form.username"
                placeholder="3-64 位，注册后不可修改"
                :input-props="{ autocomplete: 'username' }"
              />
            </NFormItem>
            <NFormItem label="邮箱（可选）">
              <NInput
                v-model:value="form.email"
                placeholder="仅作为联系方式，不做验证"
                :input-props="{ autocomplete: 'email' }"
              />
            </NFormItem>
            <NFormItem label="密码">
              <NInput
                v-model:value="form.password"
                type="password"
                show-password-on="click"
                placeholder="至少 8 位，含大小写字母与数字"
                :input-props="{ autocomplete: 'new-password' }"
              />
            </NFormItem>
            <NFormItem label="品牌名（可选）">
              <NInput v-model:value="form.brandName" placeholder="缺省与用户名相同" />
            </NFormItem>
            <NButton
              type="primary"
              block
              :loading="loading"
              :disabled="registrationEnabled !== true"
              @click="handleRegister"
            >
              注册并开通试用
            </NButton>
          </NForm>
        </template>
      </NSpace>
    </NCard>
  </div>
</template>

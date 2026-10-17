<script setup lang="ts">
// 控制台布局：console 首页/企业设置页/服务与购买页（任务 8/9/14）由本布局的轻顶栏承载——
// 企业名 + 顶部横向菜单（任务 14 起：总览 / 服务与购买 / 企业设置三组）+ 用户菜单
// （改密/退出，模式照 WorkspaceLayout 但无 workspace 切换）。
// /console/w/:workspaceId 下由 WorkspaceLayout 自带完整壳（占满 100vh），
// 此时本布局退化为纯 RouterView，避免出现双层顶栏。
import { computed, ref, watch } from 'vue'
import {
  NButton, NDropdown, NLayout, NLayoutContent, NLayoutHeader, NMenu, NSpace, NSwitch, NText,
} from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useSessionStore } from '../stores/session'
import headerLogo from '../assets/geociteops-header.svg'

const appStore = useAppStore()
const sessionStore = useSessionStore()
const router = useRouter()
const route = useRoute()

// 工作台子树（WorkspaceLayout 自带完整布局），本布局不再包壳
const inWorkspace = computed(() => route.params.workspaceId !== undefined)

// 企业名（requires:'customer' 守卫保证到这里的必是客户，me().organization 恒有值；兜底文案）
const orgName = computed(() => sessionStore.me?.organization?.name ?? '企业控制台')

// 点击左侧区域回控制台首页
function goHome() {
  router.push({ name: 'console-home' })
}

// 右上角用户菜单（同 WorkspaceLayout / AdminLayout：改密 / 退出）
const userOptions = [
  { label: '修改密码', key: 'change-password' },
  { label: '退出登录', key: 'logout' },
]

function handleUserAction(key: string) {
  if (key === 'change-password') {
    router.push('/change-password')
  } else if (key === 'logout') {
    sessionStore.logout()
  }
}

// ===== 顶部菜单（任务 14）：三组导航，叶子节点 key 即路由名 =====
// 成员管理/API 凭证仅 ORG_OWNER（org.manage/credential.write），非 OWNER 不显示；
// 我的订单仅非 ORG_VIEWER（order.view 对 VIEWER 恒拒，下单/看单均无权限）——
// 服务商城对 VIEWER 保留可见（catalog.list 为 authed 可看，浏览免费，下单按钮
// 已按 orgRole 隐藏）；Billing/Invoices 任意客户角色可见（orgProcedure()）；
// 点击由 handleMenuSelect 统一按路由名跳转
const menuOptions = computed<MenuOption[]>(() => [
  { label: '总览', key: 'console-home' },
  {
    label: '服务与购买',
    key: 'purchase',
    children: [
      { label: '服务商城', key: 'console-services' },
      ...(sessionStore.isOrgViewer ? [] : [{ label: '我的订单', key: 'console-orders' }]),
      { label: '我的服务', key: 'console-billing' },
      { label: '发票管理', key: 'console-invoices' },
    ],
  },
  {
    label: '企业设置',
    key: 'settings',
    children: [
      { label: '企业信息', key: 'console-org-info' },
      ...(sessionStore.isOrgOwner
        ? [
            { label: '成员管理', key: 'console-members' },
            { label: 'API 凭证', key: 'console-credentials' },
          ]
        : []),
    ],
  },
])

// 当前激活叶子 = 当前路由名（非本菜单命中的路由不高亮任何项）
const menuValue = ref<string | null>((route.name as string) ?? null)
watch(
  () => route.name,
  (name) => {
    menuValue.value = typeof name === 'string' && name.startsWith('console-') ? name : null
  },
  { immediate: true },
)

function handleMenuSelect(key: string) {
  router.push({ name: key })
}
</script>

<template>
  <RouterView v-if="inWorkspace" />
  <NLayout v-else style="height: 100vh">
    <NLayoutHeader
      bordered
      style="height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; gap: 12px"
    >
      <NSpace
        align="center"
        :size="10"
        :wrap="false"
        style="cursor: pointer; min-width: 0; overflow: hidden"
        @click="goHome"
      >
        <div
          style="width: 30px; height: 30px; overflow: hidden; display: flex; align-items: center; justify-content: flex-start; flex-shrink: 0"
        >
          <img :src="headerLogo" alt="GeoCiteOps" style="height: 30px; width: auto; flex-shrink: 0">
        </div>
        <NText strong style="font-size: 15px">{{ orgName }}</NText>
        <NText depth="3" style="font-size: 12px">企业控制台</NText>
      </NSpace>
      <NSpace align="center" :wrap="false">
        <NDropdown :options="userOptions" @select="handleUserAction">
          <NButton size="small" quaternary>
            {{ sessionStore.me ? (sessionStore.me.displayName || sessionStore.me.username) : '未登录' }}
          </NButton>
        </NDropdown>
        <NSwitch :value="appStore.darkMode" size="small" @update:value="appStore.toggleDarkMode">
          <template #checked>暗色</template>
          <template #unchecked>亮色</template>
        </NSwitch>
      </NSpace>
    </NLayoutHeader>
    <!-- 顶部导航（任务 14）：服务与购买 / 企业设置分组；叶子点击按路由名跳转 -->
    <div style="padding: 0 24px; border-bottom: 1px solid var(--border-color)">
      <NMenu
        mode="horizontal"
        :value="menuValue"
        :options="menuOptions"
        @update:value="handleMenuSelect"
      />
    </div>
    <NLayoutContent content-style="overflow: auto;">
      <RouterView />
    </NLayoutContent>
  </NLayout>
</template>

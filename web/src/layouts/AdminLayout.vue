<script setup lang="ts">
// 平台管理布局：侧边菜单（概览/Workspace/员工/审计 + 商业域分组）+ Header（displayName + 下拉菜单）。
// 结构照 WorkspaceLayout.vue 的 sider 骨架。
import { h, computed } from 'vue'
import {
  NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NSwitch, NSpace,
  NDropdown, NButton,
} from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { RouterView, useRouter, useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useSessionStore } from '../stores/session'
import headerLogo from '../assets/geociteops-header.svg'

const appStore = useAppStore()
const sessionStore = useSessionStore()
const router = useRouter()
const route = useRoute()

function renderIcon(emoji: string) {
  return () => h('span', { style: { fontSize: '16px' } }, emoji)
}

// key = 路由名；detail 页归并高亮到列表项
const baseMenuOptions: MenuOption[] = [
  { label: '概览', key: 'admin-overview', icon: renderIcon('🛠️') } as MenuOption,
  { label: 'Workspace 管理', key: 'admin-workspaces', icon: renderIcon('🗂️') } as MenuOption,
  { label: '员工账号', key: 'admin-users', icon: renderIcon('👥') } as MenuOption,
  { label: '审计日志', key: 'admin-audit-log', icon: renderIcon('📜') } as MenuOption,
]

/**
 * 商业域菜单（任务 15）：按权限点渲染——OPERATOR: 订单中心（order.manage）；
 * FINANCE: 订单中心/收款确认/退款管理/发票管理（order.view + payment.confirm +
 * refund.manage + invoice.manage）；SUPER_ADMIN: 全部；SUPPORT: 订单中心（order.view 只读）。
 * 基础四项（概览/Workspace/员工/审计）不在映射表内 = 全平台角色可见（P1 行为不变）。
 */
type PlatformRoleValue = 'SUPER_ADMIN' | 'OPERATOR' | 'FINANCE' | 'SUPPORT'

const MENU_VISIBILITY: Record<string, PlatformRoleValue[]> = {
  'admin-orders': ['OPERATOR', 'FINANCE', 'SUPER_ADMIN', 'SUPPORT'],
  'admin-payments': ['FINANCE', 'SUPER_ADMIN'],
  'admin-refunds': ['FINANCE', 'SUPER_ADMIN'],
  'admin-invoices': ['FINANCE', 'SUPER_ADMIN'],
  'admin-catalog': ['SUPER_ADMIN'],
}

const commerceMenuOptions: MenuOption[] = [
  { label: '订单中心', key: 'admin-orders', icon: renderIcon('📦') } as MenuOption,
  { label: '收款确认', key: 'admin-payments', icon: renderIcon('💰') } as MenuOption,
  { label: '退款管理', key: 'admin-refunds', icon: renderIcon('↩️') } as MenuOption,
  { label: '发票管理', key: 'admin-invoices', icon: renderIcon('🧾') } as MenuOption,
  { label: '服务目录', key: 'admin-catalog', icon: renderIcon('🛍️') } as MenuOption,
]

const platformRole = computed<PlatformRoleValue | null>(() => sessionStore.me?.platformRole ?? null)

const menuOptions = computed<MenuOption[]>(() => {
  const visible = commerceMenuOptions.filter((option) => {
    const key = String((option as { key?: string | number }).key ?? '')
    return platformRole.value !== null && (MENU_VISIBILITY[key] ?? []).includes(platformRole.value)
  })
  if (visible.length === 0) return baseMenuOptions
  return [
    ...baseMenuOptions,
    { type: 'divider', key: 'divider-commerce' } as MenuOption,
    ...visible,
  ]
})

const activeKey = computed(() => {
  const name = route.name as string
  if (name.startsWith('admin-workspace')) return 'admin-workspaces'
  if (name.startsWith('admin-order')) return 'admin-orders'
  return name
})

function handleMenuUpdate(key: string) {
  router.push({ name: key })
}

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
</script>

<template>
  <NLayout has-sider style="height: 100vh">
    <NLayoutSider
      bordered
      :collapsed="appStore.collapsed"
      collapse-mode="width"
      :collapsed-width="64"
      :width="220"
      show-trigger
      @collapse="appStore.collapsed = true"
      @expand="appStore.collapsed = false"
    >
      <div style="padding: 12px 16px; display: flex; align-items: center; justify-content: center">
        <img
          v-if="!appStore.collapsed"
          :src="headerLogo"
          alt="GeoCiteOps"
          style="width: 100%; max-width: 188px; height: auto; display: block; border-radius: 10px"
        >
        <div
          v-else
          style="width: 40px; height: 40px; overflow: hidden; display: flex; align-items: center; justify-content: flex-start; border-radius: 10px; flex-shrink: 0"
        >
          <img :src="headerLogo" alt="GeoCiteOps" style="height: 40px; width: auto; flex-shrink: 0">
        </div>
      </div>
      <NMenu
        :value="activeKey"
        :collapsed="appStore.collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="18"
        :options="menuOptions"
        @update:value="handleMenuUpdate"
      />
    </NLayoutSider>
    <NLayout>
      <NLayoutHeader bordered style="height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; gap: 12px">
        <NSpace align="center" :size="6">
          <span style="font-size: 13px; color: var(--text-color-3)">平台管理</span>
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
      <NLayoutContent style="padding: 24px" content-style="overflow: auto;">
        <RouterView />
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>

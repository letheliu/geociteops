<script setup lang="ts">
import { h, computed, ref, watch } from 'vue'
import {
  NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NSwitch, NButton, NSpace, NText,
  NDropdown, NAlert, NSelect,
} from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { RouterView, useRouter, useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'
import { useSessionStore } from '../stores/session'
import { trpc } from '../composables/useTrpc'
import headerLogo from '../assets/geociteops-header.svg'

const appStore = useAppStore()
const sessionStore = useSessionStore()
const router = useRouter()
const route = useRoute()

// 当前工作区基础信息（会话通道下经 x-workspace-id 头由 workspace.get 返回）。
// watch route.params.workspaceId（immediate）替代 onMounted：/console/w/a → /console/w/b
// 时 vue-router 复用组件实例，onMounted 不会重跑；fetchSeq 序号防竞态——仅当最新
// 一次发出的请求返回才生效，旧请求的迟到结果直接丢弃（简单节流，无需 abort）。
const workspaceName = ref('')
const workspaceDomain = ref('')
let fetchSeq = 0

watch(
  () => route.params.workspaceId as string | undefined,
  async (workspaceId) => {
    const seq = ++fetchSeq
    workspaceName.value = ''
    workspaceDomain.value = ''
    if (!workspaceId) return
    try {
      const ws = await trpc.workspace.get.query()
      if (seq !== fetchSeq) return
      workspaceName.value = ws?.name || ''
      workspaceDomain.value = ws?.domain || ''
    } catch {
      if (seq !== fetchSeq) return
      workspaceName.value = ''
      workspaceDomain.value = ''
    }
  },
  { immediate: true },
)

function renderIcon(emoji: string) {
  return () => h('span', { style: { fontSize: '16px' } }, emoji)
}

const menuOptions: MenuOption[] = [
  {
    label: '概览',
    key: 'dashboard',
    icon: renderIcon('📊'),
  } as MenuOption,
  {
    label: '引用监测',
    key: 'citation-group',
    type: 'group',
    children: [
      { label: '查询库', key: 'citation-queries', icon: renderIcon('🔍') } as MenuOption,
      { label: '引用报告', key: 'citation-reports', icon: renderIcon('📋') } as MenuOption,
      { label: 'SOV 分析', key: 'citation-sov', icon: renderIcon('📈') } as MenuOption,
      // 引用覆盖矩阵(PUBLISHED 页 × 平台,盲区/域级证据/意图落空)
      { label: '引用覆盖', key: 'citation-coverage', icon: renderIcon('🧭') } as MenuOption,
      { label: '效果对比', key: 'citation-effect', icon: renderIcon('⚖️') } as MenuOption,
      // M2 §3.3 闭环看板
      { label: '闭环看板', key: 'citation-loop', icon: renderIcon('🔁') } as MenuOption,
    ],
  },
  {
    label: '内容优化',
    key: 'content-group',
    type: 'group',
    children: [
      { label: '内容页面', key: 'content-pages', icon: renderIcon('📄') } as MenuOption,
      { label: '优化任务', key: 'content-tasks', icon: renderIcon('✅') } as MenuOption,
    ],
  },
  {
    label: 'Schema 生成',
    key: 'schema-group',
    type: 'group',
    children: [
      { label: 'Schema 记录', key: 'schema-records', icon: renderIcon('📚') } as MenuOption,
      { label: '生成 JSON-LD', key: 'schema-generate', icon: renderIcon('⚙️') } as MenuOption,
      { label: 'llms.txt 编辑器', key: 'schema-llms-txt', icon: renderIcon('📝') } as MenuOption,
    ],
  },
  {
    label: '知识图谱',
    key: 'kg-group',
    type: 'group',
    children: [
      { label: '实体管理', key: 'kg-entities', icon: renderIcon('🔷') } as MenuOption,
      { label: '关系管理', key: 'kg-relations', icon: renderIcon('🔗') } as MenuOption,
      { label: '图谱可视化', key: 'kg-graph', icon: renderIcon('🌐') } as MenuOption,
    ],
  },
  {
    label: 'GEO 诊断',
    key: 'diagnostic-group',
    type: 'group',
    children: [
      { label: '诊断项目', key: 'diagnostic-projects', icon: renderIcon('🏥') } as MenuOption,
      { label: '行动中心', key: 'diagnostic-actions', icon: renderIcon('📋') } as MenuOption,
    ],
  },
  {
    label: '设置',
    key: 'settings',
    icon: renderIcon('⚙️'),
  } as MenuOption,
]

const activeKey = computed(() => route.name as string)

function handleMenuUpdate(key: string) {
  router.push({ name: key })
}

// 平台身份横幅：平台顾问进入客户工作区时提醒"操作的是客户数据"
const isPlatformUser = computed(() => sessionStore.me?.userType === 'PLATFORM')

// ===== Header：企业名 + Workspace 切换下拉（规格 §4.3） =====
// 企业名仅客户显示（平台用户 me().organization 恒 null，不渲染该段）
const orgName = computed(() => sessionStore.me?.organization?.name ?? '')

// 切换下拉 options = me().workspaces（客户 OWNER=本企业全部 / MEMBER=已授权；平台用户=其可列集）。
// 当前工作区不在列表时（如 SUPER_ADMIN 的 me() 截断 20 条）以 workspace.get 已取到的名字
// 补当前项，避免 NSelect 选中值显示空白。
const workspaceOptions = computed(() => {
  const options = (sessionStore.me?.workspaces.items ?? []).map((w) => ({
    label: w.name,
    value: w.id,
  }))
  const currentId = route.params.workspaceId as string | undefined
  if (currentId && !options.some((o) => o.value === currentId)) {
    options.unshift({ label: workspaceName.value || '当前工作区', value: currentId })
  }
  return options
})

const currentWorkspaceId = computed(() => (route.params.workspaceId as string) ?? null)

function handleSwitchWorkspace(value: string) {
  // 裁定：切换统一回该工作区概览（dashboard，显式传参）——同名路由跳转在
  // diagnostic-project-detail 等带自身参数的子路由上会因缺参解析失败，且跨工作区
  // 保留深路径本身无意义（与 admin enterWorkspace 的跳转模式一致）
  router.push({ name: 'dashboard', params: { workspaceId: value } })
}

// 右上角用户菜单（同 AdminLayout：改密 / 退出）
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
        <!-- 折叠态：裁剪显示 LOGO 左侧的罗盘图标部分 -->
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
        <NSpace align="center" :size="8" :wrap="true" style="flex: 1; min-width: 0; overflow: hidden">
          <!-- 企业名（客户）· Workspace 切换下拉（当前工作区名即选中项）· 域名辅助信息 -->
          <template v-if="orgName">
            <NText strong style="font-size: 15px">{{ orgName }}</NText>
            <NText depth="3">·</NText>
          </template>
          <NSelect
            :value="currentWorkspaceId"
            :options="workspaceOptions"
            size="small"
            style="width: 200px; flex-shrink: 0"
            placeholder="Workspace"
            @update:value="handleSwitchWorkspace"
          />
          <NText v-if="workspaceDomain" depth="3" style="font-size: 12px">{{ workspaceDomain }}</NText>
        </NSpace>
        <NSpace align="center" :wrap="false">
          <NDropdown :options="userOptions" @select="handleUserAction">
            <NButton size="small" quaternary>
              {{ sessionStore.me ? (sessionStore.me.displayName || sessionStore.me.username) : '未登录' }}
            </NButton>
          </NDropdown>
          <NSwitch :value="appStore.darkMode" @update:value="appStore.toggleDarkMode" size="small">
            <template #checked>暗色</template>
            <template #unchecked>亮色</template>
          </NSwitch>
        </NSpace>
      </NLayoutHeader>
      <NLayoutContent style="padding: 24px" content-style="overflow: auto;">
        <NAlert
          v-if="isPlatformUser"
          type="warning"
          :bordered="false"
          :closable="false"
          style="margin-bottom: 16px"
        >
          你正以平台顾问身份操作
        </NAlert>
        <RouterView />
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>

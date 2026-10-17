import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// 本项目 src 根（posix 化后做前缀匹配；不能用 includes('/src/')——
// pnpm 下 naive-ui 的 es/**/src/* 内部路径也会命中）
const srcRoot = resolve(__dirname, 'src').replace(/\\/g, '/')

function toPosix(id: string): string {
  return id.replace(/\\/g, '/')
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5170,
    proxy: {
      '/trpc': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 分包策略。实测 Rollup manualChunks 行为：entry/异步 chunk 与 manual chunk
        // 共享的模块会被整体并入 manual chunk。若只给 admin 分组，router/stores/
        // naive-ui 会被吸进 admin 并在 index.html modulepreload（启动 360KB→1MB）。
        // 故共享核心显式成组：
        // - admin：/admin 路由树的页面、布局与 utils/enter-workspace（仅 admin 页
        //   引用，显式划入才真正进 admin chunk，否则会被下面的 app 规则截走）。
        //   注意：components/admin/（PlatformCredentials.vue、platform-defs.ts）
        //   是共享代码——任务 15 的工作区 Settings 页会复用，刻意留在 app chunk，
        //   拉进 admin 反而会让客户侧页面反向加载整个 admin chunk。
        // - app：src 下非页面模块（main/router/stores/api/公共组件/components/admin
        //   等共享代码），启动必需；admin 与工作台视图共享的 naive-ui 组件并入本组。
        manualChunks(rawId) {
          const id = toPosix(rawId)
          if (
            id.includes('/views/admin/') ||
            id.includes('/layouts/AdminLayout') ||
            id.includes('/utils/enter-workspace')
          ) {
            return 'admin'
          }
          if (id.startsWith(srcRoot) && !id.includes('/views/') && !id.includes('/layouts/')) {
            return 'app'
          }
        },
      },
    },
  },
})

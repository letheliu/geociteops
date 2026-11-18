<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NSpace, NTable, NTag, NEmpty, NSpin } from 'naive-ui'
import { trpc } from '../../api/client'
import { DIAGNOSTIC_RUN_STATUS_COLORS } from '../../domain/diagnostic'
import { useI18n } from '@/i18n'
const { t, locale: appLocale } = useI18n()


const router = useRouter()
const projects = ref<any[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    projects.value = await (trpc as any).diagnostic.projects.list.query()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NSpace vertical :size="16">
    <NSpace justify="space-between" align="center">
      <h2 style="margin: 0">{{ t('诊断项目') }}</h2>
      <NButton type="primary" @click="router.push({ name: 'diagnostic-project-create' })"> {{ t('新建项目') }} </NButton>
    </NSpace>

    <NSpin :show="loading">
      <NTable v-if="projects.length" :single-line="false">
        <thead>
          <tr>
            <th>{{ t('项目名称') }}</th>
            <th>{{ t('品牌') }}</th>
            <th>{{ t('状态') }}</th>
            <th>{{ t('域名') }}</th>
            <th>{{ t('更新时间') }}</th>
            <th>{{ t('操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id">
            <td>{{ p.name }}</td>
            <td>{{ p.brandName }}</td>
            <td><NTag :type="DIAGNOSTIC_RUN_STATUS_COLORS[p.status] || 'default'" size="small">{{ p.status }}</NTag></td>
            <td>{{ p.brandDomain || '—' }}</td>
            <td>{{ new Date(p.updatedAt).toLocaleDateString(appLocale) }}</td>
            <td>
              <NButton size="small" @click="router.push({ name: 'diagnostic-project-detail', params: { id: p.id } })"> {{ t('详情') }} </NButton>
            </td>
          </tr>
        </tbody>
      </NTable>
      <NEmpty v-else :description="t('暂无诊断项目')" />
    </NSpin>
  </NSpace>
</template>

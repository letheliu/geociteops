<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NCard, NTag, NDescriptions, NDescriptionsItem, NEmpty, NSpin } from 'naive-ui'
import { trpc } from '../../api/client'
import { DIAGNOSTIC_QUERY_TYPE_LABELS, DIAGNOSTIC_RUN_STATUS_COLORS } from '../../domain/diagnostic'

const route = useRoute()
const router = useRouter()
const project = ref<any>(null)
const queries = ref<any[]>([])
const runs = ref<any[]>([])
const loading = ref(true)

const projectId = computed(() => route.params.id as string)

const queryCountByType = computed(() => {
  const map: Record<string, number> = {}
  for (const q of queries.value) {
    map[q.queryType] = (map[q.queryType] || 0) + 1
  }
  return map
})

onMounted(async () => {
  try {
    project.value = await (trpc as any).diagnostic.projects.get.query({ id: projectId.value })
    queries.value = await (trpc as any).diagnostic.queries.list.query({ projectId: projectId.value })
    runs.value = await (trpc as any).diagnostic.runs.list.query({ projectId: projectId.value })
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NSpin :show="loading">
    <div v-if="project">
      <NSpace vertical :size="16">
        <NSpace justify="space-between">
          <h2 style="margin: 0">{{ project.name }}</h2>
          <NSpace>
            <NButton @click="router.push({ name: 'diagnostic-query-planner', params: { id: projectId } })">
              问题规划
            </NButton>
            <NButton type="primary" @click="router.push({ name: 'diagnostic-run-create', params: { id: projectId } })">
              创建诊断运行
            </NButton>
          </NSpace>
        </NSpace>

        <NCard title="品牌摘要" size="small">
          <NDescriptions :column="2">
            <NDescriptionsItem label="品牌名称">{{ project.brandName }}</NDescriptionsItem>
            <NDescriptionsItem label="域名">{{ project.brandDomain || '未配置' }}</NDescriptionsItem>
            <NDescriptionsItem label="状态">
              <NTag :type="DIAGNOSTIC_RUN_STATUS_COLORS[project.status]" size="small">{{ project.status }}</NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="目标用户">{{ project.targetAudiences?.join(', ') || '未配置' }}</NDescriptionsItem>
          </NDescriptions>
        </NCard>

        <NCard title="问题分布" size="small">
          <NSpace>
            <NTag v-for="(count, type) in queryCountByType" :key="type" size="small">
              {{ DIAGNOSTIC_QUERY_TYPE_LABELS[type] || type }}: {{ count }}
            </NTag>
          </NSpace>
        </NCard>

        <NCard title="运行记录" size="small">
          <div v-if="runs.length">
            <div v-for="run in runs" :key="run.id" style="padding: 8px 0; border-bottom: 1px solid #eee;">
              <NSpace justify="space-between">
                <span>运行 {{ run.id.slice(0, 8) }}... — <NTag :type="DIAGNOSTIC_RUN_STATUS_COLORS[run.status]" size="small">{{ run.status }}</NTag></span>
                <NButton size="tiny" @click="router.push({ name: 'diagnostic-report', params: { runId: run.id } })">
                  报告
                </NButton>
              </NSpace>
            </div>
          </div>
          <NEmpty v-else description="暂无运行记录" />
        </NCard>
      </NSpace>
    </div>
  </NSpin>
</template>

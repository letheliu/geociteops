<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { NTabs, NTab, NButton, NTable, NTag, NSpace, NEmpty, NSpin, useMessage } from 'naive-ui'
import { trpc } from '../../api/client'
import { DIAGNOSTIC_QUERY_TYPE_LABELS, queryCoverageHint } from '../../domain/diagnostic'

const route = useRoute()
const message = useMessage()
const projectId = route.params.id as string
const activeTab = ref('BRAND')
const queries = ref<any[]>([])
const loading = ref(true)

const queryTypes = ['BRAND', 'CATEGORY', 'SCENARIO', 'COMPARISON'] as const

const filteredQueries = ref<any[]>([])

async function loadQueries() {
  loading.value = true
  try {
    queries.value = await (trpc as any).diagnostic.queries.list.query({ projectId })
    updateFilter()
  } finally {
    loading.value = false
  }
}

function updateFilter() {
  filteredQueries.value = queries.value.filter((q: any) => q.queryType === activeTab.value)
}

async function handleConfirm(id: string) {
  try {
    await (trpc as any).diagnostic.queries.bulkConfirm.mutate({ projectId, queryIds: [id] })
    message.success('已确认')
    await loadQueries()
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleDisable(id: string) {
  try {
    await (trpc as any).diagnostic.queries.disable.mutate({ projectId, queryId: id })
    message.success('已禁用')
    await loadQueries()
  } catch (err: any) {
    message.error(err.message)
  }
}

onMounted(loadQueries)
</script>

<template>
  <NSpace vertical :size="16">
    <h2 style="margin: 0">问题规划</h2>

    <NTabs v-model:value="activeTab" @update:value="updateFilter">
      <NTab v-for="type in queryTypes" :key="type" :name="type">
        <template #tab>
          <NSpace align="center" :size="4">
            <span>{{ DIAGNOSTIC_QUERY_TYPE_LABELS[type] }}</span>
            <NTag size="tiny" :type="queryCoverageHint(type, queries.filter(q => q.queryType === type).length)?.satisfied ? 'success' : 'warning'">
              {{ queries.filter(q => q.queryType === type).length }}
            </NTag>
          </NSpace>
        </template>
      </NTab>
    </NTabs>

    <NSpin :show="loading">
      <NTable v-if="filteredQueries.length">
        <thead>
          <tr>
            <th>问题文本</th>
            <th>优先级</th>
            <th>来源</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="q in filteredQueries" :key="q.id">
            <td>{{ q.queryText }}</td>
            <td>{{ q.priority }}</td>
            <td>{{ q.source }}</td>
            <td>
              <NTag :type="q.status === 'CONFIRMED' ? 'success' : q.status === 'DISABLED' ? 'default' : 'warning'" size="small">
                {{ q.status }}
              </NTag>
            </td>
            <td>
              <NSpace>
                <NButton v-if="q.status === 'DRAFT'" size="tiny" type="primary" @click="handleConfirm(q.id)">确认</NButton>
                <NButton v-if="q.status !== 'DISABLED'" size="tiny" @click="handleDisable(q.id)">禁用</NButton>
              </NSpace>
            </td>
          </tr>
        </tbody>
      </NTable>
      <NEmpty v-else description="暂无该类型的问题" />
    </NSpin>
  </NSpace>
</template>

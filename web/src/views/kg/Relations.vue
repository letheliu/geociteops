<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NSpace, NModal, NForm, NFormItem,
  NInput, NPopconfirm, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'

const message = useMessage()
const loading = ref(true)
const data = ref<any[]>([])

const showModal = ref(false)
const formData = ref({ fromName: '', toName: '', relationType: '', properties: '{}' })

async function loadData() {
  loading.value = true
  try {
    data.value = await trpc.kg.listRelations.query()
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

async function handleAdd() {
  if (!formData.value.fromName || !formData.value.toName || !formData.value.relationType) {
    message.warning('请填写完整')
    return
  }
  let props = {}
  try {
    props = JSON.parse(formData.value.properties || '{}')
  } catch {
    message.warning('属性 JSON 格式错误')
    return
  }
  try {
    await trpc.kg.addRelation.mutate({
      fromName: formData.value.fromName,
      toName: formData.value.toName,
      relationType: formData.value.relationType,
      properties: props,
    })
    message.success('已添加')
    showModal.value = false
    formData.value = { fromName: '', toName: '', relationType: '', properties: '{}' }
    await loadData()
  } catch (e: any) {
    message.error(e?.message || '添加失败')
  }
}

const columns: DataTableColumns<any> = [
  { title: '起始实体', key: 'fromName', width: 180,
    render(row) { return row.fromEntity?.name || row.fromEntityId },
  },
  {
    title: '关系',
    key: 'relationType',
    width: 140,
    render(row) {
      return h(NTag, { size: 'small', type: 'info' }, { default: () => row.relationType })
    },
  },
  { title: '目标实体', key: 'toName', width: 180,
    render(row) { return row.toEntity?.name || row.toEntityId },
  },
  {
    title: '属性',
    key: 'properties',
    ellipsis: { tooltip: true },
    render(row) { return JSON.stringify(row.properties) },
  },
]
</script>

<template>
  <div>
    <PageHeader title="关系管理" subtitle="知识图谱关系 CRUD" />

    <NSpace justify="end" style="margin-bottom: 16px">
      <NButton type="primary" @click="showModal = true">+ 添加关系</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="data"
        :loading="loading"
        :bordered="false"
        :row-key="(row: any) => row.id"
      />
    </NCard>

    <NModal v-model:show="showModal" preset="card" title="添加关系" style="width: 480px">
      <NForm>
        <NFormItem label="起始实体">
          <NInput v-model:value="formData.fromName" placeholder="zoomer.top" />
        </NFormItem>
        <NFormItem label="关系类型">
          <NInput v-model:value="formData.relationType" placeholder="competitor" />
        </NFormItem>
        <NFormItem label="目标实体">
          <NInput v-model:value="formData.toName" placeholder="Notion" />
        </NFormItem>
        <NFormItem label="属性 (JSON)">
          <NInput v-model:value="formData.properties" type="textarea" :rows="3" placeholder="{}" />
        </NFormItem>
        <NSpace justify="end">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" @click="handleAdd">添加</NButton>
        </NSpace>
      </NForm>
    </NModal>
  </div>
</template>

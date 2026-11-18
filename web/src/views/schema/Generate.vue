<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NCard, NForm, NFormItem, NInput, NSelect, NButton, NSpace, useMessage, NCode,
} from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const message = useMessage()
const submitting = ref(false)
const result = ref<any>(null)

const schemaTypes = [
  { label: 'SoftwareApplication', value: 'SoftwareApplication' },
  { label: 'Organization', value: 'Organization' },
  { label: 'Product', value: 'Product' },
  { label: 'FAQPage', value: 'FAQPage' },
  { label: 'Article', value: 'Article' },
  { label: 'BreadcrumbList', value: 'BreadcrumbList' },
]

const selectedType = ref('SoftwareApplication')

// Field definitions per schema type
const fieldDefs: Record<string, { required: string[]; optional: string[] }> = {
  SoftwareApplication: { required: ['name', 'applicationCategory'], optional: ['url', 'description', 'operatingSystem', 'offers', 'aggregateRating'] },
  Organization: { required: ['name', 'url'], optional: ['description', 'logo', 'sameAs', 'contactPoint'] },
  Product: { required: ['name'], optional: ['description', 'url', 'image', 'brand', 'offers', 'aggregateRating'] },
  FAQPage: { required: ['mainEntity'], optional: [] },
  Article: { required: ['headline', 'author'], optional: ['datePublished', 'image', 'publisher', 'description'] },
  BreadcrumbList: { required: ['itemListElement'], optional: [] },
}

const currentDef = computed(() => fieldDefs[selectedType.value] || { required: [], optional: [] })

const form = ref<Record<string, string>>({})

watch(selectedType, () => {
  form.value = {}
}, { immediate: true })

async function handleGenerate() {
  if (!form.value['pageUrl']) {
    message.warning(t("请输入页面 URL"))
    return
  }
  // Check required fields
  for (const f of currentDef.value.required) {
    if (!form.value[f]?.trim()) {
      message.warning(`${t("请填写必填字段: ")}${f}`)
      return
    }
  }

  submitting.value = true
  try {
    const fields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(form.value)) {
      if (k === 'pageUrl') continue
      if (v?.trim()) {
        // Try parsing JSON for complex fields
        try {
          fields[k] = JSON.parse(v)
        } catch {
          fields[k] = v
        }
      }
    }

    result.value = await trpc.schema.generate.jsonLd.mutate({
      pageUrl: form.value['pageUrl'],
      schemaType: selectedType.value as any,
      fields,
    })
    message.success(t("生成成功"))
  } catch (e: any) {
    message.error(e?.message || t("生成失败"))
  } finally {
    submitting.value = false
  }
}

const previewJsonLd = computed(() => {
  if (!result.value?.content) return ''
  return typeof result.value.content === 'string'
    ? result.value.content
    : JSON.stringify(result.value.content, null, 2)
})
</script>

<template>
  <div>
    <PageHeader :title="t('生成 JSON-LD')" :subtitle="t('手动生成 Schema.org 结构化数据')" />

    <NCard>
      <NForm label-placement="top">
        <NFormItem :label="t('页面 URL')">
          <NInput v-model:value="form['pageUrl']" placeholder="/about" />
        </NFormItem>

        <NFormItem :label="t('Schema 类型')">
          <NSelect v-model:value="selectedType" :options="schemaTypes" />
        </NFormItem>

        <div style="font-weight: 600; margin: 12px 0 8px; font-size: 13px">{{ t('必填字段') }}</div>
        <NSpace vertical :size="8">
          <NFormItem v-for="f in currentDef.required" :key="f" :label="f">
            <NInput v-model:value="form[f]" :placeholder="`${t('输入 ')}${f}`" />
          </NFormItem>
        </NSpace>

        <div v-if="currentDef.optional.length" style="font-weight: 600; margin: 12px 0 8px; font-size: 13px">{{ t('可选字段') }}</div>
        <NSpace vertical :size="8">
          <NFormItem v-for="f in currentDef.optional" :key="f" :label="f">
            <NInput v-model:value="form[f]" :placeholder="`${t('输入 ')}${f}${t('（JSON 对象也可）')}`" />
          </NFormItem>
        </NSpace>

        <NSpace justify="end" style="margin-top: 16px">
          <NButton type="primary" :loading="submitting" @click="handleGenerate">{{ t('生成并保存') }}</NButton>
        </NSpace>
      </NForm>
    </NCard>

    <NCard v-if="previewJsonLd" :title="t('生成结果')" style="margin-top: 16px">
      <pre style="background: var(--code-color); padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; margin: 0"><NCode :code="previewJsonLd" language="json" /></pre>
    </NCard>
  </div>
</template>

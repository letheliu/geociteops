<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  NCard, NForm, NFormItem, NInput, NButton, NSpace, NSwitch, NCode,
  useMessage, NTag, NSpin, NGrid, NGridItem,
} from 'naive-ui'
import { marked } from 'marked'
import PageHeader from '../../components/common/PageHeader.vue'
import { trpc } from '../../composables/useTrpc'
import { useI18n } from '@/i18n'
const { t } = useI18n()


const message = useMessage()
const loading = ref(false)
const saving = ref(false)
const generating = ref(false)

const brandName = ref('')
const tagline = ref('')
const sections = ref<{ title: string; items: { label: string; url: string; description: string }[] }[]>([
  { title: t("核心产品"), items: [] },
])
const updateFreq = ref({ docs: t("每周"), blog: t("每周 2 篇") })

const markdownPreview = computed(() => {
  let md = `# ${brandName.value || t("品牌名")}\n`
  md += `> ${tagline.value || t("标语")}\n\n`
  for (const sec of sections.value) {
    md += `## ${sec.title}\n`
    for (const item of sec.items) {
      md += `- [${item.label}](${item.url}): ${item.description}\n`
    }
    md += '\n'
  }
  if (updateFreq.value.docs || updateFreq.value.blog) {
    md += t("## 更新频率\n")
    if (updateFreq.value.docs) md += `${t("- 文档：")}${updateFreq.value.docs}
`
    if (updateFreq.value.blog) md += `${t("- 博客：")}${updateFreq.value.blog}
`
  }
  return md
})

const renderedHtml = computed(() => marked(markdownPreview.value))

function addItem(sectionIdx: number) {
  sections.value[sectionIdx].items.push({ label: '', url: '', description: '' })
}

function addSection() {
  sections.value.push({ title: t("新章节"), items: [] })
}

function removeSection(idx: number) {
  sections.value.splice(idx, 1)
}

async function handleAutoGenerate() {
  generating.value = true
  try {
    const result = await trpc.schema.autoSections.query({})
    if (result.sections?.length) {
      sections.value = result.sections
    }
    if (result.updateFrequency) {
      updateFreq.value = result.updateFrequency
    }
    message.success(t("已自动生成章节"))
    if (result.warnings?.length) {
      for (const w of result.warnings) {
        message.warning(w)
      }
    }
  } catch (e: any) {
    message.error(e?.message || t("自动生成失败"))
  } finally {
    generating.value = false
  }
}

async function handleSave() {
  if (!brandName.value.trim()) {
    message.warning(t("请输入品牌名"))
    return
  }
  saving.value = true
  try {
    await trpc.schema.generate.llmsTxt.mutate({
      brandName: brandName.value,
      tagline: tagline.value,
      sections: sections.value,
      updateFrequency: updateFreq.value,
    })
    message.success(t("llms.txt 已保存"))
  } catch (e: any) {
    message.error(e?.message || t("保存失败"))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('llms.txt 编辑器')" :subtitle="t('AI 爬虫协议文档编辑与预览')" />

    <NSpace justify="end" style="margin-bottom: 16px">
      <NButton :loading="generating" @click="handleAutoGenerate">{{ t('🔄 从数据自动生成') }}</NButton>
    </NSpace>

    <NGrid :cols="2" :x-gap="16">
      <!-- Editor -->
      <NGridItem>
        <NCard :title="t('编辑')">
          <NForm label-placement="top">
            <NFormItem :label="t('品牌名')">
              <NInput v-model:value="brandName" placeholder="acmedraw.example" />
            </NFormItem>
            <NFormItem :label="t('标语')">
              <NInput v-model:value="tagline" :placeholder="t('AI 时代的内容协作平台')" />
            </NFormItem>

            <div v-for="(sec, si) in sections" :key="si" style="border: 1px solid var(--divider-color); border-radius: 6px; padding: 12px; margin-bottom: 12px">
              <NSpace align="center" justify="space-between" style="margin-bottom: 8px">
                <NInput v-model:value="sec.title" size="small" style="width: 200px" />
                <NButton size="small" quaternary type="error" @click="removeSection(si)">{{ t('删除章节') }}</NButton>
              </NSpace>
              <div v-for="(item, ii) in sec.items" :key="ii" style="display: flex; gap: 4px; margin-bottom: 4px">
                <NInput v-model:value="item.label" size="small" :placeholder="t('名称')" style="flex: 1" />
                <NInput v-model:value="item.url" size="small" placeholder="URL" style="flex: 1" />
                <NInput v-model:value="item.description" size="small" :placeholder="t('描述')" style="flex: 2" />
              </div>
              <NButton size="small" quaternary @click="addItem(si)">{{ t('+ 添加条目') }}</NButton>
            </div>

            <NButton quaternary size="small" @click="addSection" style="margin-bottom: 12px">{{ t('+ 添加章节') }}</NButton>

            <div style="font-weight: 600; margin-bottom: 8px; font-size: 13px">{{ t('更新频率') }}</div>
            <NSpace>
              <NInput v-model:value="updateFreq.docs" :placeholder="t('文档')" size="small" style="width: 150px" />
              <NInput v-model:value="updateFreq.blog" :placeholder="t('博客')" size="small" style="width: 150px" />
            </NSpace>

            <NSpace justify="end" style="margin-top: 16px">
              <NButton type="primary" :loading="saving" @click="handleSave">{{ t('保存') }}</NButton>
            </NSpace>
          </NForm>
        </NCard>
      </NGridItem>

      <!-- Preview -->
      <NGridItem>
        <NCard :title="t('实时预览')">
          <div style="font-size: 12px; color: var(--text-color-3); margin-bottom: 8px">{{ t('Markdown 源码') }}</div>
          <pre style="background: var(--code-color); padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; max-height: 600px; margin: 0"><NCode :code="markdownPreview" language="markdown" /></pre>
        </NCard>
      </NGridItem>
    </NGrid>
  </div>
</template>

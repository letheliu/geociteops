<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NCard, NButton, NSpace, NSpin, NGrid, NGridItem, NTag, NEmpty,
  NCollapse, NCollapseItem, NInput, useMessage,
} from 'naive-ui'
import PageHeader from '../../components/common/PageHeader.vue'
import ScoreBar from '../../components/common/ScoreBar.vue'
import { trpc } from '../../composables/useTrpc'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const loading = ref(true)
const optimizing = ref(false)
const page = ref<any>(null)
const optimizedResult = ref<any>(null)

const pageId = computed(() => route.params.id as string)

const atoms = computed<any[]>(() => {
  if (!optimizedResult.value) return []
  try {
    const parsed = typeof optimizedResult.value === 'string'
      ? JSON.parse(optimizedResult.value)
      : optimizedResult.value
    return parsed.atoms || []
  } catch {
    return []
  }
})

const faqs = computed<any[]>(() => {
  if (!optimizedResult.value) return []
  try {
    const parsed = typeof optimizedResult.value === 'string'
      ? JSON.parse(optimizedResult.value)
      : optimizedResult.value
    return parsed.faqs || []
  } catch {
    return []
  }
})

const beforeScore = computed(() => {
  if (!optimizedResult.value) return null
  try {
    const parsed = typeof optimizedResult.value === 'string'
      ? JSON.parse(optimizedResult.value)
      : optimizedResult.value
    return parsed.beforeScore
  } catch {
    return null
  }
})

const afterScore = computed(() => {
  if (!optimizedResult.value) return null
  try {
    const parsed = typeof optimizedResult.value === 'string'
      ? JSON.parse(optimizedResult.value)
      : optimizedResult.value
    return parsed.overallScore
  } catch {
    return null
  }
})

async function loadPage() {
  loading.value = true
  try {
    page.value = await trpc.content.pages.get.query({ id: pageId.value })
    if (page.value?.optimizedContent) {
      optimizedResult.value = page.value.optimizedContent
    }
  } catch (e: any) {
    message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadPage)

async function handleOptimize() {
  optimizing.value = true
  message.loading('正在优化内容...')
  try {
    const result = await trpc.content.optimize.mutate({ pageId: pageId.value })
    optimizedResult.value = result
    message.success('优化完成')
    await loadPage()
  } catch (e: any) {
    message.error(e?.message || '优化失败')
  } finally {
    optimizing.value = false
  }
}
</script>

<template>
  <div>
    <NSpace align="center" justify="space-between" style="margin-bottom: 20px">
      <div>
        <NButton quaternary size="small" @click="router.push('/content/pages')" style="margin-right: 8px">← 返回</NButton>
        <span style="font-size: 18px; font-weight: 600">{{ page?.url }}</span>
      </div>
      <NButton type="primary" :loading="optimizing" @click="handleOptimize">
        {{ optimizing ? '优化中...' : '⚡ 优化此页面' }}
      </NButton>
    </NSpace>

    <NSpin :show="loading">
      <NGrid :cols="2" :x-gap="16">
        <!-- 原始内容 -->
        <NGridItem>
          <NCard title="原始内容">
            <div style="white-space: pre-wrap; font-size: 13px; max-height: 600px; overflow: auto; line-height: 1.8">
              {{ page?.currentContent }}
            </div>
          </NCard>
        </NGridItem>

        <!-- 优化结果 -->
        <NGridItem>
          <NCard>
            <template #header>
              <NSpace align="center">
                <span>优化结果</span>
                <template v-if="beforeScore !== null && afterScore !== null">
                  <NTag size="small" type="warning">前 {{ beforeScore }}</NTag>
                  <span>→</span>
                  <NTag size="small" type="success">后 {{ afterScore }}</NTag>
                </template>
              </NSpace>
            </template>

            <NEmpty v-if="atoms.length === 0" description="尚未优化，点击右上角按钮开始" />

            <div v-else style="max-height: 600px; overflow: auto">
              <div style="margin-bottom: 16px">
                <div style="font-weight: 600; margin-bottom: 8px">原子单元 ({{ atoms.length }})</div>
                <NSpace vertical :size="8">
                  <div
                    v-for="(atom, i) in atoms"
                    :key="i"
                    style="padding: 10px; border: 1px solid var(--divider-color); border-radius: 6px"
                  >
                    <NSpace align="center" justify="space-between" style="margin-bottom: 4px">
                      <NTag size="small" :type="(atom.score?.total ?? 0) >= 70 ? 'success' : 'warning'">
                        {{ (atom.score?.total ?? 0) >= 70 ? '✅' : '⚠️' }} Atom #{{ i + 1 }} · 分数 {{ atom.score?.total ?? '-' }}
                      </NTag>
                    </NSpace>
                    <div style="font-size: 13px; line-height: 1.6">{{ atom.text }}</div>
                    <div v-if="atom.subject || atom.object" style="font-size: 11px; color: var(--text-color-3); margin-top: 4px">
                      <span v-if="atom.subject">主语: {{ atom.subject }}</span>
                      <span v-if="atom.predicate"> · 谓语: {{ atom.predicate }}</span>
                      <span v-if="atom.object"> · 宾语: {{ atom.object }}</span>
                    </div>
                    <div v-if="atom.anchors?.length" style="margin-top: 4px">
                      <NTag v-for="(a, j) in atom.anchors" :key="j" size="tiny" style="margin-right: 4px">{{ a }}</NTag>
                    </div>
                  </div>
                </NSpace>
              </div>

              <div v-if="faqs.length > 0">
                <NCollapse>
                  <NCollapseItem :title="`FAQ (${faqs.length})`" name="faq">
                    <div v-for="(faq, i) in faqs" :key="i" style="padding: 8px 0; border-bottom: 1px solid var(--divider-color)">
                      <div style="font-weight: 600; font-size: 13px">Q: {{ faq.question }}</div>
                      <div style="font-size: 13px; color: var(--text-color-2); margin-top: 4px">A: {{ faq.answer }}</div>
                    </div>
                  </NCollapseItem>
                </NCollapse>
              </div>
            </div>
          </NCard>
        </NGridItem>
      </NGrid>
    </NSpin>
  </div>
</template>

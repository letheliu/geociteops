import { ref } from 'vue'
import enUS from './en-US'

export type AppLocale = 'zh-CN' | 'en-US'
export type TranslationParams = Record<string, string | number>

const LOCALE_STORAGE_KEY = 'geo-locale'

function readInitialLocale(): AppLocale {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
  return saved === 'en-US' ? 'en-US' : 'zh-CN'
}

/** 当前语言。中文原文同时作为默认文案和翻译键，缺失英文时自动回退中文。 */
const locale = ref<AppLocale>(readInitialLocale())

function interpolate(message: string, params?: TranslationParams): string {
  if (!params) return message
  return message.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  )
}

export function t(key: string, params?: TranslationParams): string {
  const message = locale.value === 'en-US' ? (enUS[key] ?? key) : key
  return interpolate(message, params)
}

export function setLocale(next: AppLocale): void {
  locale.value = next
  localStorage.setItem(LOCALE_STORAGE_KEY, next)
  document.documentElement.lang = next
}

export function useI18n() {
  return { locale, setLocale, t }
}

export function syncDocumentLanguage(): void {
  document.documentElement.lang = locale.value
}

syncDocumentLanguage()

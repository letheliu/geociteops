import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const darkMode = ref(localStorage.getItem('geo-dark-mode') === '1')
  const collapsed = ref(false)

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
  }

  function toggleCollapsed() {
    collapsed.value = !collapsed.value
  }

  return { darkMode, collapsed, toggleDarkMode, toggleCollapsed }
})

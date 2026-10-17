import { describe, it, expect, vi } from 'vitest'

describe('useDiagnosticRun', () => {
  it('exports composable', async () => {
    const mod = await import('./useDiagnosticRun.js')
    expect(mod.useDiagnosticRun).toBeDefined()
  })
})

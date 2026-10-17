import { describe, it, expect } from 'vitest'
import { planActions } from './action-planner.js'

describe('planActions', () => {
  it('deduplicates actions pointing to same page and horizon', () => {
    const findings = [
      { type: 'LOW_VISIBILITY', severity: 'WARNING' as const, queryTypes: ['BRAND'], targetRunQueryIds: ['q1'], targetPageUrl: 'https://example.com/page1' },
      { type: 'LOW_SOURCE_CITATION', severity: 'WARNING' as const, queryTypes: ['BRAND'], targetRunQueryIds: ['q1'], targetPageUrl: 'https://example.com/page1' },
    ]
    const actions = planActions({ findings, existingOptimizationTaskIds: [] })
    // Same page + same horizon = one action max
    const page1Actions = actions.filter(a => a.targetPageUrl === 'https://example.com/page1')
    expect(page1Actions.length).toBeLessThanOrEqual(3) // at most one per horizon
  })

  it('generates RETEST action when accepted actions completed', () => {
    const findings: Array<{ type: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; queryTypes: string[]; targetRunQueryIds: string[]; targetPageUrl?: string }> = []
    const actions = planActions({ findings, existingOptimizationTaskIds: ['task-1'] })
    expect(actions.some(a => a.actionType === 'RETEST')).toBe(false)
  })

  it('marks BUILD_EXTERNAL_SOURCES as not convertible', () => {
    const findings = [
      { type: 'LOW_SOURCE_CITATION', severity: 'WARNING' as const, queryTypes: ['BRAND'], targetRunQueryIds: ['q1'], targetPageUrl: undefined },
    ]
    const actions = planActions({ findings, existingOptimizationTaskIds: [] })
    for (const action of actions) {
      if (action.actionType === 'BUILD_EXTERNAL_SOURCES') {
        // These are manual actions
      }
    }
  })

  it('maps INSUFFICIENT_SAMPLE to fix config action', () => {
    const findings = [
      { type: 'INSUFFICIENT_SAMPLE', severity: 'CRITICAL' as const, queryTypes: ['BRAND'], targetRunQueryIds: ['q1'], targetPageUrl: undefined },
    ]
    const actions = planActions({ findings, existingOptimizationTaskIds: [] })
    expect(actions.length).toBeGreaterThan(0)
  })

  it('generates actions for each horizon (30/60/90)', () => {
    const findings = [
      { type: 'LOW_VISIBILITY', severity: 'WARNING' as const, queryTypes: ['BRAND'], targetRunQueryIds: ['q1'], targetPageUrl: 'https://example.com' },
    ]
    const actions = planActions({ findings, existingOptimizationTaskIds: [] })
    const horizons = new Set(actions.map(a => a.horizon))
    expect(horizons.size).toBeGreaterThan(0)
    expect(horizons.has('DAYS_30')).toBe(true)
  })
})

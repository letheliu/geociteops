import { describe, it, expect } from 'vitest'
import { calculateRequestUnits, queryCoverageHint, DIAGNOSTIC_QUERY_TYPE_LABELS } from './diagnostic.js'

describe('diagnostic domain helpers', () => {
  it('calculates request units', () => {
    expect(calculateRequestUnits(24, 5, 2)).toBe(240)
    expect(calculateRequestUnits(10, 3, 1)).toBe(30)
  })

  it('checks coverage hint', () => {
    const hint = queryCoverageHint('SCENARIO', 8)
    expect(hint).not.toBeNull()
    expect(hint!.minimum).toBe(10)
    expect(hint!.satisfied).toBe(false)

    const satisfied = queryCoverageHint('BRAND', 5)
    expect(satisfied!.satisfied).toBe(true)
  })

  it('has labels for all query types', () => {
    expect(DIAGNOSTIC_QUERY_TYPE_LABELS.BRAND).toBe('品牌问题')
    expect(DIAGNOSTIC_QUERY_TYPE_LABELS.CATEGORY).toBe('品类问题')
    expect(DIAGNOSTIC_QUERY_TYPE_LABELS.SCENARIO).toBe('场景问题')
    expect(DIAGNOSTIC_QUERY_TYPE_LABELS.COMPARISON).toBe('对比问题')
  })
})

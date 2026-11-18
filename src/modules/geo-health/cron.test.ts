import { describe, expect, it } from 'vitest'
import { GeoHealthError } from './errors.js'
import { CADENCE_CRON, nextRunAfter, resolveScheduleCron } from './cron.js'

const TUESDAY = new Date('2026-11-17T10:00:00+08:00')

describe('health check cron', () => {
  it('maps the presets onto the Shanghai clock', () => {
    expect(nextRunAfter(CADENCE_CRON.DAILY, TUESDAY).toISOString()).toBe('2026-11-17T20:00:00.000Z')
    expect(nextRunAfter(CADENCE_CRON.WEEKLY, TUESDAY).toISOString()).toBe('2026-11-22T20:00:00.000Z')
    expect(nextRunAfter(CADENCE_CRON.MONTHLY, TUESDAY).toISOString()).toBe('2026-11-30T20:00:00.000Z')
  })

  it('fires on the next matching minute and not on the minute we are already in', () => {
    expect(nextRunAfter('0 4 * * *', new Date('2026-11-18T03:59:30+08:00')).toISOString()).toBe('2026-11-17T20:00:00.000Z')
    expect(nextRunAfter('0 4 * * *', new Date('2026-11-18T04:00:00+08:00')).toISOString()).toBe('2026-11-18T20:00:00.000Z')
  })

  it('treats a constrained day-of-month and day-of-week as either match', () => {
    expect(nextRunAfter('0 4 1 * 1', TUESDAY).toISOString()).toBe('2026-11-22T20:00:00.000Z')
  })

  it('rejects a cron that can fire more than once an hour', () => {
    expect(() => resolveScheduleCron('CRON', '* * * * *', TUESDAY)).toThrow(GeoHealthError)
    expect(() => resolveScheduleCron('CRON', '*/30 * * * *', TUESDAY)).toThrow(GeoHealthError)
    expect(resolveScheduleCron('CRON', '0 */2 * * *', TUESDAY).cron).toBe('0 */2 * * *')
  })
})

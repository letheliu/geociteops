import { GeoHealthError } from './errors.js'

/** Same clock as citation monitoring. Schedules do not take another timezone. */
export const SCHEDULE_TZ = 'Asia/Shanghai'

export const CADENCE_CRON = {
  DAILY: '0 4 * * *',
  WEEKLY: '0 4 * * 1',
  MONTHLY: '0 4 1 * *',
} as const

export type ScheduleCadence = keyof typeof CADENCE_CRON | 'CRON'

const MIN_GAP_MS = 60 * 60 * 1000
const MAX_STEPS = 366 * 24 * 60

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

interface ParsedCron {
  minute: (value: number) => boolean
  hour: (value: number) => boolean
  day: (value: number) => boolean
  month: (value: number) => boolean
  weekday: (value: number) => boolean
  dayAny: boolean
  weekdayAny: boolean
}

function badCron(detail: string): never {
  throw new GeoHealthError(
    'BAD_INPUT',
    `cron 需要 5 段数字（分 时 日 月 周），并且任意两次触发至少间隔 1 小时。${detail}`,
  )
}

function parseField(raw: string, min: number, max: number): { test: (value: number) => boolean; any: boolean } {
  const text = raw.trim()
  if (!text) badCron('有一段是空的。')
  const allowed = new Set<number>()
  for (const part of text.split(',')) {
    const [rangeRaw, stepRaw, extra] = part.split('/')
    if (extra !== undefined || !rangeRaw) badCron(`无法解析「${part}」。`)
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) badCron(`步长无效：「${part}」。`)
    let start: number
    let end: number
    if (rangeRaw === '*') {
      start = min
      end = max
    } else if (rangeRaw.includes('-')) {
      const [a, b, more] = rangeRaw.split('-')
      if (more !== undefined || a === undefined || b === undefined) badCron(`范围无效：「${part}」。`)
      start = Number(a)
      end = Number(b)
    } else {
      start = Number(rangeRaw)
      end = start
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      badCron(`「${part}」超出 ${min}–${max}。`)
    }
    for (let value = start; value <= end; value += step) allowed.add(value)
  }
  return { test: (value) => allowed.has(value), any: text === '*' }
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) badCron('目前不支持秒字段，也不支持 @daily 这种别名。')
  const minute = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const day = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12)
  const weekday = parseField(fields[4]!, 0, 7)
  const weekdayTest = (value: number) => weekday.test(value) || (value === 0 && weekday.test(7))
  return {
    minute: minute.test,
    hour: hour.test,
    day: day.test,
    month: month.test,
    weekday: weekdayTest,
    dayAny: day.any,
    weekdayAny: weekday.any,
  }
}

const shanghaiFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
})

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

function shanghaiParts(date: Date): WallClock {
  const parts = shanghaiFormatter.formatToParts(date)
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  let hour = Number(read('hour'))
  if (hour === 24) hour = 0
  const weekday = WEEKDAY[read('weekday')]
  if (weekday === undefined) badCron('无法解析上海时区的星期。')
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour,
    minute: Number(read('minute')),
    weekday,
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function bumpMinute(clock: WallClock): void {
  clock.minute += 1
  if (clock.minute < 60) return
  clock.minute = 0
  clock.hour += 1
  if (clock.hour < 24) return
  clock.hour = 0
  clock.weekday = (clock.weekday + 1) % 7
  clock.day += 1
  if (clock.day <= daysInMonth(clock.year, clock.month)) return
  clock.day = 1
  clock.month += 1
  if (clock.month <= 12) return
  clock.month = 1
  clock.year += 1
}

function fromShanghai(clock: WallClock): Date {
  return new Date(Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour - 8, clock.minute))
}

function matches(cron: ParsedCron, clock: WallClock): boolean {
  if (!cron.minute(clock.minute) || !cron.hour(clock.hour) || !cron.month(clock.month)) return false
  const day = cron.day(clock.day)
  const weekday = cron.weekday(clock.weekday)
  if (cron.dayAny && cron.weekdayAny) return true
  if (cron.dayAny) return weekday
  if (cron.weekdayAny) return day
  // Standard cron: when both day-of-month and day-of-week are constrained, either match fires.
  return day || weekday
}

/** First minute strictly after `after` whose Shanghai wall time matches the cron. */
export function nextRunAfter(expression: string, after: Date): Date {
  const cron = parseCron(expression)
  const clock = shanghaiParts(new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000))
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (matches(cron, clock)) return fromShanghai(clock)
    bumpMinute(clock)
  }
  badCron('未来一年内不会触发。')
}

/**
 * Reject expressions that can fire more than once an hour.
 * The scan looks at the upcoming firings from two anchors so a dense month
 * is not hidden behind a quiet one.
 */
export function assertSchedulable(expression: string): string {
  const text = expression.trim()
  parseCron(text)
  const anchors = [
    new Date('2026-01-01T00:00:00+08:00'),
    new Date('2026-06-15T12:00:00+08:00'),
  ]
  for (const anchor of anchors) {
    let cursor = anchor
    let previous: Date | null = null
    for (let i = 0; i < 8; i += 1) {
      const next = nextRunAfter(text, cursor)
      if (previous && next.getTime() - previous.getTime() < MIN_GAP_MS) {
        badCron('两次触发不能比 1 小时更密。')
      }
      previous = next
      cursor = next
    }
  }
  return text
}

export function resolveScheduleCron(cadence: ScheduleCadence, cron: string | undefined, after: Date): { cron: string; nextRunAt: Date } {
  const expression = cadence === 'CRON' ? (cron ?? '').trim() : CADENCE_CRON[cadence]
  if (!expression) badCron('选择自定义 cron 时要填写表达式。')
  const text = assertSchedulable(expression)
  return { cron: text, nextRunAt: nextRunAfter(text, after) }
}

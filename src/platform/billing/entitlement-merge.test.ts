import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPACITY_FIELDS,
  OPTIONAL_CAPACITY_FIELDS,
  mergeEntitlements,
  normalizeEntitlements,
  shanghaiMonthWindow,
  zeroEntitlements,
  type MergeSubscriptionInput,
} from './entitlement-merge.js'

// ---------------------------------------------------------------------------
// 测试时钟：2026-10-15T02:00:00+08:00（= 2026-10-14T18:00:00Z），简报月度窗口用例锚点
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-15T02:00:00+08:00')
const FUTURE = new Date('2026-11-01T00:00:00+08:00')
const PAST = new Date('2026-10-01T00:00:00+08:00')

function sub(overrides: Partial<MergeSubscriptionInput> = {}): MergeSubscriptionInput {
  return {
    planKind: 'SUBSCRIPTION',
    entitlements: {},
    status: 'ACTIVE',
    endAt: FUTURE,
    ...overrides,
  }
}

describe('mergeEntitlements（规格 §6.4 合并规则表）', () => {
  it('有效 = status ACTIVE/GRACE 且 endAt > now：两个有效订阅进入合并', () => {
    const merged = mergeEntitlements(
      [sub({ entitlements: { maxQueries: 100 } }), sub({ entitlements: { maxQueries: 200 } })],
      NOW,
    )
    expect(merged.maxQueries).toBe(200)
  })

  it('数值用例 1：订阅A maxQueries=100 + 订阅B=200 → max 取 200', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { maxQueries: 100 } }),
        sub({ entitlements: { maxQueries: 200 } }),
      ],
      NOW,
    )
    expect(merged.maxQueries).toBe(200)
  })

  it('数值用例 2：max(100,200) + ADDON 500 → 200 + 500 = 700', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { maxQueries: 100 } }),
        sub({ entitlements: { maxQueries: 200 } }),
        sub({ planKind: 'ADDON', entitlements: { maxQueries: 500 } }),
      ],
      NOW,
    )
    expect(merged.maxQueries).toBe(700)
  })

  it('数值用例 3：max(100,200) + 两个 ADDON 500+300 → 200+500+300 = 1000', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { maxQueries: 100 } }),
        sub({ entitlements: { maxQueries: 200 } }),
        sub({ planKind: 'ADDON', entitlements: { maxQueries: 500 } }),
        sub({ planKind: 'ADDON', entitlements: { maxQueries: 300 } }),
      ],
      NOW,
    )
    expect(merged.maxQueries).toBe(1000)
  })

  it('数值用例 4：过期 ADDON（endAt ≤ now）不计入求和', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { maxQueries: 200 } }),
        sub({ planKind: 'ADDON', entitlements: { maxQueries: 500 }, endAt: PAST }),
        // 恰好 endAt === now 也是过期（严格 >）
        sub({ planKind: 'ADDON', entitlements: { maxQueries: 300 }, endAt: NOW }),
      ],
      NOW,
    )
    expect(merged.maxQueries).toBe(200)
  })

  it('过期订阅不进 max 基数：100 有效 + 300 过期 → 100', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { maxQueries: 100 } }),
        sub({ entitlements: { maxQueries: 300 }, endAt: PAST }),
      ],
      NOW,
    )
    expect(merged.maxQueries).toBe(100)
  })

  it('GRACE 宽限期仍有效：maxQueries 进 max / ADDON 进求和', () => {
    const merged = mergeEntitlements(
      [
        sub({ status: 'GRACE', entitlements: { maxQueries: 150 } }),
        sub({ planKind: 'ADDON', status: 'GRACE', entitlements: { maxQueries: 50 } }),
      ],
      NOW,
    )
    expect(merged.maxQueries).toBe(200)
  })

  it('EXPIRED / CANCELLED 一律无效', () => {
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      const merged = mergeEntitlements(
        [
          sub({ status, entitlements: { maxQueries: 999 } }),
          sub({ planKind: 'ADDON', status, entitlements: { maxQueries: 999 } }),
        ],
        NOW,
      )
      expect(merged.maxQueries).toBe(0)
    }
  })

  it('无任何有效项 → 全部容量字段 0、allowedPlatforms 空', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { maxQueries: 100 }, endAt: PAST }),
        sub({ planKind: 'ADDON', entitlements: { maxQueries: 500 }, status: 'CANCELLED' }),
      ],
      NOW,
    )
    expect(merged).toEqual(zeroEntitlements())
    expect(merged.allowedPlatforms).toEqual([])
  })

  it('空订阅列表 → 全 0 默认对象（六个容量字段齐全）', () => {
    expect(mergeEntitlements([], NOW)).toEqual({
      maxWorkspaces: 0,
      maxQueries: 0,
      maxPages: 0,
      diagnosticRunsPerMonth: 0,
      samplesPerRun: 0,
      optimizationsPerMonth: 0,
      allowedPlatforms: [],
    })
  })

  it('容量字段逐字段独立合并：六字段各自 max + ADDON 求和', () => {
    const merged = mergeEntitlements(
      [
        sub({
          entitlements: {
            maxWorkspaces: 3,
            maxQueries: 100,
            maxPages: 1000,
            diagnosticRunsPerMonth: 10,
            samplesPerRun: 50,
            optimizationsPerMonth: 5,
          },
        }),
        sub({
          entitlements: {
            maxWorkspaces: 10,
            maxQueries: 200,
            maxPages: 500,
            diagnosticRunsPerMonth: 30,
            samplesPerRun: 20,
            optimizationsPerMonth: 8,
          },
        }),
        sub({
          planKind: 'ADDON',
          entitlements: {
            maxWorkspaces: 2,
            maxQueries: 500,
            maxPages: 100,
            diagnosticRunsPerMonth: 5,
            samplesPerRun: 10,
            optimizationsPerMonth: 2,
          },
        }),
      ],
      NOW,
    )
    expect(merged).toEqual({
      maxWorkspaces: 12, // max(3,10) + 2
      maxQueries: 700, // max(100,200) + 500
      maxPages: 1100, // max(1000,500) + 100
      diagnosticRunsPerMonth: 35, // max(10,30) + 5
      samplesPerRun: 60, // max(50,20) + 10
      optimizationsPerMonth: 10, // max(5,8) + 2
      allowedPlatforms: [],
    })
  })

  it('CAPACITY_FIELDS 常量与裁定清单一致（六字段，下游计量按此遍历）', () => {
    expect([...CAPACITY_FIELDS]).toEqual([
      'maxWorkspaces',
      'maxQueries',
      'maxPages',
      'diagnosticRunsPerMonth',
      'samplesPerRun',
      'optimizationsPerMonth',
    ])
  })

  it('仅有 ADDON 无有效订阅：容量 = 0 + Σ ADDON', () => {
    const merged = mergeEntitlements(
      [sub({ planKind: 'ADDON', entitlements: { maxQueries: 500 } })],
      NOW,
    )
    expect(merged.maxQueries).toBe(500)
  })

  it('SERVICE 商品类型不参与任何合并（订阅才进基数、ADDON 才进增量）', () => {
    const merged = mergeEntitlements(
      [
        sub({ planKind: 'SERVICE', entitlements: { maxQueries: 999, allowedPlatforms: ['llm'] } }),
        sub({ planKind: 'SERVICE', status: 'GRACE', entitlements: { maxQueries: 999 } }),
      ],
      NOW,
    )
    expect(merged).toEqual(zeroEntitlements())
  })

  it('allowedPlatforms = 有效订阅并集（去重、稳定排序）', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { allowedPlatforms: ['wechat', 'llm'] } }),
        sub({ entitlements: { allowedPlatforms: ['llm', 'douyin'] } }),
        sub({ status: 'EXPIRED', entitlements: { allowedPlatforms: ['expired-only'] } }),
      ],
      NOW,
    )
    expect(merged.allowedPlatforms).toEqual(['douyin', 'llm', 'wechat'])
  })

  it('ADDON 不扩平台集合：平台并集仅来自有效订阅', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { allowedPlatforms: ['wechat'] } }),
        sub({ planKind: 'ADDON', entitlements: { allowedPlatforms: ['douyin', 'llm'] } }),
      ],
      NOW,
    )
    expect(merged.allowedPlatforms).toEqual(['wechat'])
  })

  it('无有效订阅时 allowedPlatforms 空，即使 ADDON 带平台', () => {
    const merged = mergeEntitlements(
      [sub({ planKind: 'ADDON', entitlements: { allowedPlatforms: ['douyin'] } })],
      NOW,
    )
    expect(merged.allowedPlatforms).toEqual([])
  })

  describe('脏数据容错（数值字段非 number 按 0 处理并 console.warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    afterEach(() => {
      warnSpy.mockClear()
    })
    // describe 级单次 spy：用例清零计数，整组结束恢复原实现（不留全局 mock 泄漏）
    afterAll(() => {
      warnSpy.mockRestore()
    })

    it('maxQueries 为字符串 → 按 0 参与合并（max(0,200)=200）且 console.warn', () => {
      const merged = mergeEntitlements(
        [
          sub({ entitlements: { maxQueries: '100' } }),
          sub({ entitlements: { maxQueries: 200 } }),
        ],
        NOW,
      )
      expect(merged.maxQueries).toBe(200)
      expect(warnSpy).toHaveBeenCalled()
      expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('maxQueries'))).toBe(true)
    })

    it('ADDON 增量非 number（null）→ 加 0 且 warn；NaN/Infinity 同按 0 处理', () => {
      const merged = mergeEntitlements(
        [
          sub({ entitlements: { maxQueries: 200 } }),
          sub({ planKind: 'ADDON', entitlements: { maxQueries: null } }),
          sub({ planKind: 'ADDON', entitlements: { maxQueries: Number.NaN } }),
          sub({ planKind: 'ADDON', entitlements: { maxQueries: Number.POSITIVE_INFINITY } }),
        ],
        NOW,
      )
      expect(merged.maxQueries).toBe(200)
      expect(warnSpy).toHaveBeenCalledTimes(3)
    })

    it('字段缺失（undefined）不 warn 不计入（区别于显式脏值）', () => {
      const merged = mergeEntitlements(
        [sub({ entitlements: { maxPages: 10 } })],
        NOW,
      )
      expect(merged.maxQueries).toBe(0)
      expect(warnSpy).not.toHaveBeenCalled()
      expect(merged.maxPages).toBe(10)
    })

    it('负值防御（遗留 A2）：ADDON maxQueries=-500 → 按 0 计入求和，final 不低于基数', () => {
      const merged = mergeEntitlements(
        [
          sub({ entitlements: { maxQueries: 200 } }),
          sub({ planKind: 'ADDON', entitlements: { maxQueries: -500 } }),
        ],
        NOW,
      )
      expect(merged.maxQueries).toBe(200)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('负数'))).toBe(true)
    })

    it('负值防御：无订阅基数时多个负 ADDON 之和不为负（0 + 0 = 0，不出现 -1000）', () => {
      const merged = mergeEntitlements(
        [
          sub({ planKind: 'ADDON', entitlements: { maxQueries: -500 } }),
          sub({ planKind: 'ADDON', entitlements: { maxQueries: -500 } }),
        ],
        NOW,
      )
      expect(merged.maxQueries).toBe(0)
    })

    it('负值防御：订阅基数为负不影响 max（reduce 起点 0 兜底）+ ADDON 负值钳 0 → final 仍 ≥ 0', () => {
      const merged = mergeEntitlements(
        [
          sub({ entitlements: { maxQueries: -100 } }),
          sub({ planKind: 'ADDON', entitlements: { maxQueries: -50 } }),
        ],
        NOW,
      )
      expect(merged.maxQueries).toBe(0)
    })

    it('allowedPlatforms 非数组 → 忽略（空集，不抛错）；数组内非字符串项过滤', () => {
      const merged = mergeEntitlements(
        [
          sub({ entitlements: { allowedPlatforms: 'wechat' } }),
          sub({ entitlements: { allowedPlatforms: ['wechat', 42, null, 'llm'] } }),
        ],
        NOW,
      )
      expect(merged.allowedPlatforms).toEqual(['llm', 'wechat'])
    })
  })

  it('未知字段忽略（不合并、不报错）：entitlements 里的其它键不进结果', () => {
    const merged = mergeEntitlements(
      [sub({ entitlements: { maxQueries: 100, customFeature: 'x', secretQuota: 999 } })],
      NOW,
    )
    expect(merged).toEqual({
      ...zeroEntitlements(),
      maxQueries: 100,
    })
    expect('customFeature' in merged).toBe(false)
    expect('secretQuota' in merged).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shanghaiMonthWindow（Asia/Shanghai 自然月：当月 1 日 00:00+08 ~ 次月 1 日 00:00+08）
// ---------------------------------------------------------------------------

describe('shanghaiMonthWindow', () => {
  it('简报用例：now=2026-10-15T02:00:00+08:00 → [2026-09-30T16:00:00Z, 2026-10-31T16:00:00Z]', () => {
    const window = shanghaiMonthWindow(new Date('2026-10-15T02:00:00+08:00'))
    expect(window.periodStart.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(window.periodEnd.toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('UTC 视角的 10-14 深夜（上海仍是 10-15）→ 十月窗口', () => {
    const window = shanghaiMonthWindow(new Date('2026-10-14T18:00:00.000Z'))
    expect(window.periodStart.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(window.periodEnd.toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('窗口起点为闭区间锚：上海当月 1 日 00:00 整 → 当月窗口', () => {
    const window = shanghaiMonthWindow(new Date('2026-10-01T00:00:00+08:00'))
    expect(window.periodStart.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(window.periodEnd.toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('上海上月末 23:59:59.999 → 上月窗口', () => {
    const window = shanghaiMonthWindow(new Date('2026-09-30T23:59:59.999+08:00'))
    expect(window.periodStart.toISOString()).toBe('2026-08-31T16:00:00.000Z')
    expect(window.periodEnd.toISOString()).toBe('2026-09-30T16:00:00.000Z')
  })

  it('跨年：上海 12 月 → 次年 1 月 1 日 00:00+08 收口', () => {
    const window = shanghaiMonthWindow(new Date('2026-12-15T00:00:00+08:00'))
    expect(window.periodStart.toISOString()).toBe('2026-11-30T16:00:00.000Z')
    expect(window.periodEnd.toISOString()).toBe('2026-12-31T16:00:00.000Z')
  })

  it('上海 1 月（上一年 12 月 31 日 16:00Z 起点）', () => {
    const window = shanghaiMonthWindow(new Date('2027-01-05T00:00:00+08:00'))
    expect(window.periodStart.toISOString()).toBe('2026-12-31T16:00:00.000Z')
    expect(window.periodEnd.toISOString()).toBe('2027-01-31T16:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// normalizeEntitlements（getLimits 读存储 Json 的同规容错投影）
// ---------------------------------------------------------------------------

describe('normalizeEntitlements', () => {
  it('合法存储值原样投影到六字段 + 平台集合', () => {
    expect(
      normalizeEntitlements({
        maxWorkspaces: 3,
        maxQueries: 100,
        allowedPlatforms: ['wechat', 'llm'],
        ignored: true,
      }),
    ).toEqual({
      maxWorkspaces: 3,
      maxQueries: 100,
      maxPages: 0,
      diagnosticRunsPerMonth: 0,
      samplesPerRun: 0,
      optimizationsPerMonth: 0,
      allowedPlatforms: ['llm', 'wechat'],
    })
  })

  it('非对象（null/数组/字符串）→ 全 0 默认', () => {
    expect(normalizeEntitlements(null)).toEqual(zeroEntitlements())
    expect(normalizeEntitlements([1, 2])).toEqual(zeroEntitlements())
    expect(normalizeEntitlements('oops')).toEqual(zeroEntitlements())
  })

  it('脏数值按 0 容错（warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeEntitlements({ maxQueries: '100' }).maxQueries).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('负值防御（遗留 A2）：存储值负数同按 0 容错（warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const normalized = normalizeEntitlements({ maxQueries: -300, maxPages: 10 })
    expect(normalized.maxQueries).toBe(0)
    expect(normalized.maxPages).toBe(10)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// monitorSampleCountMax（M2 §3.0 试用单次运行采样数 N 上限）：与六个必填容量键语义
// 不同——**未声明 = 不限**（键不存在），而不是按 0 处理（0 会把没有 N 声明的正式租户
// 全部拦死）。因此它不进 CAPACITY_FIELDS 的 0 基线合并，走独立的存在性合并。
// ---------------------------------------------------------------------------

describe('OPTIONAL_CAPACITY_FIELDS（可选容量键清单）', () => {
  it('常量与裁定清单一致（monitorSampleCountMax 单键，不混入必填容量键）', () => {
    expect([...OPTIONAL_CAPACITY_FIELDS]).toEqual(['monitorSampleCountMax'])
  })
})

describe('mergeEntitlements：monitorSampleCountMax（缺失=不限）', () => {
  it('TRIAL 计划声明 3 → 合并结果不丢该键', () => {
    const merged = mergeEntitlements(
      [sub({ entitlements: { maxWorkspaces: 1, maxQueries: 10, monitorSampleCountMax: 3 } })],
      NOW,
    )
    expect(merged.monitorSampleCountMax).toBe(3)
  })

  it('未声明 → 键不存在（undefined，非 0）：合并/默认对象/存储投影三处一致', () => {
    expect(mergeEntitlements([sub({ entitlements: { maxWorkspaces: 1 } })], NOW).monitorSampleCountMax).toBeUndefined()
    expect(mergeEntitlements([], NOW).monitorSampleCountMax).toBeUndefined()
    expect(zeroEntitlements().monitorSampleCountMax).toBeUndefined()
    expect('monitorSampleCountMax' in zeroEntitlements()).toBe(false)
    expect(normalizeEntitlements({ maxWorkspaces: 1 }).monitorSampleCountMax).toBeUndefined()
  })

  it('多订阅取 max（与容量键同基数规则），ADDON 叠加', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { monitorSampleCountMax: 3 } }),
        sub({ entitlements: { monitorSampleCountMax: 10 } }),
        sub({ planKind: 'ADDON', entitlements: { monitorSampleCountMax: 2 } }),
      ],
      NOW,
    )
    expect(merged.monitorSampleCountMax).toBe(12)
  })

  it('过期订阅声明的 N 不进基数', () => {
    const merged = mergeEntitlements(
      [
        sub({ entitlements: { monitorSampleCountMax: 3 } }),
        sub({ entitlements: { monitorSampleCountMax: 10 }, status: 'EXPIRED' }),
      ],
      NOW,
    )
    expect(merged.monitorSampleCountMax).toBe(3)
  })

  it('normalizeEntitlements：存储值 3 原样投影（不丢、不被 0 覆盖）', () => {
    expect(normalizeEntitlements({ maxWorkspaces: 1, monitorSampleCountMax: 3 }).monitorSampleCountMax).toBe(3)
  })

  it('normalizeEntitlements：脏数值按 0 容错（warn，与 samplesPerRun 同约定）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeEntitlements({ monitorSampleCountMax: 'many' }).monitorSampleCountMax).toBe(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('订阅快照的下划线内部键原样进入合并结果（_graceDays/_suppressReminder 不被丢弃）', () => {
    const merged = mergeEntitlements(
      [sub({ entitlements: { monitorSampleCountMax: 3, _graceDays: 90, _suppressReminder: true } })],
      NOW,
    )
    expect(merged._graceDays).toBe(90)
    expect(merged._suppressReminder).toBe(true)
  })

  it('normalizeEntitlements：下划线内部键原样透传（非下划线未知键仍忽略）', () => {
    const projected = normalizeEntitlements({
      maxWorkspaces: 1,
      _graceDays: 90,
      _suppressReminder: true,
      unknownKey: 'x',
    })
    expect(projected._graceDays).toBe(90)
    expect(projected._suppressReminder).toBe(true)
    expect('unknownKey' in projected).toBe(false)
  })
})

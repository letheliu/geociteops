export interface ActionInput {
  type: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  queryTypes: string[]
  targetRunQueryIds: string[]
  targetPageUrl?: string
}

export interface PlannedAction {
  horizon: 'DAYS_30' | 'DAYS_60' | 'DAYS_90'
  actionType: string
  title: string
  description: string
  priority: number
  targetRunQueryIds: string[]
  targetPageUrl?: string
  sourceFindingTypes: string[]
  convertible: boolean
}

export function planActions(input: {
  findings: ActionInput[]
  existingOptimizationTaskIds: string[]
}): PlannedAction[] {
  const { findings, existingOptimizationTaskIds } = input
  const actions: PlannedAction[] = []

  const HORIZONS: Array<'DAYS_30' | 'DAYS_60' | 'DAYS_90'> = ['DAYS_30', 'DAYS_60', 'DAYS_90']

  // 30-day mapping: finding type -> action
  const day30Map: Record<string, { actionType: string; title: string; description: string; convertible: boolean }> = {
    INSUFFICIENT_SAMPLE: {
      actionType: 'RETEST',
      title: '修复配置并重新采样',
      description: '修复平台配置后重试失败样本以获得足够的诊断样本',
      convertible: false,
    },
    LOW_VISIBILITY: {
      actionType: 'FIX_BRAND_BASICS',
      title: '统一品牌定义和公开资料',
      description: '在官网、README 和公开页面统一品牌名称、描述和定位',
      convertible: false,
    },
    LOW_SOURCE_CITATION: {
      actionType: 'BUILD_EXTERNAL_SOURCES',
      title: '补全可引用事实来源',
      description: '为核心页面补充品牌定义、域名归属和可引用的事实性内容',
      convertible: false,
    },
    LOW_RANK: {
      actionType: 'OPTIMIZE_EXISTING_PAGE',
      title: '优化已有页面提升排名',
      description: '对现有页面进行内容优化以提升在 AI 回答中的推荐排名',
      convertible: true,
    },
    PLATFORM_GAP: {
      actionType: 'BUILD_EXTERNAL_SOURCES',
      title: '检查平台内容格式',
      description: '检查该平台可访问的公开来源和内容格式要求',
      convertible: false,
    },
    QUERY_COVERAGE_GAP: {
      actionType: 'CREATE_CATEGORY_PAGE',
      title: '创建覆盖不足的品类/场景页面',
      description: '创建缺少的品类、场景或对比页面以提高查询覆盖率',
      convertible: false,
    },
  }

  const convertibleTypes = new Set([
    'OPTIMIZE_EXISTING_PAGE',
    'REWRITE_CONTENT',
    'ADD_STRUCTURED_DATA',
    'UPDATE_KG',
  ])

  function makeDedupKey(action: PlannedAction): string {
    if (action.targetPageUrl) {
      return `${action.actionType}|${action.targetPageUrl}|${action.horizon}`
    }
    const sortedIds = [...action.targetRunQueryIds].sort().join(',')
    return `${action.actionType}|${sortedIds}|${action.horizon}`
  }

  const seenKeys = new Set<string>()

  for (const finding of findings) {
    for (const horizon of HORIZONS) {
      let actionDef:
        | { actionType: string; title: string; description: string; convertible: boolean }
        | undefined

      if (horizon === 'DAYS_30') {
        actionDef = day30Map[finding.type]
      } else if (horizon === 'DAYS_60') {
        // Query gap mapping for DAYS_60
        if (finding.queryTypes.includes('CATEGORY')) {
          actionDef = {
            actionType: 'CREATE_CATEGORY_PAGE',
            title: '创建品类解释页',
            description: '创建一个解释品牌所处品类的页面，帮助 AI 理解品牌定位',
            convertible: false,
          }
        } else if (finding.queryTypes.includes('SCENARIO')) {
          actionDef = {
            actionType: 'CREATE_SCENARIO_PAGE',
            title: '创建场景解决方案页面',
            description: '创建针对具体用户场景的解决方案、教程或案例页面',
            convertible: false,
          }
        } else if (finding.queryTypes.includes('COMPARISON')) {
          actionDef = {
            actionType: 'CREATE_COMPARISON_PAGE',
            title: '创建竞品对比页面',
            description: '创建有事实依据的竞品对比页面，突出品牌差异优势',
            convertible: false,
          }
        }
      } else if (horizon === 'DAYS_90') {
        if (finding.type === 'LOW_SOURCE_CITATION') {
          actionDef = {
            actionType: 'BUILD_EXTERNAL_SOURCES',
            title: '建设第三方可信参考资料',
            description: '建设客户案例、社区内容和第三方评测等可信参考资料',
            convertible: false,
          }
        } else if (finding.type === 'COMPETITOR_DOMINANCE') {
          actionDef = {
            actionType: 'BUILD_EXTERNAL_SOURCES',
            title: '建立差异化证据和案例',
            description: '建立差异化证据、真实客户案例和对比内容以应对竞品优势',
            convertible: false,
          }
        } else if (finding.type === 'PLATFORM_GAP') {
          actionDef = {
            actionType: 'RETEST',
            title: '调整内容矩阵和渠道覆盖',
            description: '调整内容策略以覆盖更多平台渠道',
            convertible: false,
          }
        }
      }

      if (!actionDef) continue

      const priority = finding.severity === 'CRITICAL' ? 1 : finding.severity === 'WARNING' ? 2 : 4
      const convertible = actionDef.convertible && convertibleTypes.has(actionDef.actionType)

      const planned: PlannedAction = {
        horizon,
        actionType: actionDef.actionType,
        title: actionDef.title,
        description: actionDef.description,
        priority,
        targetRunQueryIds: finding.targetRunQueryIds,
        targetPageUrl: finding.targetPageUrl,
        sourceFindingTypes: [finding.type],
        convertible,
      }

      const key = makeDedupKey(planned)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      actions.push(planned)
    }
  }

  return actions
}

export interface DeprecatedType {
  type: string
  retiredDate: string
  reason: string
  replacement: string | null
  notes: string
}

const DEPRECATED_TYPES: Record<string, DeprecatedType> = {
  HowTo: {
    type: 'HowTo',
    retiredDate: '2023-09',
    reason: 'Rich results removed from desktop and mobile',
    replacement: null,
    notes: 'Vocabulary remains but produces no SERP feature. Some sites keep for AI citation legibility.',
  },
  SpecialAnnouncement: {
    type: 'SpecialAnnouncement',
    retiredDate: '2025-07-31',
    reason: 'COVID-era emergency-info card deprecated',
    replacement: 'Event',
    notes: 'Use Event for time-bounded content, otherwise Article or WebPage.',
  },
  VehicleListing: {
    type: 'VehicleListing',
    retiredDate: '2025-06',
    reason: 'Google no longer renders dealer inventory rich cards',
    replacement: 'Product',
    notes: 'Use Product schema with vehicle-specific properties.',
  },
  ClaimReview: {
    type: 'ClaimReview',
    retiredDate: '2025-06',
    reason: 'Fact-check rich result retired',
    replacement: null,
    notes: 'ClaimReview vocabulary remains in schema.org but Google ignores it. Suggest Article with dateline if news context.',
  },
  EstimatedSalary: {
    type: 'EstimatedSalary',
    retiredDate: '2025-06',
    reason: 'Salary rich result retired',
    replacement: 'JobPosting',
    notes: 'Use JobPosting with baseSalary for specific roles.',
  },
  LearningVideo: {
    type: 'LearningVideo',
    retiredDate: '2025-06',
    reason: 'Learning video rich result retired',
    replacement: 'VideoObject',
    notes: 'Generic VideoObject rich result still renders.',
  },
  CourseInfo: {
    type: 'CourseInfo',
    retiredDate: '2025-06',
    reason: 'Course info carousel retired',
    replacement: 'Course',
    notes: 'Single-result Course rich card is still live.',
  },
  Dataset: {
    type: 'Dataset',
    retiredDate: '2025',
    reason: 'Dataset rich result retired',
    replacement: null,
    notes: 'No replacement available.',
  },
}

export interface DeprecationService {
  isDeprecated(type: string): boolean
  get(type: string): DeprecatedType | null
  list(): DeprecatedType[]
  getReplacement(type: string): string | null
}

export function createDeprecationService(): DeprecationService {
  return {
    isDeprecated(type) {
      return type in DEPRECATED_TYPES
    },
    get(type) {
      return DEPRECATED_TYPES[type] ?? null
    },
    list() {
      return Object.values(DEPRECATED_TYPES)
    },
    getReplacement(type) {
      return DEPRECATED_TYPES[type]?.replacement ?? null
    },
  }
}

import { describe, it, expect } from 'vitest'
import { createDeprecationService } from './deprecated-types.js'

describe('DeprecationService', () => {
  const service = createDeprecationService()

  it('isDeprecated 对已知废弃类型返回 true', () => {
    expect(service.isDeprecated('HowTo')).toBe(true)
    expect(service.isDeprecated('SpecialAnnouncement')).toBe(true)
    expect(service.isDeprecated('VehicleListing')).toBe(true)
    expect(service.isDeprecated('ClaimReview')).toBe(true)
    expect(service.isDeprecated('EstimatedSalary')).toBe(true)
    expect(service.isDeprecated('LearningVideo')).toBe(true)
    expect(service.isDeprecated('CourseInfo')).toBe(true)
    expect(service.isDeprecated('Dataset')).toBe(true)
  })

  it('isDeprecated 对活跃类型返回 false', () => {
    expect(service.isDeprecated('SoftwareApplication')).toBe(false)
    expect(service.isDeprecated('Organization')).toBe(false)
    expect(service.isDeprecated('Article')).toBe(false)
    expect(service.isDeprecated('')).toBe(false)
  })

  it('get 返回废弃类型的完整信息', () => {
    const howTo = service.get('HowTo')
    expect(howTo).not.toBeNull()
    expect(howTo!.type).toBe('HowTo')
    expect(howTo!.retiredDate).toBe('2023-09')
    expect(howTo!.replacement).toBeNull()

    const special = service.get('SpecialAnnouncement')
    expect(special).not.toBeNull()
    expect(special!.replacement).toBe('Event')
  })

  it('get 对未知类型返回 null', () => {
    expect(service.get('Unknown')).toBeNull()
    expect(service.get('SoftwareApplication')).toBeNull()
  })

  it('list 返回全部 8 种废弃类型', () => {
    const list = service.list()
    expect(list).toHaveLength(8)
    expect(list.map((d) => d.type)).toEqual(
      expect.arrayContaining(['HowTo', 'SpecialAnnouncement', 'VehicleListing', 'ClaimReview']),
    )
  })

  it('getReplacement 返回替代类型', () => {
    expect(service.getReplacement('SpecialAnnouncement')).toBe('Event')
    expect(service.getReplacement('VehicleListing')).toBe('Product')
    expect(service.getReplacement('EstimatedSalary')).toBe('JobPosting')
    expect(service.getReplacement('LearningVideo')).toBe('VideoObject')
    expect(service.getReplacement('CourseInfo')).toBe('Course')
  })

  it('getReplacement 对无替代的类型返回 null', () => {
    expect(service.getReplacement('HowTo')).toBeNull()
    expect(service.getReplacement('ClaimReview')).toBeNull()
    expect(service.getReplacement('Dataset')).toBeNull()
  })

  it('getReplacement 对未知类型返回 null', () => {
    expect(service.getReplacement('Unknown')).toBeNull()
  })
})

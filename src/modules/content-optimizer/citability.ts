import type { CitabilityScore, CitabilityInput } from './types.js'

const OPTIMAL_MIN_WORDS = 134
const OPTIMAL_MAX_WORDS = 167
const ACCEPTABLE_MIN_WORDS = 50
const ACCEPTABLE_MAX_WORDS = 300
const MAX_LENGTH_SCORE = 40
const DEFINITION_PATTERN_SCORE = 20
const ATTRIBUTION_SCORE = 20
const UNIQUE_DATA_SCORE = 20
const FRONT_LOAD_THRESHOLD = 0.3

const DEFINITION_PATTERNS = [
  /^(.+?)是(.+)/,
  /^(.+?)是指(.+)/,
  /^(.+?)是一种(.+)/,
  /^(.+?) refers to (.+)/i,
  /^(.+?) is a (.+)/i,
  /^(.+?) is an (.+)/i,
  /^(.+?) is defined as (.+)/i,
]

function countWords(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const nonChinese = text.replace(/[\u4e00-\u9fff]/g, ' ')
  const englishWords = nonChinese.split(/\s+/).filter((w) => w.length > 0).length
  return chineseChars + englishWords
}

function calcLengthScore(wordCount: number): number {
  if (wordCount >= OPTIMAL_MIN_WORDS && wordCount <= OPTIMAL_MAX_WORDS) {
    return MAX_LENGTH_SCORE
  }
  if (wordCount < ACCEPTABLE_MIN_WORDS || wordCount > ACCEPTABLE_MAX_WORDS) {
    return 0
  }
  if (wordCount < OPTIMAL_MIN_WORDS) {
    const ratio = (wordCount - ACCEPTABLE_MIN_WORDS) / (OPTIMAL_MIN_WORDS - ACCEPTABLE_MIN_WORDS)
    return Math.round(MAX_LENGTH_SCORE * ratio)
  }
  const ratio = (ACCEPTABLE_MAX_WORDS - wordCount) / (ACCEPTABLE_MAX_WORDS - OPTIMAL_MAX_WORDS)
  return Math.round(MAX_LENGTH_SCORE * ratio)
}

function hasDefinitionPattern(text: string): boolean {
  return DEFINITION_PATTERNS.some((p) => p.test(text.trim()))
}

export interface CitabilityService {
  score(input: CitabilityInput): CitabilityScore
  scorePassages(inputs: CitabilityInput[]): { scores: CitabilityScore[]; average: number }
}

export function createCitabilityEngine(): CitabilityService {
  return {
    score(input) {
      const wordCount = countWords(input.text)
      const lengthScore = calcLengthScore(wordCount)
      const frontLoadBonus = input.positionRatio <= FRONT_LOAD_THRESHOLD
      const defPattern = hasDefinitionPattern(input.text)
      const attribution = input.hasAttribution ?? false
      const uniqueData = input.hasUniqueData ?? false

      const total =
        lengthScore +
        (defPattern ? DEFINITION_PATTERN_SCORE : 0) +
        (attribution ? ATTRIBUTION_SCORE : 0) +
        (uniqueData ? UNIQUE_DATA_SCORE : 0)

      return {
        total,
        lengthScore,
        frontLoadBonus,
        hasDefinitionPattern: defPattern,
        hasAttribution: attribution,
        hasUniqueData: uniqueData,
      }
    },

    scorePassages(inputs) {
      const scores = inputs.map((input) => this.score(input))
      const average = scores.length > 0 ? Math.round(scores.reduce((sum, s) => sum + s.total, 0) / scores.length) : 0
      return { scores, average }
    },
  }
}

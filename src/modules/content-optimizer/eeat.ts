import type { EeatScore, EeatInput } from './types.js'

const DIMENSION_MAX = 25

function calcExperience(input: EeatInput): number {
  let score = 0
  if (input.hasOriginalResearch) score += 15
  if (input.hasCaseStudies) score += 10
  return Math.min(score, DIMENSION_MAX)
}

function calcExpertise(input: EeatInput): number {
  let score = 0
  if (input.hasAuthorByline) score += 10
  if (input.hasAuthorCredentials) score += 15
  return Math.min(score, DIMENSION_MAX)
}

function calcAuthoritativeness(input: EeatInput): number {
  let score = 0
  if (input.hasExternalCitations) score += 15
  if (input.hasBrandMentions) score += 10
  return Math.min(score, DIMENSION_MAX)
}

function calcTrustworthiness(input: EeatInput): number {
  let score = 0
  if (input.hasContactInfo) score += 8
  if (input.hasHttps) score += 5
  if (input.hasDateStamps) score += 7
  if (input.hasCorrectionsPolicy) score += 5
  return Math.min(score, DIMENSION_MAX)
}

function whoHowWhyCheck(input: EeatInput): boolean {
  const who = input.hasAuthorByline && input.hasAuthorCredentials
  const how = input.hasOriginalResearch || input.hasCaseStudies
  const why = input.hasDateStamps || input.hasCorrectionsPolicy
  return who && how && why
}

export interface EeatService {
  score(input: EeatInput): EeatScore
}

export function createEeatEngine(): EeatService {
  return {
    score(input) {
      const experience = calcExperience(input)
      const expertise = calcExpertise(input)
      const authoritativeness = calcAuthoritativeness(input)
      const trustworthiness = calcTrustworthiness(input)
      const total = experience + expertise + authoritativeness + trustworthiness
      const whoHowWhyPassed = whoHowWhyCheck(input)

      return {
        total,
        experience,
        expertise,
        authoritativeness,
        trustworthiness,
        whoHowWhyPassed,
      }
    },
  }
}

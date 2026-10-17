export function normalizeDomain(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('EMPTY_DOMAIN')

  let hostname: string
  try {
    // prepend protocol if missing for URL parser
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withProtocol)
    hostname = parsed.hostname
  } catch {
    throw new Error('INVALID_DOMAIN')
  }

  if (!hostname || !hostname.includes('.')) throw new Error('INVALID_DOMAIN')
  return hostname.replace(/^www\./i, '').toLowerCase()
}

export function normalizeQueryText(text: string): string {
  let result = text.trim()
  // collapse multiple whitespace into single space
  result = result.replace(/\s+/g, ' ')
  // normalize fullwidth latin letters to halfwidth
  result = result.replace(/[\uFF21-\uFF3A]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  )
  result = result.replace(/[\uFF41-\uFF5A]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  )
  // normalize fullwidth question mark
  result = result.replace(/？/g, '?')
  // lowercase
  result = result.toLowerCase()
  return result
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function validateBrandCompetitors(
  brandName: string,
  brandAliases: string[],
  competitors: Array<{ name: string; domain?: string; aliases?: string[] }>,
): void {
  const brandNames = [brandName, ...brandAliases].map(normalizeName)
  const competitorNames = competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]).map(normalizeName)

  for (const bn of brandNames) {
    for (const cn of competitorNames) {
      if (bn === cn) {
        throw new Error('BRAND_COMPETITOR_CONFLICT')
      }
    }
  }
}

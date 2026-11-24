import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '../../integrations/workbuddy')

function readJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

function walk(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) files.push(...walk(abs))
    else files.push(abs)
  }
  return files
}

describe('WorkBuddy packet', () => {
  it('connector metadata matches the token-mode schema', () => {
    const meta = readJson('connector/connector-meta.json')
    expect(meta).toMatchObject({
      source: 'geociteops',
      type: 'mcp',
      auth_mode: 'token',
      minWorkbuddyVersion: '4.23.0',
      name_en: 'GeoCiteOps',
    })
    expect(meta.description_zh.length).toBeGreaterThanOrEqual(20)
    expect(meta.description_zh.length).toBeLessThanOrEqual(100)
    expect(meta.description_en.length).toBeGreaterThanOrEqual(20)
    expect(meta.examples_zh.length).toBeGreaterThanOrEqual(2)
    expect(meta.examples_en.length).toBeGreaterThanOrEqual(2)
    expect(meta.server_auth).toBeUndefined()

    const mcp = readJson('connector/mcp.json')
    const servers = Object.values(mcp.mcpServers) as Array<Record<string, unknown>>
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({
      type: 'streamableHttp',
      url: '${API_BASE_URL}/mcp',
      headers: { Authorization: 'Bearer ${API_KEY}' },
    })

    const form = readJson('connector/token-schema.json')
    expect(form.title).toBeTruthy()
    expect(form.description).toBeTruthy()
    expect(form.docUrl).toMatch(/^https:\/\//)
    const secret = form.fields.find((field: { key: string }) => field.key === 'API_KEY')
    expect(secret.type).toBe('password')
    expect(secret.required).toBe(true)
  })

  it('expert plugin matches the documented expert fields', () => {
    const plugin = readJson('expert/.codebuddy-plugin/plugin.json')
    expect(plugin.expertType).toBe('agent')
    expect(plugin.agentName).toBe('geo-advisor')
    expect(plugin.plugin).toBe(plugin.name)
    expect(plugin.displayName.zh).toBe('GEO 顾问')
    expect([...plugin.displayDescription.zh].length).toBeGreaterThanOrEqual(40)
    expect([...plugin.displayDescription.zh].length).toBeLessThanOrEqual(50)
    expect(plugin.defaultInitPrompt).toEqual({
      zh: plugin.quickPrompts[0].zh,
      en: plugin.quickPrompts[0].en,
    })
    expect(plugin.tags).toHaveLength(3)
    expect(plugin.quickPrompts).toHaveLength(3)
    expect(plugin.categoryId).toBe('05-MarketingGrowth')
    expect(plugin.avatar).toBe('avatars/expert.png')

    const avatar = statSync(join(root, 'expert/avatars/expert.png'))
    expect(avatar.size).toBeLessThan(500 * 1024)
    const png = readFileSync(join(root, 'expert/avatars/expert.png'))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(512)
    expect(png.readUInt32BE(20)).toBe(512)
  })

  it('skill frontmatter has the market fields and the tree has no live token', () => {
    for (const skill of ['geo-health-check', 'agent-readiness-audit', 'llms-txt-jsonld']) {
      const text = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8')
      for (const field of ['name:', 'display_name:', 'display_name_en:', 'description:', 'description_zh:', 'description_en:', 'version:', 'author:']) {
        expect(text).toContain(field)
      }
    }
    const blob = walk(root)
      .filter((file) => !file.endsWith('.png'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(blob).not.toMatch(/geo_[0-9a-f]{16,}/i)
  })

  it('builds upload zips whose roots contain the required files', () => {
    execFileSync(process.execPath, [join(root, 'build-zips.mjs')], { cwd: join(root, '../..') })
    const connector = readFileSync(join(root, 'dist/geociteops-connector.zip'))
    for (const name of ['connector-meta.json', 'mcp.json', 'token-schema.json', 'icon.svg', 'skills/geo-health/SKILL.md']) {
      expect(connector.includes(Buffer.from(name))).toBe(true)
    }
    const expert = readFileSync(join(root, 'dist/geociteops-expert.zip'))
    for (const name of ['.codebuddy-plugin/plugin.json', 'agents/geo-advisor.md', 'avatars/expert.png', 'skills/geo-health/SKILL.md']) {
      expect(expert.includes(Buffer.from(name))).toBe(true)
    }
    const skill = readFileSync(join(root, 'dist/geociteops-skill-geo-health-check.zip'))
    expect(skill.includes(Buffer.from('geo-health-check/SKILL.md'))).toBe(true)
  })
})

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createFilesService,
  FILE_CONTENT_TYPES,
  FILE_KEY_PATTERN,
  InvalidFileKeyError,
} from './files.js'

/**
 * 任务 5：files 服务（对公转账回单落盘 + key 防路径穿越）。
 * 真实临时目录写盘（mkdir -p 递归 / 内容一致），resolvePath 白名单穷举。
 */

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(nested = false): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), 'geo-files-'))
  tempDirs.push(base)
  return nested ? path.join(base, 'deep', 'nested', 'uploads') : base
}

describe('createFilesService.put（写盘）', () => {
  it("返回 key = 32 位十六进制 + '.' + ext（randomUUID 去连字符），文件写入 dir 且内容一致", async () => {
    const dir = await makeTempDir()
    const service = createFilesService({ dir })
    const buffer = Buffer.from('fake-png-bytes')

    const key = await service.put(buffer, 'png')

    expect(key).toMatch(FILE_KEY_PATTERN)
    expect(key.endsWith('.png')).toBe(true)
    // 文件确实落在 dir 下（resolvePath 同源校验）
    const filePath = service.resolvePath(key)
    expect(path.dirname(filePath)).toBe(path.resolve(dir))
    await expect(readFile(filePath)).resolves.toEqual(buffer)
  })

  it('三个白名单扩展（png/jpg/pdf）各产出对应后缀的 key', async () => {
    const dir = await makeTempDir()
    const service = createFilesService({ dir })
    for (const ext of ['png', 'jpg', 'pdf'] as const) {
      const key = await service.put(Buffer.from('x'), ext)
      expect(key).toMatch(FILE_KEY_PATTERN)
      expect(key.endsWith(`.${ext}`)).toBe(true)
    }
  })

  it('key 全局不碰撞：连续 put 两次 key 不同（randomUUID 熵）', async () => {
    const dir = await makeTempDir()
    const service = createFilesService({ dir })
    const k1 = await service.put(Buffer.from('a'), 'pdf')
    const k2 = await service.put(Buffer.from('b'), 'pdf')
    expect(k1).not.toBe(k2)
  })

  it('dir 不存在时递归创建（mkdir -p 多级）', async () => {
    const dir = await makeTempDir(true)
    const service = createFilesService({ dir })
    const key = await service.put(Buffer.from('nested'), 'jpg')
    await expect(stat(service.resolvePath(key))).resolves.toBeTruthy()
  })

  it('dir 缺省读 env GEO_UPLOAD_DIR', async () => {
    const dir = await makeTempDir()
    vi.stubEnv('GEO_UPLOAD_DIR', dir)
    try {
      const service = createFilesService({})
      const key = await service.put(Buffer.from('env'), 'png')
      expect(service.resolvePath(key)).toBe(path.join(dir, key))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('createFilesService.resolvePath（防路径穿越 / 白名单）', () => {
  it('合法 key → path.join(dir, key)', () => {
    const service = createFilesService({ dir: './data/uploads' })
    const key = `${'a1b2c3d4'.repeat(4)}.pdf`
    expect(service.resolvePath(key)).toBe(path.join('./data/uploads', key))
  })

  it.each([
    ['../x', '相对上跳'],
    ['..\\x', 'Windows 反斜杠上跳'],
    [`${'a'.repeat(31)}.png`, '十六进制段 31 位（过短）'],
    [`${'a'.repeat(33)}.png`, '十六进制段 33 位（过长）'],
    [`${'g'.repeat(32)}.png`, '非十六进制字符 g'],
    [`${'A'.repeat(32)}.png`, '大写十六进制（key 生成恒小写）'],
    [`${'a'.repeat(32)}.gif`, '白名单外扩展 gif'],
    [`${'a'.repeat(32)}.PNG`, '扩展名大写'],
    [`${'a'.repeat(32)}`, '无扩展名'],
    [`${'a'.repeat(32)}.png.exe`, '双扩展（附加段）'],
    ['', '空串'],
    ['%2e%2e%2fx.png', 'URL 编码上跳'],
    [`${'a'.repeat(32)}.png/../../etc/passwd`, '尾接上跳路径'],
  ])('key=%s（%s）→ InvalidFileKeyError', (key) => {
    const service = createFilesService({ dir: './data/uploads' })
    expect(() => service.resolvePath(key)).toThrow(InvalidFileKeyError)
  })
})

describe('createFilesService.remove（孤儿文件清理，遗留 D6）', () => {
  it('put 后 remove：盘上文件消失，其余文件不受影响', async () => {
    const dir = await makeTempDir()
    const service = createFilesService({ dir })
    const kept = await service.put(Buffer.from('kept'), 'png')
    const removed = await service.put(Buffer.from('removed'), 'png')

    await service.remove(removed)

    await expect(stat(service.resolvePath(kept))).resolves.toBeTruthy()
    await expect(stat(service.resolvePath(removed))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('文件不存在 → unlink 的 ENOENT 原样上抛（由调用方兜底）', async () => {
    const dir = await makeTempDir()
    const service = createFilesService({ dir })
    const key = await service.put(Buffer.from('x'), 'png')
    await service.remove(key)

    await expect(service.remove(key)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['../x', '相对上跳'],
    [`${'a'.repeat(32)}.gif`, '白名单外扩展'],
    [`${'a'.repeat(31)}.png`, '十六进制段过短'],
  ])('key=%s（%s）→ InvalidFileKeyError（防路径穿越同 resolvePath）', (key) => {
    const service = createFilesService({ dir: './data/uploads' })
    expect(service.remove(key)).rejects.toThrow(InvalidFileKeyError)
  })
})

describe('常量导出', () => {
  it('FILE_CONTENT_TYPES：png/jpg/pdf → image/png|image/jpeg|application/pdf', () => {
    expect(FILE_CONTENT_TYPES).toEqual({
      png: 'image/png',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
    })
  })

  it('FILE_KEY_PATTERN 与 32 位小写十六进制 + 白名单扩展全匹配', () => {
    expect(FILE_KEY_PATTERN.test(`${'0f'.repeat(16)}.png`)).toBe(true)
    expect(FILE_KEY_PATTERN.test(`${'0f'.repeat(16)}.jpg`)).toBe(true)
    expect(FILE_KEY_PATTERN.test(`${'0f'.repeat(16)}.pdf`)).toBe(true)
    expect(FILE_KEY_PATTERN.test(`${'0f'.repeat(16)}.txt`)).toBe(false)
  })
})

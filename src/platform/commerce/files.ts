import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * files 服务（任务 5）：对公转账回单等平台文件的落盘与解析。
 *
 * key 设计 = randomUUID 去连字符（32 位小写十六进制）+ '.' + 白名单扩展，
 * 全量正则校验（^[0-9a-f]{32}\.(png|jpg|pdf)$）使路径穿越在形态上即不可能：
 * 任何包含路径分隔符 / 大写 / 白名单外扩展 / 长度偏差的 key 都在
 * resolvePath 被拒（InvalidFileKeyError），path.join 永远只拼出 dir 下的平面文件名。
 */

/** 白名单扩展（回单截图/扫描件） */
export type FileExt = 'png' | 'jpg' | 'pdf'

/** key 全量形态：32 位小写十六进制 + 白名单扩展（put 产出、resolvePath 消费） */
export const FILE_KEY_PATTERN = /^[0-9a-f]{32}\.(png|jpg|pdf)$/

/** 扩展 → Content-Type（GET /files/:key 流式回传用） */
export const FILE_CONTENT_TYPES: Record<FileExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
}

/** 上传目录默认值：env GEO_UPLOAD_DIR，再回落 ./data/uploads（相对进程 CWD） */
export const DEFAULT_UPLOAD_DIR = './data/uploads'

/** 非法文件 key（形态不符 / 疑似路径穿越）：name 固定为 INVALID_FILE_KEY */
export class InvalidFileKeyError extends Error {
  constructor(key: string) {
    super(`非法文件 key（仅允许 32 位十六进制 + png/jpg/pdf 扩展）：${JSON.stringify(key)}`)
    this.name = 'INVALID_FILE_KEY'
  }
}

export interface FilesService {
  /** 写盘（mkdir -p 递归建目录）并返回 key */
  put(buffer: Buffer, ext: FileExt): Promise<string>
  /**
   * 删除 key 对应的盘上文件（遗留 D6：落库失败后的孤儿文件清理）。
   * key 形态校验同 resolvePath（防路径穿越）；文件不存在 / 权限等 IO 异常
   * 原样上抛，由调用方兜底（尽力而为清理，不掩盖业务错误）。
   */
  remove(key: string): Promise<void>
  /** key → 绝对/相对磁盘路径；形态校验失败抛 InvalidFileKeyError（防路径穿越） */
  resolvePath(key: string): string
}

export function createFilesService(opts: { dir?: string } = {}): FilesService {
  const dir = opts.dir ?? process.env.GEO_UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR
  const resolvePath = (key: string): string => {
    if (typeof key !== 'string' || !FILE_KEY_PATTERN.test(key)) {
      throw new InvalidFileKeyError(key)
    }
    return path.join(dir, key)
  }
  return {
    async put(buffer, ext) {
      const key = `${randomUUID().replace(/-/g, '')}.${ext}`
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, key), buffer)
      return key
    },

    async remove(key) {
      await unlink(resolvePath(key))
    },

    resolvePath,
  }
}

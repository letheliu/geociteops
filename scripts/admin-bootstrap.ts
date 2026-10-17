// 创建平台超级管理员账号（任务 8）：默认 readline 交互输入，幂等安全（username 已存在报错退出，不覆盖）。
// 用法:
//   pnpm admin:bootstrap                                    # 交互模式（TTY）
//   pnpm admin:bootstrap --username admin --password <pw>   # 非交互模式（CI/管道 stdin）
// 可选: --display-name <name>（非交互模式下指定显示名，默认同用户名）
// 交互模式下 --username/--display-name 作为预填值（有值则跳过对应提问，只交互补密码）。
// 依赖: .env 中 DATABASE_URL；密码走 argon2id 哈希入库，绝不落日志。
// 非交互模式密码同样须通过密码策略（≥10 位、不包含用户名）；策略不过则退出 1。

import 'dotenv/config'
import { Writable } from 'node:stream'
import readline from 'node:readline/promises'
import { stdin } from 'node:process'
import { PrismaClient } from '@prisma/client'
import { validatePasswordPolicy } from '../src/core/auth/password.js'
import { createSessionService } from '../src/core/auth/session.js'
import { createAuditService } from '../src/platform/audit/service.js'
import { createIdentityService } from '../src/platform/identity/service.js'
import { createLoginRateLimiter } from '../src/platform/identity/rate-limiter.js'

/** 解析 CLI 参数：--key value 形式，未知参数报错（防止静默拼错） */
function parseArgs(argv: string[]): { username?: string; password?: string; displayName?: string } {
  const out: { username?: string; password?: string; displayName?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = argv[i + 1]
    if (arg === '--username' || arg === '--password' || arg === '--display-name') {
      if (!next || next.startsWith('--')) {
        console.error(`参数 ${arg} 缺少取值`)
        process.exit(1)
      }
      if (arg === '--username') out.username = next
      else if (arg === '--password') out.password = next
      else out.displayName = next
      i++
    } else {
      console.error(`未知参数：${arg}（支持 --username/--password/--display-name）`)
      process.exit(1)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

/** 静音输出流：muted=true 时丢弃回显（密码输入不可见），提示语与普通问答不受影响 */
let outputMuted = false
const maskedStdout = new Writable({
  write(chunk, _encoding, callback) {
    if (!outputMuted) process.stdout.write(chunk)
    callback()
  },
})

let rl: ReturnType<typeof readline.createInterface> | undefined

function getReadline(): ReturnType<typeof readline.createInterface> {
  if (!rl) {
    rl = readline.createInterface({
      input: stdin,
      output: maskedStdout as unknown as NodeJS.WriteStream,
    })
  }
  return rl
}

async function askVisible(prompt: string): Promise<string> {
  const answer = await getReadline().question(prompt)
  return answer.trim()
}

async function askHidden(prompt: string): Promise<string> {
  outputMuted = false
  const pending = getReadline().question(prompt) // 提示语同步写出后才静音
  outputMuted = true
  const answer = await pending
  outputMuted = false
  process.stdout.write('\n') // 静音吞掉了回车换行，补一个
  return answer
}

async function askPassword(username: string): Promise<string> {
  for (;;) {
    const password = await askHidden('密码（≥10 位，不包含用户名）: ')
    const confirm = await askHidden('再次输入密码: ')
    if (password !== confirm) {
      console.error('两次输入不一致，请重试')
      continue
    }
    const policy = validatePasswordPolicy(password, username)
    if (!policy.ok) {
      console.error(`密码不符合策略：${policy.reason}，请重试`)
      continue
    }
    return password
  }
}

async function main(): Promise<number> {
  console.log('=== 创建平台超级管理员（SUPER_ADMIN） ===')

  let username: string
  let displayName: string
  let password: string

  if (args.password !== undefined) {
    // 非交互路径：--password 必须搭配 --username（显示名可缺省）
    if (args.username === undefined) {
      console.error('非交互模式：--password 必须搭配 --username 使用')
      return 1
    }
    username = args.username
    displayName = args.displayName || username
    password = args.password
    const policy = validatePasswordPolicy(password, username)
    if (!policy.ok) {
      console.error(`密码不符合策略：${policy.reason}`)
      return 1
    }
  } else {
    // 交互路径：非 TTY（管道/重定向 stdin）下 readline 无法可靠工作，显式报错而非静默失败
    if (!stdin.isTTY) {
      console.error(
        '检测到 stdin 非 TTY：交互式输入不可用。请改用非交互模式：pnpm admin:bootstrap --username <u> --password <pw>',
      )
      return 1
    }
    // 交互路径：--username/--display-name 预填（有值则跳过对应提问，避免 README 首推命令在 TTY 下重复询问）
    if (args.username !== undefined) {
      username = args.username
      console.log(`用户名：${username}（来自 --username 参数）`)
    } else {
      username = await askVisible('用户名（3-64 字符）: ')
    }
    if (args.displayName !== undefined) {
      displayName = args.displayName
    } else {
      displayName = (await askVisible('显示名（回车默认同用户名）: ')) || username
    }
    password = await askPassword(username)
    rl?.close()
  }

  if (username.length < 3 || username.length > 64) {
    console.error('用户名长度须在 3-64 之间')
    return 1
  }

  const prisma = new PrismaClient()
  try {
    // 幂等预检：已存在则报错退出，绝不覆盖（并发窗口由 service 的 P2002 捕获兜底）
    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    })
    if (existing) {
      console.error(`用户名 "${username}" 已存在，未做任何修改`)
      return 1
    }

    const identity = createIdentityService({
      prisma,
      sessions: createSessionService(prisma),
      audit: createAuditService(prisma),
      loginRateLimiter: createLoginRateLimiter(),
    })
    const { user } = await identity.createUser({
      username,
      displayName,
      platformRole: 'SUPER_ADMIN',
      password, // 显式密码，不走临时密码；仍须通过密码策略
    })
    console.log(`已创建超级管理员：${user.username}（id=${user.id}）`)
    console.log('请用该账号登录平台并在首次登录后修改密码。')
    return 0
  } finally {
    await prisma.$disconnect()
  }
}

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    console.error('创建失败：', error instanceof Error ? error.message : error)
    process.exit(1)
  })

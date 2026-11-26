import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist')

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/** Stored-method zip. Names are ASCII. */
export function zipStore(files) {
  const now = dosTime(new Date('2026-11-24T00:00:00Z'))
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = file.data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(Buffer.concat([local, name, data]))
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(now.time, 12)
    central.writeUInt16LE(now.day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    offset += locals[locals.length - 1].length
  }
  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralDir, end])
}

function walk(dir, prefix) {
  const files = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(abs).isDirectory()) files.push(...walk(abs, rel))
    else files.push({ name: rel, data: readFileSync(abs) })
  }
  return files
}

function writeZip(filename, files) {
  const target = join(outDir, filename)
  writeFileSync(target, zipStore(files))
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex').slice(0, 12)
  console.log(`${filename}  ${files.length} files  ${digest}`)
  return target
}

export function buildWorkbuddyZips() {
  mkdirSync(outDir, { recursive: true })
  const written = []
  written.push(writeZip('geociteops-connector.zip', walk(join(root, 'connector'), '')))
  const market = join(root, 'skills')
  for (const name of readdirSync(market)) {
    const dir = join(market, name)
    if (!statSync(dir).isDirectory()) continue
    written.push(writeZip(`geociteops-skill-${name}.zip`, walk(dir, name)))
  }
  const expertFiles = [
    ...walk(join(root, 'expert'), ''),
    ...walk(join(root, 'connector', 'skills'), 'skills'),
  ]
  written.push(writeZip('geociteops-expert.zip', expertFiles))
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildWorkbuddyZips()
}

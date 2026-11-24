import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const size = 512

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}

const raw = Buffer.alloc((size * 4 + 1) * size)

function set(x, y, r, g, b, a = 255) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= size || py >= size) return
  const i = py * (size * 4 + 1) + 1 + px * 4
  raw[i] = r
  raw[i + 1] = g
  raw[i + 2] = b
  raw[i + 3] = a
}

function fillCircle(cx, cy, radius, color) {
  const r2 = radius * radius
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r2) set(x, y, color[0], color[1], color[2], color[3] ?? 255)
    }
  }
}

function fillRoundRect(x, y, w, h, radius, color) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const dx = px < x + radius ? x + radius - px : px > x + w - radius ? px - (x + w - radius) : 0
      const dy = py < y + radius ? y + radius - py : py > y + h - radius ? py - (y + h - radius) : 0
      if (dx * dx + dy * dy <= radius * radius) set(px, py, color[0], color[1], color[2])
    }
  }
}

const ink = [15, 23, 42]
const paper = [248, 250, 252]
const teal = [14, 165, 164]
const green = [34, 197, 94]
const sky = [125, 211, 252]

fillCircle(256, 256, 240, ink)
fillCircle(256, 210, 78, paper)
fillRoundRect(168, 268, 176, 150, 70, paper)
fillRoundRect(196, 318, 120, 86, 12, teal)
for (let i = 0; i < 3; i++) fillRoundRect(214, 336 + i * 18, 84, 8, 4, paper)
fillCircle(214, 292, 16, green)
fillCircle(298, 292, 16, sky)

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0)
ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = join(dirname(fileURLToPath(import.meta.url)), '../expert/avatars/expert.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)

#!/usr/bin/env node
// Generates the app + tray icons procedurally. No dependencies: shapes are
// signed-distance functions sampled per pixel (anti-aliased by coverage) and
// PNGs are encoded by hand with zlib + CRC32.
//
//   node scripts/gen-icons.mjs
//
// Outputs:
//   resources/icons/trayTemplate.png      16x16  macOS menu-bar template (black + alpha)
//   resources/icons/trayTemplate@2x.png   32x32
//   resources/icons/icon.png              512x512 app icon
//   build/icon.png                        1024x1024 app icon (electron-builder)

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** rgba: Uint8Array of width*height*4, straight (non-premultiplied) alpha. */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------- SDF helpers
// All shapes are authored in a 1024x1024 design space; distances are in design
// units and converted to pixels when computing coverage.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const mix = (a, b, t) => a + (b - a) * t
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

const sdEllipse = (x, y, cx, cy, rx, ry) => {
  // cheap approximation, accurate near the boundary (good enough for AA)
  const k0 = Math.hypot((x - cx) / rx, (y - cy) / ry)
  const k1 = Math.hypot((x - cx) / (rx * rx), (y - cy) / (ry * ry))
  return k1 === 0 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1
}

const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

// Signed distance to a triangle (Inigo Quilez).
function sdTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const e0x = bx - ax, e0y = by - ay
  const e1x = cx - bx, e1y = cy - by
  const e2x = ax - cx, e2y = ay - cy
  const v0x = x - ax, v0y = y - ay
  const v1x = x - bx, v1y = y - by
  const v2x = x - cx, v2y = y - cy
  const h = (vx, vy, ex, ey) => clamp((vx * ex + vy * ey) / (ex * ex + ey * ey), 0, 1)
  const h0 = h(v0x, v0y, e0x, e0y), h1 = h(v1x, v1y, e1x, e1y), h2 = h(v2x, v2y, e2x, e2y)
  const p0x = v0x - e0x * h0, p0y = v0y - e0y * h0
  const p1x = v1x - e1x * h1, p1y = v1y - e1y * h1
  const p2x = v2x - e2x * h2, p2y = v2y - e2y * h2
  const s = Math.sign(e0x * e2y - e0y * e2x)
  const d0 = [p0x * p0x + p0y * p0y, s * (v0x * e0y - v0y * e0x)]
  const d1 = [p1x * p1x + p1y * p1y, s * (v1x * e1y - v1y * e1x)]
  const d2 = [p2x * p2x + p2y * p2y, s * (v2x * e2y - v2y * e2x)]
  const dist = Math.min(d0[0], d1[0], d2[0])
  const side = Math.min(d0[1], d1[1], d2[1])
  return -Math.sqrt(dist) * Math.sign(side)
}

// Thick circular arc (a smile) between angles a0..a1 (radians, y down), round caps.
function sdArc(x, y, cx, cy, R, halfWidth, a0, a1) {
  const ang = Math.atan2(y - cy, x - cx)
  if (ang >= a0 && ang <= a1) return Math.abs(Math.hypot(x - cx, y - cy) - R) - halfWidth
  const e0 = Math.hypot(x - (cx + R * Math.cos(a0)), y - (cy + R * Math.sin(a0)))
  const e1 = Math.hypot(x - (cx + R * Math.cos(a1)), y - (cy + R * Math.sin(a1)))
  return Math.min(e0, e1) - halfWidth
}

const smin = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1)
  return mix(b, a, h) - k * h * (1 - h)
}
const union = Math.min
const subtract = (a, b) => Math.max(a, -b)

// ---------------------------------------------------------------- rasteriser

/**
 * Render a stack of layers. Each layer: { sdf(x,y) -> design-units distance,
 * color: [r,g,b] | (x,y) => [r,g,b], alpha?: number, blur?: design units }.
 * Coordinates passed to sdf/color are in 1024 design space.
 */
function render(size, layers) {
  const out = new Uint8Array(size * size * 4)
  const scale = 1024 / size // design units per pixel
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * scale
      const y = (py + 0.5) * scale
      // premultiplied accumulator
      let r = 0, g = 0, b = 0, a = 0
      for (const L of layers) {
        const d = L.sdf(x, y)
        let cov
        if (L.blur) cov = 1 - smoothstep(-L.blur, L.blur, d)
        else cov = clamp(0.5 - d / scale, 0, 1)
        if (cov <= 0) continue
        const la = cov * (L.alpha ?? 1)
        const c = typeof L.color === 'function' ? L.color(x, y) : L.color
        r = c[0] * la + r * (1 - la)
        g = c[1] * la + g * (1 - la)
        b = c[2] * la + b * (1 - la)
        a = la + a * (1 - la)
      }
      const i = (py * size + px) * 4
      if (a > 0) {
        out[i] = Math.round(clamp(r / a, 0, 255))
        out[i + 1] = Math.round(clamp(g / a, 0, 255))
        out[i + 2] = Math.round(clamp(b / a, 0, 255))
      }
      out[i + 3] = Math.round(clamp(a, 0, 1) * 255)
    }
  }
  return out
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const lerpColor = (c0, c1, t) => [mix(c0[0], c1[0], t), mix(c0[1], c1[1], t), mix(c0[2], c1[2], t)]

// ---------------------------------------------------------------- tray icon
// Speech bubble with two eye dots punched out. Pure black + alpha so macOS can
// tint it for light/dark menu bars.

function trayShape(x, y) {
  const body = sdRoundRect(x, y, 512, 440, 450, 330, 230)
  const tail = sdTriangle(x, y, [110, 560], [470, 700], [130, 990])
  const bubble = smin(body, tail, 40)
  const eyes = union(sdCircle(x, y, 350, 440, 92), sdCircle(x, y, 674, 440, 92))
  return subtract(bubble, eyes)
}

function renderTray(size) {
  return render(size, [{ sdf: trayShape, color: [0, 0, 0] }])
}

// ---------------------------------------------------------------- app icon

const BG_TOP = hex('#8F7BFF')
const BG_BOTTOM = hex('#43C6EE')
const INK = hex('#2A2350')

function appLayers() {
  const tile = (x, y) => sdRoundRect(x, y, 512, 512, 412, 412, 186)

  const bubbleBody = (x, y) => sdRoundRect(x, y, 512, 478, 286, 214, 170)
  const bubbleTail = (x, y) => sdTriangle(x, y, [244, 560], [470, 662], [258, 806])
  const bubble = (x, y) => smin(bubbleBody(x, y), bubbleTail(x, y), 36)

  return [
    // soft drop shadow beneath the tile
    { sdf: (x, y) => tile(x, y - 14), color: [20, 16, 60], alpha: 0.35, blur: 22 },
    // tile with diagonal gradient + gentle top glow
    {
      sdf: tile,
      color: (x, y) => {
        const t = clamp((x * 0.35 + y * 0.65 - 100) / 824, 0, 1)
        const base = lerpColor(BG_TOP, BG_BOTTOM, t)
        const glow = smoothstep(560, 0, Math.hypot(x - 380, y - 180)) * 0.22
        return lerpColor(base, [255, 255, 255], glow)
      }
    },
    // inner rim highlight along the top edge
    {
      sdf: (x, y) => Math.max(tile(x, y), -tile(x, y - 8)),
      color: [255, 255, 255],
      alpha: 0.25
    },
    // bubble shadow
    { sdf: (x, y) => bubble(x - 6, y - 26), color: [30, 20, 90], alpha: 0.28, blur: 26 },
    // bubble
    {
      sdf: bubble,
      color: (x, y) => lerpColor([255, 255, 255], hex('#EDEBFF'), smoothstep(300, 760, y))
    },
    // eyes
    { sdf: (x, y) => union(sdEllipse(x, y, 416, 448, 44, 58), sdEllipse(x, y, 608, 448, 44, 58)), color: INK },
    // eye highlights
    { sdf: (x, y) => union(sdCircle(x, y, 402, 428, 15), sdCircle(x, y, 594, 428, 15)), color: [255, 255, 255] },
    // cheeks
    {
      sdf: (x, y) => union(sdEllipse(x, y, 336, 540, 42, 24), sdEllipse(x, y, 688, 540, 42, 24)),
      color: hex('#FF8FB1'),
      alpha: 0.6
    },
    // smile
    { sdf: (x, y) => sdArc(x, y, 512, 488, 82, 17, Math.PI * 0.22, Math.PI * 0.78), color: INK },
    // little sparkle top-right of the bubble
    {
      sdf: (x, y) => {
        const cx = 760, cy = 236, dx = Math.abs(x - cx), dy = Math.abs(y - cy)
        // 4-point star: union of two thin diamonds with a soft center
        const d1 = (dx / 18 + dy / 70 - 1) * 18
        const d2 = (dx / 70 + dy / 18 - 1) * 18
        return smin(d1, d2, 10)
      },
      color: [255, 255, 255],
      alpha: 0.9
    }
  ]
}

// ---------------------------------------------------------------- main

function write(rel, size, rgba) {
  const file = join(ROOT, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodePNG(size, size, rgba))
  console.log(`wrote ${rel} (${size}x${size})`)
}

write('resources/icons/trayTemplate.png', 16, renderTray(16))
write('resources/icons/trayTemplate@2x.png', 32, renderTray(32))
const layers = appLayers()
write('resources/icons/icon.png', 512, render(512, layers))
write('build/icon.png', 1024, render(1024, layers))

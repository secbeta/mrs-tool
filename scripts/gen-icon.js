// Generates media/icon.png (128x128 marketplace icon) without image deps:
// a blue rounded square with a chip and gold core, matching media/wch.svg.
// Usage: node scripts/gen-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 128;
const H = 128;
const px = Buffer.alloc(W * H * 4, 0);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x >= rx + w || y >= ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundRect(rx, ry, w, h, r, [R, G, B]) {
  for (let y = ry; y < ry + h; y++) {
    for (let x = rx; x < rx + w; x++) {
      if (inRoundRect(x, y, rx, ry, w, h, r)) set(x, y, R, G, B);
    }
  }
}

function fillRect(rx, ry, w, h, [R, G, B]) {
  for (let y = ry; y < ry + h; y++) {
    for (let x = rx; x < rx + w; x++) set(x, y, R, G, B);
  }
}

const BLUE = [37, 99, 235];    // #2563eb background
const LIGHT = [219, 234, 254]; // #dbeafe chip body
const GOLD = [245, 158, 11];   // #f59e0b core
const WHITE = [255, 255, 255];

fillRoundRect(4, 4, 120, 120, 26, BLUE);
// chip pins (3 per side, white)
for (const c of [46, 61, 76]) {
  fillRect(c - 3, 16, 6, 18, WHITE);   // top
  fillRect(c - 3, 94, 6, 18, WHITE);   // bottom
  fillRect(16, c - 3, 18, 6, WHITE);   // left
  fillRect(94, c - 3, 18, 6, WHITE);   // right
}
fillRoundRect(34, 34, 60, 60, 10, LIGHT);
fillRoundRect(52, 52, 24, 24, 5, GOLD);

// ---- minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);

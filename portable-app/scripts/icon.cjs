// Generate the existing Wordwell W mark as a multi-size Windows icon. No extra
// image tools or third-party runtime dependency is needed for this code-native art.
const { deflateSync } = require('node:zlib');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function distance(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
function png(size) {
  const points = [[8.5, 13], [13.5, 28], [20, 17], [26.5, 28], [31.5, 13]];
  const pixels = Buffer.alloc(size * (1 + size * 4));
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let alpha = 0, white = 0, gold = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const x = (col + (sx + .5) / 4) * 40 / size, y = (row + (sy + .5) / 4) * 40 / size;
      const rounded = Math.hypot(Math.max(0, Math.abs(x - 20) - 9), Math.max(0, Math.abs(y - 20) - 9)) <= 9;
      if (!rounded) continue;
      alpha++;
      if (Math.hypot(x - 31.5, y - 9.5) <= 2.3) gold++;
      else if (points.slice(1).some((point, i) => distance(x, y, points[i], point) < 1.55)) white++;
    }
    const at = row * (1 + size * 4) + 1 + col * 4;
    const grad = Math.max(0, Math.min(1, (col + row) / Math.max(1, (size - 1) * 2)));
    let r = 79 + (37 - 79) * grad, g = 70 + (48 - 70) * grad, b = 229 + (156 - 229) * grad;
    if (alpha) {
      const wMix = white / alpha, gMix = gold / alpha;
      r = r * (1 - wMix - gMix) + 255 * wMix + 251 * gMix;
      g = g * (1 - wMix - gMix) + 255 * wMix + 191 * gMix;
      b = b * (1 - wMix - gMix) + 255 * wMix + 36 * gMix;
    }
    pixels[at] = Math.round(r); pixels[at + 1] = Math.round(g); pixels[at + 2] = Math.round(b); pixels[at + 3] = Math.round(alpha / 16 * 255);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 32, 48, 256], images = sizes.map(png);
const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => { const at = 6 + 16 * i; header[at] = header[at + 1] = size % 256; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(images[i].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += images[i].length; });
const directory = path.resolve(__dirname, '../build'); mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, 'wordwell.ico'), Buffer.concat([header, ...images]));

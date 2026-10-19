// Renders the extension icons (bolt on a volt-gradient tile) to apps/extension/icons/*.png.
// No dependencies: supersampled rasterizer + a minimal PNG encoder. Usage: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/extension/icons");
mkdirSync(out, { recursive: true });

// Same geometry as the logo in popup.html (36x36 viewBox), normalised to 0..1.
const BOLT = [[19.5, 6.5], [8.6, 20], [17, 20], [15.6, 29.5], [27.4, 15.6], [18.6, 15.6]].map(([x, y]) => [x / 36, y / 36]);
const TOP = [0xdd, 0xff, 0x6e];
const BOTTOM = [0x7b, 0xf0, 0xb4];
const INK = [0x0b, 0x0d, 0x10];
const RADIUS = 0.25; // of the side, same as rx=9/36

function insideTile(x, y) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - RADIUS), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - RADIUS), 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function insideBolt(x, y) {
  let inside = false;
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i];
    const [xj, yj] = BOLT[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function render(size) {
  const ss = size <= 32 ? 8 : 4; // more samples where pixels are scarce
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!insideTile(x, y)) continue;
          const t = (x + y) / 2;
          const c = insideBolt(x, y) ? INK : TOP.map((v, k) => v + (BOTTOM[k] - v) * t);
          a++; r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (py * size + pxl) * 4;
      const total = ss * ss;
      px[o] = a ? Math.round(r / a) : 0;
      px[o + 1] = a ? Math.round(g / a) : 0;
      px[o + 2] = a ? Math.round(b / a) : 0;
      px[o + 3] = Math.round((a / total) * 255);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(out, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log("wrote", path.relative(process.cwd(), file));
}

// Renders the Chrome Web Store creative into store/assets/:
//   icon-128.png (96px artwork + 16px transparent padding), screenshot-1..5.jpg (1280x800),
//   promo-small-440x280.jpg, promo-marquee-1400x560.jpg.
//
//   node scripts/make-store-assets.mjs        (needs apps/extension/dist built and a Playwright Chromium)
//
// The popup in the images is the REAL popup.html rendered against a stubbed chrome API
// (store/templates/chrome-stub.js), so nothing on your machine (servers, tabs, accounts) appears.
// Screenshots are JPEG so they carry no alpha channel, as the store's image guidance asks.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

import { launchChrome } from "../bench/src/chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "store/assets");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FRAMES = [
  { hash: "s1", file: "screenshot-1.jpg", w: 1280, h: 800 },
  { hash: "s2", file: "screenshot-2.jpg", w: 1280, h: 800 },
  { hash: "s3", file: "screenshot-3.jpg", w: 1280, h: 800 },
  { hash: "s4", file: "screenshot-4.jpg", w: 1280, h: 800 },
  { hash: "s5", file: "screenshot-5.jpg", w: 1280, h: 800 },
  { hash: "tile", file: "promo-small-440x280.jpg", w: 440, h: 280 },
  { hash: "marquee", file: "promo-marquee-1400x560.jpg", w: 1400, h: 560 },
];

const chrome = await launchChrome({ extensionDir: path.join(root, "apps/extension/dist") });
try {
  const stub = readFileSync(path.join(root, "store/templates/chrome-stub.js"), "utf8");
  const template = pathToFileURL(path.join(root, "store/templates/frames.html")).href;
  for (const f of FRAMES) {
    const targetId = await chrome.openPage("about:blank");
    const session = await chrome.attach(targetId);
    const send = (m, p = {}) => chrome.cdp.send(m, p, session);
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: f.w, height: f.h, deviceScaleFactor: 1, mobile: false });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: stub }); // also reaches the popup iframe
    await send("Page.navigate", { url: `${template}#${f.hash}` });
    // The frame sets document.title = "ready" once the popup iframe reported its height.
    for (let i = 0; i < 80; i++) {
      const t = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value;
      if (t === "ready") break;
      await sleep(100);
    }
    await sleep(500);
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 96 });
    writeFileSync(path.join(out, f.file), Buffer.from(data, "base64"));
    console.log("wrote", path.relative(root, path.join(out, f.file)), `${f.w}x${f.h}`);
    await chrome.cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
} finally {
  await chrome.close();
}

// Store icon: the 96px artwork centred on a transparent 128px canvas (16px padding per side).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function paddedIcon() {
  // Reuse the icon renderer's output: decode icons/icon-128.png (we wrote it, 8-bit RGBA, filter 0),
  // scale to 96 by area averaging, and centre it.
  const src = readFileSync(path.join(root, "apps/extension/icons/icon-128.png"));
  let p = 8;
  let idat = Buffer.alloc(0);
  while (p < src.length) {
    const len = src.readUInt32BE(p);
    const type = src.toString("ascii", p + 4, p + 8);
    if (type === "IDAT") idat = Buffer.concat([idat, src.subarray(p + 8, p + 8 + len)]);
    p += 12 + len;
  }
  const raw = inflateSync(idat);
  const S = 128;
  const px = (x, y, c) => raw[y * (S * 4 + 1) + 1 + x * 4 + c];
  const T = 96;
  const canvas = Buffer.alloc(S * S * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const x0 = Math.floor((x * S) / T), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * S) / T));
      const y0 = Math.floor((y * S) / T), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * S) / T));
      let a = 0, r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const al = px(xx, yy, 3);
        a += al; r += px(xx, yy, 0) * al; g += px(xx, yy, 1) * al; b += px(xx, yy, 2) * al; n++;
      }
      const o = ((y + 16) * S + (x + 16)) * 4;
      canvas[o] = a ? Math.round(r / a) : 0;
      canvas[o + 1] = a ? Math.round(g / a) : 0;
      canvas[o + 2] = a ? Math.round(b / a) : 0;
      canvas[o + 3] = Math.round(a / n);
    }
  }
  const rows = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) canvas.copy(rows, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync(path.join(out, "icon-128.png"), paddedIcon());
console.log("wrote", path.relative(root, path.join(out, "icon-128.png")), "128x128 (96px artwork + 16px padding)");

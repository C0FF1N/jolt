import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs scripts, no type declarations
import { createZip } from "../../scripts/lib/zip.mjs";
// @ts-expect-error plain .mjs scripts, no type declarations
import { ALLOWED_PERMISSIONS, checkCode, checkManifest } from "../../scripts/package-extension.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "apps/extension/manifest.json"), "utf8"));

/** Independent reader: walks the central directory, inflates, and verifies sizes and CRCs. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26);
    const lxlen = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe("zip writer", () => {
  const files = [
    { name: "manifest.json", data: Buffer.from('{"a":1}') },
    { name: "icons/icon-16.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { name: "popup.js", data: Buffer.from("console.log('hi');\n".repeat(200)) },
    { name: "héllo ✓.txt", data: Buffer.from("unicode names") },
  ];

  it("round-trips every file byte for byte, including nested paths and unicode names", () => {
    const got = readZip(createZip(files));
    expect([...got.keys()].sort()).toEqual(files.map((f) => f.name).sort());
    for (const f of files) expect(got.get(f.name)!.equals(f.data)).toBe(true);
  });

  it("is deterministic: same input, same bytes, regardless of input order", () => {
    expect(createZip(files).equals(createZip([...files].reverse()))).toBe(true);
  });

  it("compresses compressible data and stores incompressible data", () => {
    const zip = createZip(files);
    expect(zip.length).toBeLessThan(files.reduce((n, f) => n + f.data.length, 0) + 400);
  });
});

describe("store manifest rules", () => {
  const ok = () => structuredClone(manifest);

  it("the real manifest passes", () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  it.each([
    ["an extra permission", (m: any) => m.permissions.push("history"), /not in ALLOWED_PERMISSIONS/],
    ["a missing needed permission", (m: any) => (m.permissions = m.permissions.filter((p: string) => p !== "alarms")), /missing from the manifest/],
    ["a non-loopback host", (m: any) => m.host_permissions.push("https://*/*"), /not allowed/],
    ["a too-long description", (m: any) => (m.description = "x".repeat(133)), /description/],
    ["a too-long name", (m: any) => (m.name = "x".repeat(76)), /name/],
    ["a long short_name", (m: any) => (m.short_name = "x".repeat(13)), /short_name/],
    ["a bad version", (m: any) => (m.version = "1.02.0"), /version/],
    ["the ignored author key", (m: any) => (m.author = "C0FF1N"), /author/],
    ["a content script", (m: any) => (m.content_scripts = [{ matches: ["<all_urls>"], js: ["x.js"] }]), /content scripts/],
    ["a non-https homepage", (m: any) => (m.homepage_url = "http://example.com"), /homepage_url/],
    ["a missing icon size", (m: any) => delete m.icons["128"], /icons\.128/],
  ])("rejects %s", (_label, mutate, expected) => {
    const m = ok();
    (mutate as (m: unknown) => void)(m);
    expect(checkManifest(m).join("\n")).toMatch(expected as RegExp);
  });

  it("flags files the manifest references but the package lacks", () => {
    expect(checkManifest(manifest, () => false).join("\n")).toMatch(/missing file: background\.js/);
  });

  it("documents a reason for every permission", () => {
    for (const reason of Object.values(ALLOWED_PERMISSIONS)) expect(String(reason).length).toBeGreaterThan(10);
  });
});

describe("store code rules", () => {
  it("accepts ordinary code", () => {
    expect(checkCode([{ name: "background.js", text: "const x = fetch('http://127.0.0.1:9470/info');" }])).toEqual([]);
  });

  it.each([
    ["eval(", "eval('1')"],
    ["new Function(", "new Function('return 1')"],
    ["importScripts(", "importScripts('x.js')"],
    ["a sourcemap reference", "//# sourceMappingURL=x.map"],
  ])("flags %s", (_label, text) => {
    expect(checkCode([{ name: "a.js", text }]).length).toBe(1);
  });

  it("ignores non-JS files", () => {
    expect(checkCode([{ name: "popup.html", text: "eval(" }])).toEqual([]);
  });
});

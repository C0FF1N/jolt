import { describe, expect, it } from "vitest";

import { boundText } from "@/utils/bound";

const lines = Array.from({ length: 100 }, (_, i) => `- row ${i}`).join("\n");

describe("boundText", () => {
  it("returns everything when under the limit", () => {
    const r = boundText("a\nb", { maxChars: 100 });
    expect(r).toMatchObject({ text: "a\nb", truncated: false });
  });

  it("treats maxChars 0 as unlimited", () => {
    expect(boundText(lines, { maxChars: 0 }).truncated).toBe(false);
  });

  it("cuts on a line boundary and reports a continuation offset", () => {
    const r = boundText(lines, { maxChars: 50 });
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("\n")).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(50);
    expect(r.nextOffset).toBe(r.end);
    expect(r.totalChars).toBe(lines.length);
  });

  it("pages through the whole text without loss or overlap", () => {
    let offset = 0;
    let rebuilt = "";
    for (let guard = 0; guard < 100; guard++) {
      const r = boundText(lines, { maxChars: 60, offset });
      rebuilt += r.text;
      if (!r.truncated) break;
      offset = r.nextOffset;
    }
    expect(rebuilt).toBe(lines);
  });

  it("hard-cuts a single oversized line instead of looping", () => {
    const r = boundText("x".repeat(500), { maxChars: 100 });
    expect(r.text.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.nextOffset).toBe(100);
  });
});

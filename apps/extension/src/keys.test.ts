import { describe, expect, it } from "vitest";

import { resolveChord, resolveKey } from "./keys";

describe("resolveKey", () => {
  it("maps named keys", () => {
    expect(resolveKey("Enter")).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    expect(resolveKey("ArrowLeft").text).toBeUndefined();
  });

  it("is case-insensitive for named keys", () => {
    expect(resolveKey("enter").key).toBe("Enter");
    expect(resolveKey("arrowdown").code).toBe("ArrowDown");
  });

  it("supports function keys and Insert", () => {
    expect(resolveKey("F5")).toMatchObject({ key: "F5", windowsVirtualKeyCode: 116 });
    expect(resolveKey("Insert").windowsVirtualKeyCode).toBe(45);
  });

  it("maps letters, digits and punctuation", () => {
    expect(resolveKey("a")).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
    expect(resolveKey("7")).toMatchObject({ code: "Digit7", text: "7" });
    expect(resolveKey("/").text).toBe("/");
  });

  it("rejects unknown multi-character names with the supported list", () => {
    expect(() => resolveKey("F13")).toThrow(/Unsupported key "F13"/);
  });
});

describe("resolveChord", () => {
  it("returns a plain key with no modifiers", () => {
    const c = resolveChord("Enter");
    expect(c.modifiers).toBe(0);
    expect(c.mods).toEqual([]);
  });

  it("parses modifier chords and drops text for shortcuts", () => {
    const c = resolveChord("Control+a");
    expect(c.modifiers).toBe(2);
    expect(c.mods.map((m) => m.key)).toEqual(["Control"]);
    expect(c.key.key).toBe("a");
    expect(c.key.text).toBeUndefined();
  });

  it("combines modifiers case-insensitively and keeps text for Shift-only", () => {
    const c = resolveChord("shift+Tab");
    expect(c.modifiers).toBe(8);
    expect(resolveChord("Control+Shift+a").modifiers).toBe(10);
    expect(resolveChord("Shift+a").key.text).toBe("a");
  });

  it("treats a bare + and trailing ++ as the plus key", () => {
    expect(resolveChord("+").key.key).toBe("+");
    const c = resolveChord("Control++");
    expect(c.modifiers).toBe(2);
    expect(c.key.key).toBe("+");
  });

  it("rejects an unknown modifier", () => {
    expect(() => resolveChord("Hyper+a")).toThrow(/Unknown modifier "Hyper"/);
  });
});

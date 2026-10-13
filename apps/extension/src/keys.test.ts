import { describe, expect, it } from "vitest";

import { resolveKey } from "./keys";

describe("resolveKey", () => {
  it("maps named keys", () => {
    expect(resolveKey("Enter")).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    expect(resolveKey("ArrowLeft").text).toBeUndefined();
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

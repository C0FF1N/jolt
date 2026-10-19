import { describe, expect, it } from "vitest";

import { cursorExpression } from "./cursor";

describe("cursorExpression", () => {
  it("is valid JavaScript for every mode", () => {
    for (const mode of ["move", "click", "remove"] as const) {
      expect(() => new Function(`return ${cursorExpression(mode, 10, 20)}`)).not.toThrow();
    }
  });

  it("passes rounded coordinates and the mode as literal arguments", () => {
    expect(cursorExpression("click", 10.04, 20.06)).toMatch(/\(10, 20\.1, "click"\)$/);
  });

  it("neutralises non-finite coordinates instead of emitting NaN into the page", () => {
    expect(cursorExpression("move", Number.NaN, Number.POSITIVE_INFINITY)).toMatch(/\(0, 0, "move"\)$/);
  });

  it("only uses CSP-safe, page-invisible techniques", () => {
    const src = cursorExpression("move", 1, 1);
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|<style|eval\(/);
    expect(src).toContain("mode: 'closed'");
    expect(src).toContain("aria-hidden");
    expect(src).toContain("pointer-events:none");
  });
});

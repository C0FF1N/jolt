import { describe, expect, it } from "vitest";

import { type AXNode, buildSnapshot } from "./aria";

const v = (value: unknown) => ({ type: "x", value });
const node = (n: Partial<AXNode> & { nodeId: string }): AXNode => n as AXNode;

const page: AXNode[] = [
  node({ nodeId: "1", role: v("RootWebArea"), name: v("Login"), childIds: ["2", "3", "4", "9"] }),
  node({ nodeId: "2", parentId: "1", role: v("heading"), name: v("Sign in"), properties: [{ name: "level", value: v(1) }], backendDOMNodeId: 20, childIds: ["21"] }),
  node({ nodeId: "21", parentId: "2", role: v("StaticText"), name: v("Sign in") }),
  node({ nodeId: "3", parentId: "1", role: v("textbox"), name: v("Email"), value: v("a@b.c"), backendDOMNodeId: 30 }),
  node({ nodeId: "4", parentId: "1", role: v("generic"), childIds: ["5"] }),
  node({ nodeId: "5", parentId: "4", role: v("button"), name: v('Say "hi"'), properties: [{ name: "disabled", value: v(true) }], backendDOMNodeId: 50 }),
  node({ nodeId: "9", parentId: "1", ignored: true, role: v("button"), name: v("hidden"), backendDOMNodeId: 90 }),
];

describe("buildSnapshot", () => {
  it("emits roles, names, flags and refs; promotes generic wrappers; skips ignored", () => {
    const r = buildSnapshot(page);
    expect(r.yaml).toBe(
      [
        '- document "Login":',
        '  - heading "Sign in" [level=1] [ref=e1]',
        '  - textbox "Email" [value="a@b.c"] [ref=e2]',
        '  - button "Say \\"hi\\"" [disabled] [ref=e3]',
      ].join("\n"),
    );
    expect([...r.refs.entries()]).toEqual([
      ["e1", 20],
      ["e2", 30],
      ["e3", 50],
    ]);
    expect(r.truncated).toBeNull();
  });

  it("drops static text that repeats the name of its parent", () => {
    expect(buildSnapshot(page).yaml).not.toContain("- text:");
  });

  it("keeps distinct static text and collapses whitespace", () => {
    const r = buildSnapshot([
      node({ nodeId: "1", role: v("RootWebArea"), childIds: ["2"] }),
      node({ nodeId: "2", parentId: "1", role: v("StaticText"), name: v("Hello   world") }),
    ]);
    expect(r.yaml).toContain('- text: "Hello world"');
  });

  it("truncates at maxNodes with an explicit marker", () => {
    const kids = Array.from({ length: 50 }, (_, i) => String(i + 10));
    const nodes = [
      node({ nodeId: "1", role: v("RootWebArea"), childIds: kids }),
      ...kids.map((id, i) =>
        node({ nodeId: id, parentId: "1", role: v("button"), name: v(`b${i}`), backendDOMNodeId: i }),
      ),
    ];
    const r = buildSnapshot(nodes, { maxNodes: 10 });
    expect(r.emittedNodes).toBe(10);
    expect(r.truncated).toEqual({ reason: "maxNodes", limit: 10 });
    expect(r.yaml.split("\n").at(-1)).toBe("- [snapshot truncated: reached maxNodes=10]");
  });

  it("truncates over-long names", () => {
    const r = buildSnapshot(
      [node({ nodeId: "1", role: v("button"), name: v("x".repeat(500)), backendDOMNodeId: 1 })],
      { maxTextLength: 20 },
    );
    expect(r.yaml).toContain(`${"x".repeat(20)}…`);
  });

  it("stops at the depth limit instead of recursing without bound", () => {
    const nodes: AXNode[] = [];
    for (let i = 0; i < 500; i++) {
      nodes.push(
        node({
          nodeId: String(i),
          parentId: i ? String(i - 1) : undefined,
          role: v("list"),
          childIds: i < 499 ? [String(i + 1)] : [],
          backendDOMNodeId: i,
        }),
      );
    }
    const r = buildSnapshot(nodes, { maxDepth: 40 });
    expect(r.truncated?.reason).toBe("maxDepth");
  });

  it("returns an empty snapshot for no nodes", () => {
    expect(buildSnapshot([]).yaml).toBe("");
  });
});

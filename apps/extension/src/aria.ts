/** Accessibility-tree -> YAML snapshot (same line shape the server/model already expects). */

export type AXValue = { type?: string; value?: unknown };
export type AXProperty = { name: string; value: AXValue };
export type AXNode = {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type SnapshotLimits = {
  maxNodes: number;
  maxDepth: number;
  maxTextLength: number;
};

export const DEFAULT_LIMITS: SnapshotLimits = {
  maxNodes: 20_000,
  maxDepth: 80,
  maxTextLength: 300,
};

export type SnapshotResult = {
  yaml: string;
  /** ref ("e12") -> backendDOMNodeId, valid until the next snapshot. */
  refs: Map<string, number>;
  emittedNodes: number;
  truncated: null | { reason: "maxNodes" | "maxDepth"; limit: number };
};

/** Roles that only add structure noise; their children are promoted. */
const TRANSPARENT = new Set([
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "Section",
  "GenericContainer",
]);

const FLAG_PROPS = ["checked", "disabled", "expanded", "selected", "pressed", "required"] as const;
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton"]);

function clean(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  const cut = one.length > max ? `${one.slice(0, max)}…` : one;
  return cut.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function str(v: AXValue | undefined): string {
  const x = v?.value;
  return typeof x === "string" ? x : typeof x === "number" ? String(x) : "";
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

export function buildSnapshot(
  nodes: AXNode[],
  limits: Partial<SnapshotLimits> = {},
): SnapshotResult {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let emitted = 0;
  let truncated: SnapshotResult["truncated"] = null;

  function walk(nodeId: string, indent: number, depth: number, parentName: string) {
    if (truncated) return;
    const node = byId.get(nodeId);
    if (!node) return;
    const role = str(node.role);
    const kids = node.childIds ?? [];

    if (node.ignored || !role || TRANSPARENT.has(role)) {
      for (const k of kids) walk(k, indent, depth, parentName);
      return;
    }
    if (depth > lim.maxDepth) {
      truncated = { reason: "maxDepth", limit: lim.maxDepth };
      return;
    }
    if (emitted >= lim.maxNodes) {
      truncated = { reason: "maxNodes", limit: lim.maxNodes };
      return;
    }

    const pad = "  ".repeat(indent);
    const name = clean(str(node.name), lim.maxTextLength);

    if (role === "StaticText") {
      // Skip text that merely repeats its parent's accessible name.
      if (name && !parentName.includes(name)) {
        lines.push(`${pad}- text: "${name}"`);
        emitted++;
      }
      return;
    }

    let head = `${pad}- ${role === "RootWebArea" ? "document" : role}`;
    if (name) head += ` "${name}"`;
    for (const f of FLAG_PROPS) {
      const v = prop(node, f);
      if (v === true || v === "true") head += ` [${f}]`;
      else if (v === "mixed") head += ` [${f}=mixed]`;
    }
    const level = prop(node, "level");
    if (typeof level === "number") head += ` [level=${level}]`;
    if (VALUE_ROLES.has(role)) {
      const value = clean(str(node.value), 100);
      if (value) head += ` [value="${value}"]`;
    }
    if (node.backendDOMNodeId !== undefined) {
      const ref = `e${refs.size + 1}`;
      refs.set(ref, node.backendDOMNodeId);
      head += ` [ref=${ref}]`;
    }
    emitted++;

    const at = lines.length;
    lines.push(head);
    for (const k of kids) walk(k, indent + 1, depth + 1, name);
    if (lines.length > at + 1) lines[at] = `${head}:`;
  }

  if (root) walk(root.nodeId, 0, 0, "");
  if (truncated) {
    const t: NonNullable<SnapshotResult["truncated"]> = truncated;
    lines.push(`- [snapshot truncated: reached ${t.reason}=${t.limit}]`);
  }
  return { yaml: lines.join("\n"), refs, emittedNodes: emitted, truncated };
}

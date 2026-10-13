import type { Context } from "@/context";
import type { ToolResult } from "@/tools/tool";
import { boundText, defaultMaxSnapshotChars } from "@/utils/bound";

export type SnapshotOptions = {
  status?: string;
  /** Max characters of YAML to return (0 = unlimited). Defaults to env/200k. */
  maxChars?: number;
  /** Continue a previously truncated snapshot from this character offset. */
  offset?: number;
};

type Bundle = { url: string; title: string; snapshot: string };

/**
 * Reads url + title + snapshot. With an extension that advertises
 * `snapshotBundle` this is one round trip; otherwise the three independent
 * reads are issued concurrently instead of one after another.
 */
async function readPage(context: Context): Promise<Bundle> {
  if (context.link.has("snapshotBundle")) {
    return (await context.sendCustom("browser_snapshot_bundle", {})) as Bundle;
  }
  if (process.env.BROWSERMCP_SEQUENTIAL_SNAPSHOT === "1") {
    // Safety valve: upstream behaviour, one read after another.
    const url = await context.sendSocketMessage("getUrl", undefined);
    const title = await context.sendSocketMessage("getTitle", undefined);
    const snapshot = await context.sendSocketMessage("browser_snapshot", {});
    return { url, title, snapshot };
  }
  const [url, title, snapshot] = await Promise.all([
    context.sendSocketMessage("getUrl", undefined),
    context.sendSocketMessage("getTitle", undefined),
    context.sendSocketMessage("browser_snapshot", {}),
  ]);
  return { url, title, snapshot };
}

export async function captureAriaSnapshot(
  context: Context,
  options: SnapshotOptions | string = {},
): Promise<ToolResult> {
  const opts: SnapshotOptions =
    typeof options === "string" ? { status: options } : options;
  const { url, title, snapshot } = await readPage(context);
  const bounded = boundText(snapshot, {
    maxChars: opts.maxChars ?? defaultMaxSnapshotChars(),
    offset: opts.offset,
  });
  const note = bounded.truncated
    ? `\n- [Snapshot truncated: showing characters ${bounded.start}-${bounded.end} of ${bounded.totalChars}. Call browser_snapshot with offset=${bounded.nextOffset} to continue (re-captures the page), or pass maxChars to raise the limit.]`
    : "";
  const status = opts.status;
  return {
    content: [
      {
        type: "text",
        text: `${status ? `${status}\n` : ""}
- Page URL: ${url}
- Page Title: ${title}
- Page Snapshot
\`\`\`yaml
${bounded.text}
\`\`\`${note}
`,
      },
    ],
  };
}

/** Lightweight page identity (no accessibility tree). */
export async function capturePageSummary(
  context: Context,
): Promise<{ url: string; title: string }> {
  const [url, title] = await Promise.all([
    context.sendSocketMessage("getUrl", undefined),
    context.sendSocketMessage("getTitle", undefined),
  ]);
  return { url, title };
}

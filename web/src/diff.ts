import type { DiffLine, ParsedDiffFile, SideBySideRow } from "./types";

function parseHunkHeader(line: string): { left: number; right: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    return null;
  }

  return {
    left: Number(match[1]),
    right: Number(match[2])
  };
}

function buildSideBySideRows(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let pendingRemoved: DiffLine[] = [];

  function flushRemoved() {
    for (const removed of pendingRemoved) {
      rows.push({
        kind: "paired",
        left: removed,
        right: null
      });
    }
    pendingRemoved = [];
  }

  for (const line of lines) {
    if (line.kind === "meta" || line.kind === "hunk") {
      flushRemoved();
      rows.push({
        kind: "meta",
        left: null,
        right: null,
        content: line.content
      });
      continue;
    }

    if (line.kind === "remove") {
      pendingRemoved.push(line);
      continue;
    }

    if (line.kind === "add") {
      const removed = pendingRemoved.shift() ?? null;
      rows.push({
        kind: "paired",
        left: removed,
        right: line
      });
      continue;
    }

    flushRemoved();
    rows.push({
      kind: "paired",
      left: line,
      right: line
    });
  }

  flushRemoved();
  return rows;
}

export function parseDiffByFile(diffText: string): ParsedDiffFile[] {
  const normalized = diffText.replace(/\r\n/g, "\n");
  const chunks = normalized
    .split(/^diff --git /m)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk) => {
    const rawLines = `diff --git ${chunk}`.split("\n");
    const firstLine = rawLines[0] ?? "";
    const match = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = match?.[2] ?? match?.[1] ?? firstLine.replace(/^diff --git /, "");

    const headerLines: string[] = [];
    const bodyLines: string[] = [];
    let additions = 0;
    let deletions = 0;
    let leftLineNumber = 0;
    let rightLineNumber = 0;
    const lines: DiffLine[] = [];

    for (const line of rawLines) {
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ")
      ) {
        headerLines.push(line);
        lines.push({
          kind: "meta",
          content: line,
          leftLineNumber: null,
          rightLineNumber: null
        });
        continue;
      }

      if (line.startsWith("@@")) {
        bodyLines.push(line);
        const parsed = parseHunkHeader(line);
        if (parsed) {
          leftLineNumber = parsed.left;
          rightLineNumber = parsed.right;
        }
        lines.push({
          kind: "hunk",
          content: line,
          leftLineNumber: null,
          rightLineNumber: null
        });
        continue;
      }

      bodyLines.push(line);

      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions += 1;
        lines.push({
          kind: "add",
          content: line,
          leftLineNumber: null,
          rightLineNumber: rightLineNumber
        });
        rightLineNumber += 1;
        continue;
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        deletions += 1;
        lines.push({
          kind: "remove",
          content: line,
          leftLineNumber: leftLineNumber,
          rightLineNumber: null
        });
        leftLineNumber += 1;
        continue;
      }

      lines.push({
        kind: "context",
        content: line,
        leftLineNumber,
        rightLineNumber
      });
      leftLineNumber += 1;
      rightLineNumber += 1;
    }

    return {
      filePath,
      header: headerLines.join("\n").trim(),
      diff: bodyLines.join("\n").trim(),
      additions,
      deletions,
      lines,
      sideBySideRows: buildSideBySideRows(lines)
    };
  });
}

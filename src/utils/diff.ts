/**
 * ponytail: minimal unified diff — line-by-line, no LCS, no multi-hunk.
 * Good enough for skill version comparison (small files).
 * Replace with a real diff lib if files exceed ~500 lines.
 */
export function buildUnifiedDiff(label1: string, label2: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out: string[] = [`--- ${label1}`, `+++ ${label2}`];

  const maxLen = Math.max(oldLines.length, newLines.length);
  let diffStart = -1;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < maxLen; i++) {
    const o = i < oldLines.length ? oldLines[i] : undefined;
    const n = i < newLines.length ? newLines[i] : undefined;
    if (o !== n) {
      if (diffStart === -1) {
        diffStart = Math.max(0, i - 2);
        oldLine = diffStart + 1;
        newLine = diffStart + 1;
        const ctxCount = i - diffStart;
        out.push(`@@ -${oldLine},${oldLine + Math.min(ctxCount, oldLines.length - diffStart) - 1} +${newLine},${newLine + Math.min(ctxCount, newLines.length - diffStart) - 1} @@`);
        for (let j = diffStart; j < i; j++) out.push(` ${oldLines[j]}`);
      }
      if (o !== undefined) out.push(`-${o}`);
      if (n !== undefined) out.push(`+${n}`);
    } else if (diffStart !== -1) {
      out.push(` ${o}`);
    }
  }

  return out.join("\n");
}

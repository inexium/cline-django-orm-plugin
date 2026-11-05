export type Confidence = "low" | "medium" | "high";

export const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export type RuleId =
  | "fk-access-in-loop"
  | "related-manager-in-loop"
  | "filtered-prefetch-in-loop"
  | "query-in-loop"
  | "create-in-loop"
  | "save-in-loop"
  | "delete-in-loop"
  | "len-queryset"
  | "count-for-existence"
  | "queryset-truthiness"
  | "list-then-index"
  | "nested-serializer"
  | "dotted-source"
  | "template-fk-access"
  | "template-related-manager";

export interface Finding {
  file: string;
  line: number;
  rule: RuleId;
  confidence: Confidence;
  message: string;
  suggestion: string;
  /** Trimmed source line. */
  snippet: string;
  /** Where the repeated access happens: loop, serializer method, template loop... */
  context?: string;
}

export function atLeast(confidence: Confidence, min: Confidence): boolean {
  return CONFIDENCE_ORDER[confidence] >= CONFIDENCE_ORDER[min];
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.rule}:${f.message}`;
    const existing = seen.get(key);
    if (!existing || CONFIDENCE_ORDER[f.confidence] > CONFIDENCE_ORDER[existing.confidence]) seen.set(key, f);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence],
  );
}

export function formatFindings(findings: Finding[], options: { maxFindings?: number } = {}): string {
  if (findings.length === 0) return "No N+1 or inefficient ORM pattern detected.";
  const max = options.maxFindings ?? findings.length;
  const shown = findings.slice(0, max);
  const byFile = new Map<string, Finding[]>();
  for (const f of shown) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.confidence]++;
  const out: string[] = [
    `${findings.length} finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low confidence.`,
  ];
  for (const [file, list] of byFile) {
    out.push("", `## ${file}`);
    for (const f of list) {
      out.push(
        `- L${f.line} [${f.confidence}] ${f.rule}${f.context ? ` (${f.context})` : ""}: ${f.message}`,
        `  \`${f.snippet}\``,
        `  -> ${f.suggestion}`,
      );
    }
  }
  if (findings.length > max) out.push("", `... ${findings.length - max} more finding(s) not shown.`);
  return out.join("\n");
}

/** Lookup name to use in Count()/filters: reverse accessors "x_set" are queried as "x". */
export function queryName(accessor: string): string {
  return accessor.endsWith("_set") ? accessor.slice(0, -4) : accessor;
}

/**
 * Detects relation traversals inside `{% for %}` loops of Django templates
 * (and Jinja2 templates using the same syntax).
 */
import { dedupeFindings, queryName, type Finding } from "./findings.js";
import { emptyRelationIndex, type RelationIndex } from "./models-parser.js";

const TAG_RE = /\{%-?\s*(for|endfor)\b([^%]*)-?%\}/g;
const MANAGER_ATTRS = new Set(["all", "count", "exists", "first", "last"]);

export function scanTemplateSource(source: string, file: string, relations: RelationIndex = emptyRelationIndex()): Finding[] {
  const lines = source.split(/\r?\n/);
  const findings: Finding[] = [];
  const stack: { vars: string[]; iterable: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    let cursor = 0;
    const tags = [...text.matchAll(TAG_RE)];
    const segments: { text: string; vars: string[]; iterable: string }[] = [];
    for (const tag of tags) {
      const index = tag.index ?? 0;
      pushSegment(segments, text.slice(cursor, index), stack);
      if (tag[1] === "for") {
        const m = (tag[2] ?? "").match(/^\s*(.+?)\s+in\s+([\w.]+)/);
        if (m) {
          const iterable = m[2] ?? "";
          // The iterable itself may traverse a relation of an outer loop variable.
          pushSegment(segments, ` ${iterable} `, stack);
          stack.push({
            vars: (m[1] ?? "").split(",").map((v) => v.trim()).filter((v) => /^\w+$/.test(v)),
            iterable,
          });
        }
      } else if (stack.length) {
        stack.pop();
      }
      cursor = index + tag[0].length;
    }
    pushSegment(segments, text.slice(cursor), stack);

    for (const seg of segments) {
      for (const v of seg.vars) {
        for (const m of seg.text.matchAll(new RegExp(`(?<![\\w.])${v}\\.(\\w+)\\.(\\w+)`, "g"))) {
          const rel = m[1] ?? "";
          const attr = m[2] ?? "";
          if (rel === "pk" || rel === "id" || rel.endsWith("_id")) continue;
          if (MANAGER_ATTRS.has(attr)) {
            findings.push({
              file,
              line: i + 1,
              rule: "template-related-manager",
              confidence: relations.multiValued.has(rel) || rel.endsWith("_set") ? "high" : "medium",
              message: `${v}.${rel}.${attr} runs one query per iteration of {% for ${v} in ${seg.iterable} %}`,
              suggestion:
                attr === "count"
                  ? `Annotate in the view: .annotate(${queryName(rel)}_count=Count("${queryName(rel)}")) and use ${v}.${queryName(rel)}_count`
                  : `Add .prefetch_related("${rel}") to the queryset passed as "${seg.iterable}"`,
              snippet: text.trim(),
              context: `template loop over ${seg.iterable}`,
            });
          } else if (!relations.multiValued.has(rel)) {
            const known = relations.singleValued.has(rel);
            findings.push({
              file,
              line: i + 1,
              rule: "template-fk-access",
              confidence: known ? "high" : relations.models.length ? "low" : "medium",
              message: `${v}.${rel}.${attr} may load a related object per iteration`,
              suggestion: `Add .select_related("${rel}") to the queryset passed as "${seg.iterable}"`,
              snippet: text.trim(),
              context: `template loop over ${seg.iterable}`,
            });
          }
        }
      }
    }
  }
  return dedupeFindings(findings);
}

function pushSegment(
  segments: { text: string; vars: string[]; iterable: string }[],
  text: string,
  stack: { vars: string[]; iterable: string }[],
): void {
  if (!text.trim()) return;
  for (const frame of stack) segments.push({ text, vars: frame.vars, iterable: frame.iterable });
}

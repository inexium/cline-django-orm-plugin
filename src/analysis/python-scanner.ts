/**
 * Heuristic static detection of N+1 queries and inefficient ORM usage in
 * Python sources. It works line by line on indentation, without a Python
 * parser, so every finding carries a confidence level. The Python MCP server
 * confirms them dynamically (capture_queries / profile_url).
 */
import { dedupeFindings, queryName, type Confidence, type Finding, type RuleId } from "./findings.js";
import { emptyRelationIndex, type RelationIndex } from "./models-parser.js";

/** Related-manager / queryset methods that hit the database. */
const MANAGER_METHODS = new Set([
  "all",
  "filter",
  "exclude",
  "count",
  "exists",
  "order_by",
  "values",
  "values_list",
  "first",
  "last",
  "get",
  "aggregate",
  "annotate",
  "latest",
  "earliest",
  "distinct",
]);
/** Methods served from the prefetch cache. */
const PREFETCH_SAFE_METHODS = new Set(["all", "count", "exists"]);
const IGNORED_ATTRS = new Set(["pk", "id", "_meta", "_state", "_prefetched_objects_cache", "__class__", "__dict__", "objects"]);
const QUERY_METHODS = "get|filter|exclude|count|exists|first|last|aggregate|get_or_create|update_or_create|create|in_bulk|latest|earliest";

interface Line {
  /** 0-based index. */
  index: number;
  raw: string;
  /** Code without comments; string-only docstring lines are blanked. */
  code: string;
  indent: number;
}

interface Scope {
  vars: string[];
  /** Relation paths already loaded by select_related / prefetch_related. */
  covered: Set<string>;
  body: Line[];
  context: string;
  /** Whether repeated-execution rules (query/save in loop) apply. */
  isLoop: boolean;
  /** Origin of the iterable could not be resolved (function argument...). */
  unresolved: boolean;
}

export interface ScanOptions {
  relations?: RelationIndex;
}

export function scanPythonSource(source: string, file: string, options: ScanOptions = {}): Finding[] {
  const relations = options.relations ?? emptyRelationIndex();
  const lines = toLines(source);
  const findings: Finding[] = [];
  const scopes = [...findForLoops(lines), ...findComprehensions(lines), ...findPerObjectMethods(lines)];
  for (const scope of scopes) findings.push(...scanScope(scope, file, relations));
  findings.push(...scanWholeFile(lines, file));
  return dedupeFindings(findings);
}

// ---------------------------------------------------------------------------
// Pre-processing

function toLines(source: string): Line[] {
  const raw = source.split(/\r?\n/);
  const out: Line[] = [];
  let inTriple: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i] ?? "";
    let code = "";
    let quote: string | undefined;
    for (let c = 0; c < text.length; c++) {
      const triple = text.slice(c, c + 3);
      if (inTriple) {
        if (triple === inTriple) {
          inTriple = undefined;
          c += 2;
        }
        continue;
      }
      if (!quote && (triple === '"""' || triple === "'''")) {
        inTriple = triple;
        c += 2;
        continue;
      }
      const ch = text[c] ?? "";
      if (quote) {
        if (ch === "\\") {
          code += ch + (text[c + 1] ?? "");
          c++;
          continue;
        }
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#") {
        break;
      }
      code += ch;
    }
    out.push({ index: i, raw: text, code: code.replace(/\s+$/, ""), indent: indentOf(text) });
  }
  return out;
}

function indentOf(text: string): number {
  const m = text.match(/^[ \t]*/);
  return (m?.[0] ?? "").replace(/\t/g, "    ").length;
}

/** Lines indented deeper than `line`, stopping at the first dedent. */
function blockAfter(lines: Line[], start: number, indent: number): Line[] {
  const body: Line[] = [];
  let depth = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    if (!line.code.trim()) continue;
    if (depth === 0 && line.indent <= indent) break;
    body.push(line);
    depth += bracketDelta(line.code);
  }
  return body;
}

function bracketDelta(code: string): number {
  let d = 0;
  for (const ch of stripStrings(code)) {
    if ("([{".includes(ch)) d++;
    else if (")]}".includes(ch)) d--;
  }
  return d;
}

function stripStrings(code: string): string {
  return code.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
}

/** Joins a statement that continues on following lines (open brackets). */
function logicalText(lines: Line[], start: number): string {
  let text = "";
  let depth = 0;
  for (let i = start; i < lines.length && i < start + 20; i++) {
    const code = lines[i]?.code ?? "";
    text += (text ? " " : "") + code.trim();
    depth += bracketDelta(code);
    if (depth <= 0 && !code.endsWith("\\")) break;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Scopes

const FOR_RE = /^(\s*)(?:async\s+)?for\s+(.+?)\s+in\s+(.+):\s*$/;
const SKIP_ITERABLE_RE = /^(range|zip|open|reversed\(range)\(|^\[|^\(|^\{|\.(items|keys|split|splitlines|readlines)\(\)?|^os\.|^["']/;

function findForLoops(lines: Line[]): Scope[] {
  const scopes: Scope[] = [];
  for (const line of lines) {
    const m = line.code.match(FOR_RE);
    if (!m) continue;
    const iterable = unwrapIterable((m[3] ?? "").trim());
    if (SKIP_ITERABLE_RE.test(iterable)) continue;
    const vars = parseTargets(m[2] ?? "");
    if (vars.length === 0) continue;
    const { covered, unresolved } = resolveCoverage(lines, line, iterable);
    scopes.push({
      vars,
      covered,
      unresolved,
      body: blockAfter(lines, line.index, line.indent),
      context: `loop over ${shorten(iterable)}`,
      isLoop: true,
    });
  }
  return scopes;
}

const COMPREHENSION_FOR_RE = /\bfor\s+([\w\s,()]+?)\s+in\s+/g;

/** Iterable of a comprehension: text after `in` up to ` if `, another `for` or the closing bracket. */
function comprehensionIterable(text: string, start: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return text.slice(start, i).trim();
      depth--;
    } else if (depth === 0 && /^\s(if|for)\s/.test(text.slice(i, i + 5))) {
      return text.slice(start, i).trim();
    }
  }
  return text.slice(start).trim();
}

function findComprehensions(lines: Line[]): Scope[] {
  const scopes: Scope[] = [];
  for (const line of lines) {
    if (FOR_RE.test(line.code) || !/\bfor\b/.test(line.code)) continue;
    const text = logicalText(lines, line.index);
    for (const m of text.matchAll(COMPREHENSION_FOR_RE)) {
      const iterable = unwrapIterable(comprehensionIterable(text, (m.index ?? 0) + m[0].length));
      if (!iterable || SKIP_ITERABLE_RE.test(iterable)) continue;
      const vars = parseTargets(m[1] ?? "");
      if (vars.length === 0) continue;
      const { covered, unresolved } = resolveCoverage(lines, line, iterable);
      // The expression evaluated per item is everything before `for`.
      const expr: Line = { ...line, code: text.slice(0, m.index) };
      scopes.push({ vars, covered, unresolved, body: [expr], context: `comprehension over ${shorten(iterable)}`, isLoop: true });
    }
  }
  return scopes;
}

/**
 * Methods called once per row by the framework: DRF `get_<field>(self, obj)`
 * in serializers, ModelAdmin `list_display` callables `(self, obj)`.
 */
function findPerObjectMethods(lines: Line[]): Scope[] {
  const scopes: Scope[] = [];
  const classStack: { name: string; indent: number }[] = [];
  for (const line of lines) {
    if (!line.code.trim()) continue;
    while (classStack.length && (classStack[classStack.length - 1]?.indent ?? 0) >= line.indent) classStack.pop();
    const cls = line.code.match(/^(\s*)class\s+(\w+)/);
    if (cls) {
      classStack.push({ name: cls[2] ?? "", indent: line.indent });
      continue;
    }
    const currentClass = classStack[classStack.length - 1];
    if (!currentClass) continue;
    const def = line.code.match(/^\s*def\s+(\w+)\(\s*self\s*,\s*(obj|instance)\b/);
    if (!def) continue;
    const isSerializer = /Serializer$/.test(currentClass.name) && /^(get_|to_representation$)/.test(def[1] ?? "");
    const isAdmin = /(Admin|Inline)$/.test(currentClass.name);
    if (!isSerializer && !isAdmin) continue;
    scopes.push({
      vars: [def[2] ?? "obj"],
      covered: new Set(),
      unresolved: true,
      body: blockAfter(lines, line.index, line.indent),
      context: `${currentClass.name}.${def[1]}() runs once per ${isAdmin ? "admin row" : "serialized object"}`,
      isLoop: false,
    });
  }
  return scopes;
}

function unwrapIterable(iterable: string): string {
  let it = iterable.trim();
  for (;;) {
    const m = it.match(/^(?:enumerate|sorted|list|tuple|reversed|iter|set)\((.*)\)$/s);
    if (!m?.[1]) return it;
    it = m[1].split(/,\s*(?:start|key|reverse)\s*=/)[0]?.trim() ?? it;
  }
}

function parseTargets(targets: string): string[] {
  return targets
    .replace(/[()[\]]/g, " ")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^[A-Za-z_]\w*$/.test(t) && t !== "_");
}

/** Relation paths loaded via select_related / prefetch_related for the iterable. */
function resolveCoverage(lines: Line[], at: Line, iterable: string): { covered: Set<string>; unresolved: boolean } {
  const covered = new Set<string>();
  collectPrefetches(iterable, covered);
  const name = iterable.match(/^((?:self\.)?\w+)$/)?.[1];
  if (!name) return { covered, unresolved: false };

  // Look for assignments to the same name earlier in the enclosing function.
  let unresolved = true;
  const assign = new RegExp(`^\\s*${escapeRe(name)}\\s*(?::[^=]+)?=(?!=)`);
  for (let i = at.index - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) break;
    if (/^\s*(?:async\s+)?def\s/.test(line.code) && line.indent < at.indent) break;
    if (assign.test(line.code)) {
      unresolved = false;
      collectPrefetches(logicalText(lines, i), covered);
    }
  }
  return { covered, unresolved };
}

function collectPrefetches(text: string, covered: Set<string>): void {
  const calls = text.matchAll(/(?:select_related|prefetch_related|Prefetch)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g);
  for (const call of calls) {
    for (const m of (call[1] ?? "").matchAll(/["'](\w+(?:__\w+)*)["']/g)) {
      const parts = (m[1] ?? "").split("__");
      for (let i = 1; i <= parts.length; i++) covered.add(parts.slice(0, i).join("__"));
    }
  }
}

// ---------------------------------------------------------------------------
// Rules

interface Segment {
  name: string;
  called: boolean;
}

function scanScope(scope: Scope, file: string, relations: RelationIndex): Finding[] {
  const out: Finding[] = [];
  const hasIndex = relations.models.length > 0;
  const add = (line: Line, rule: RuleId, confidence: Confidence, message: string, suggestion: string): void => {
    out.push({ file, line: line.index + 1, rule, confidence, message, suggestion, snippet: line.raw.trim(), context: scope.context });
  };
  const hint = scope.unresolved && scope.isLoop ? " (check where the iterated queryset is built)" : "";

  for (const line of scope.body) {
    for (const v of scope.vars) {
      const chainRe = new RegExp(`(?<![\\w.])${escapeRe(v)}((?:\\.\\w+(?:\\((?:[^()]|\\([^()]*\\))*\\))?)+)`, "g");
      for (const m of line.code.matchAll(chainRe)) {
        const segs = parseChain(m[1] ?? "");
        const [first, second] = segs;
        if (!first) continue;

        if (first.called) {
          if (scope.isLoop && first.name === "save") {
            add(line, "save-in-loop", "high", `${v}.save() issues one UPDATE per item`, "Use Model.objects.bulk_update(objs, fields) or a single queryset.update(...)");
          } else if (scope.isLoop && first.name === "delete") {
            add(line, "delete-in-loop", "high", `${v}.delete() issues queries per item`, "Delete in one query: queryset.filter(...).delete()");
          }
          continue;
        }
        if (IGNORED_ATTRS.has(first.name) || first.name.endsWith("_id") || first.name.startsWith("__")) continue;

        const isMulti = relations.multiValued.has(first.name) || first.name.endsWith("_set");
        const isSingle = relations.singleValued.has(first.name);

        if (second?.called && MANAGER_METHODS.has(second.name)) {
          const coveredByPrefetch = scope.covered.has(first.name);
          if (coveredByPrefetch && PREFETCH_SAFE_METHODS.has(second.name)) continue;
          if (coveredByPrefetch) {
            add(
              line,
              "filtered-prefetch-in-loop",
              "high",
              `${v}.${first.name}.${second.name}() bypasses the prefetch cache and runs one query per item`,
              `Use Prefetch("${first.name}", queryset=<Model>.objects.${second.name}(...), to_attr="...") and read the attribute`,
            );
            continue;
          }
          const confidence: Confidence = isMulti ? "high" : "medium";
          const suggestion =
            second.name === "count" || second.name === "exists"
              ? `Annotate the queryset: .annotate(${queryName(first.name)}_count=Count("${queryName(first.name)}")) (or prefetch_related("${first.name}"))`
              : second.name === "all"
                ? `Add .prefetch_related("${first.name}") to the queryset`
                : `Use .prefetch_related(Prefetch("${first.name}", queryset=...)) instead of calling .${second.name}() per item`;
          add(line, "related-manager-in-loop", confidence, `${v}.${first.name}.${second.name}() runs one query per item${hint}`, suggestion);
          continue;
        }

        if (isMulti) continue; // manager object without a call: no query
        if (scope.covered.has(first.name)) {
          // Deeper traversal: obj.author.profile.x needs "author__profile".
          if (second && !second.called && segs[2] && relations.singleValued.has(second.name)) {
            const path = `${first.name}__${second.name}`;
            if (!scope.covered.has(path)) {
              add(line, "fk-access-in-loop", "high", `${v}.${first.name}.${second.name} loads a related object per item`, `Extend to .select_related("${path}")`);
            }
          }
          continue;
        }

        let confidence: Confidence | undefined;
        if (isSingle) confidence = "high";
        else if (second && !second.called) confidence = hasIndex ? "low" : "medium";
        if (!confidence) continue;
        add(
          line,
          "fk-access-in-loop",
          confidence,
          `${v}.${first.name}${second && !second.called ? `.${second.name}` : ""} may load a related object per item${hint}`,
          `Add .select_related("${first.name}") to the queryset (or prefetch_related for generic relations)`,
        );
      }
    }

    if (!scope.isLoop) {
      const q = line.code.match(new RegExp(`\\b(\\w+)\\.objects\\.(${QUERY_METHODS})\\(`));
      if (q) add(line, "query-in-loop", "high", `${q[1]}.objects.${q[2]}() runs once per object`, "Move the query out of the per-object method: annotate or prefetch it in the view's queryset");
      continue;
    }
    for (const q of line.code.matchAll(new RegExp(`\\b(\\w+)\\.objects\\.(${QUERY_METHODS})\\(`, "g"))) {
      const method = q[2] ?? "";
      if (method === "create") {
        add(line, "create-in-loop", "high", `${q[1]}.objects.create() inside a loop issues one INSERT per item`, `Collect instances and call ${q[1]}.objects.bulk_create([...])`);
      } else {
        add(
          line,
          "query-in-loop",
          "high",
          `${q[1]}.objects.${method}() inside a loop runs one query per item`,
          method === "get" || method === "filter"
            ? `Fetch everything once before the loop (filter(..._in=...), in_bulk()) and look up in a dict`
            : "Hoist the query out of the loop or use annotate()/aggregate()",
        );
      }
    }
  }
  return out;
}

function parseChain(chain: string): Segment[] {
  const segs: Segment[] = [];
  for (const m of chain.matchAll(/\.(\w+)(\()?/g)) segs.push({ name: m[1] ?? "", called: Boolean(m[2]) });
  return segs;
}

function scanWholeFile(lines: Line[], file: string): Finding[] {
  const out: Finding[] = [];
  const add = (line: Line, rule: RuleId, confidence: Confidence, message: string, suggestion: string): void => {
    out.push({ file, line: line.index + 1, rule, confidence, message, suggestion, snippet: line.raw.trim() });
  };
  let serializerClass: { name: string; indent: number } | undefined;

  for (const line of lines) {
    const code = line.code;
    if (!code.trim()) continue;

    const cls = code.match(/^(\s*)class\s+(\w+Serializer)\b/);
    if (cls) serializerClass = { name: cls[2] ?? "", indent: line.indent };
    else if (serializerClass && line.indent <= serializerClass.indent && /^\s*(class|def)\s/.test(code)) serializerClass = undefined;

    if (/\blen\(\s*[\w.]*(?:\.objects\.\w+\(|\.(?:all|filter|exclude)\()/.test(code)) {
      add(line, "len-queryset", "medium", "len() on a queryset loads every row into memory", "Use .count() unless the rows are iterated right after");
    }
    if (/\.count\(\)\s*(?:>|>=|!=|==)\s*[01]\b|\b(?:if|elif|while)\s+(?:not\s+)?[\w.()'", =]*\.count\(\)\s*:/.test(code)) {
      add(line, "count-for-existence", "high", "count() used to test existence", "Use .exists(), which stops at the first row");
    }
    if (/^\s*(?:if|elif|while)\s+(?:not\s+)?[\w.]+\.(?:filter|exclude|all)\((?:[^()]|\([^()]*\))*\)\s*:/.test(code)) {
      add(line, "queryset-truthiness", "high", "Testing a queryset's truthiness fetches all its rows", "Use .exists()");
    }
    if (/\blist\((?:[^()]|\([^()]*\))*\.objects\.(?:[^()]|\([^()]*\))*\)\s*\[\s*0\s*\]/.test(code)) {
      add(line, "list-then-index", "medium", "list(queryset)[0] loads every row to keep one", "Use .first() (or [0] directly on the queryset)");
    }

    if (serializerClass && line.indent > serializerClass.indent) {
      const nested = code.match(/^\s*(\w+)\s*=\s*(\w+Serializer)\((.*)$/);
      if (nested) {
        const args = logicalText(lines, line.index);
        const many = /many\s*=\s*True/.test(args);
        const source = args.match(/source\s*=\s*["']([\w.]+)["']/)?.[1];
        const path = (source ?? nested[1] ?? "").replace(/\./g, "__");
        add(
          line,
          "nested-serializer",
          "medium",
          `Nested ${nested[2]}${many ? "(many=True)" : ""} on "${nested[1]}" queries per serialized object unless the view prefetches it`,
          many ? `Ensure the view's queryset uses .prefetch_related("${path}")` : `Ensure the view's queryset uses .select_related("${path}")`,
        );
      }
      const dotted = code.match(/source\s*=\s*["'](\w+(?:\.\w+)+)["']/);
      if (dotted && !nested) {
        const parts = (dotted[1] ?? "").split(".");
        const path = parts.slice(0, -1).join("__");
        add(line, "dotted-source", "medium", `source="${dotted[1]}" traverses a relation per serialized object`, `Ensure the view's queryset uses .select_related("${path}")`);
      }
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shorten(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

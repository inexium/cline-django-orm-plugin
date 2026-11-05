/**
 * Lightweight static parser for Django models (no Python required).
 *
 * It extracts model classes and relation fields from models.py files so the
 * N+1 scanner can tell foreign keys (select_related) from multi-valued
 * relations (prefetch_related). It is a heuristic, not a Python parser.
 */

export type RelationKind = "ForeignKey" | "OneToOneField" | "ManyToManyField" | "GenericForeignKey";

export interface RelationField {
  name: string;
  kind: RelationKind;
  /** Target as written in the source ("auth.User", "Author", "self", settings.AUTH_USER_MODEL...). */
  target: string;
  relatedName?: string;
  line: number;
}

export interface ParsedModel {
  name: string;
  file: string;
  line: number;
  bases: string[];
  relations: RelationField[];
}

export interface RelationIndex {
  models: ParsedModel[];
  /** Forward FK / O2O names and reverse O2O accessors: single object, use select_related. */
  singleValued: Set<string>;
  /** M2M names and reverse FK / M2M accessors: querysets, use prefetch_related. */
  multiValued: Set<string>;
}

const CLASS_RE = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/;
const FIELD_RE = /^\s+(\w+)\s*(?::[^=]+)?=\s*(?:[\w.]*\.)?(ForeignKey|OneToOneField|ManyToManyField|ParentalKey|ParentalManyToManyField|GenericForeignKey)\s*\(/;

export function parseModels(source: string, file: string): ParsedModel[] {
  const lines = source.split(/\r?\n/);
  const models: ParsedModel[] = [];
  let current: ParsedModel | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const classMatch = line.match(CLASS_RE);
    if (classMatch) {
      const bases = (classMatch[2] ?? "").split(",").map((b) => b.trim()).filter(Boolean);
      current = looksLikeModel(bases)
        ? { name: classMatch[1] ?? "", file, line: i + 1, bases, relations: [] }
        : undefined;
      if (current) models.push(current);
      continue;
    }
    if (/^\S/.test(line) && line.trim() && !line.startsWith("#") && !line.startsWith("@")) {
      current = undefined;
      continue;
    }
    if (!current) continue;

    const fieldMatch = line.match(FIELD_RE);
    if (!fieldMatch) continue;
    const name = fieldMatch[1] ?? "";
    const rawKind = fieldMatch[2] ?? "";
    const kind: RelationKind =
      rawKind === "ParentalKey" ? "ForeignKey" : rawKind === "ParentalManyToManyField" ? "ManyToManyField" : (rawKind as RelationKind);
    const args = collectCallArgs(lines, i, line.indexOf("(", line.indexOf(rawKind)));
    current.relations.push({
      name,
      kind,
      target: kind === "GenericForeignKey" ? "" : firstPositionalArg(args) ?? keywordArg(args, "to") ?? "",
      relatedName: keywordArg(args, "related_name"),
      line: i + 1,
    });
  }
  return models;
}

export function buildRelationIndex(models: ParsedModel[]): RelationIndex {
  const singleValued = new Set<string>();
  const multiValued = new Set<string>();
  for (const model of models) {
    const lowerModel = model.name.toLowerCase();
    for (const rel of model.relations) {
      const hidden = rel.relatedName?.endsWith("+") ?? false;
      const related = hidden ? undefined : rel.relatedName;
      switch (rel.kind) {
        case "ForeignKey":
          singleValued.add(rel.name);
          if (!hidden) multiValued.add(related ?? `${lowerModel}_set`);
          break;
        case "OneToOneField":
          singleValued.add(rel.name);
          if (!hidden) singleValued.add(related ?? lowerModel);
          break;
        case "ManyToManyField":
          multiValued.add(rel.name);
          if (!hidden) multiValued.add(related ?? `${lowerModel}_set`);
          break;
        case "GenericForeignKey":
          singleValued.add(rel.name);
          break;
      }
    }
  }
  return { models, singleValued, multiValued };
}

export function emptyRelationIndex(): RelationIndex {
  return { models: [], singleValued: new Set(), multiValued: new Set() };
}

export function isModelsFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(^|\/)models\.py$/.test(normalized) || /(^|\/)models\/[^/]+\.py$/.test(normalized);
}

function looksLikeModel(bases: string[]): boolean {
  return bases.some((b) => /(^|\.)(Model|\w+Model|AbstractUser|AbstractBaseUser|Page|MPTTModel)$/.test(b));
}

/** Concatenates the argument text of a call that may span several lines. */
function collectCallArgs(lines: string[], start: number, openIndex: number): string {
  let depth = 0;
  let out = "";
  for (let i = start; i < lines.length && i < start + 30; i++) {
    const line = lines[i] ?? "";
    for (let c = i === start ? openIndex : 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "(") {
        depth++;
        if (depth === 1) continue;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) return out;
      }
      out += ch;
    }
    out += " ";
  }
  return out;
}

function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | undefined;
  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function firstPositionalArg(args: string): string | undefined {
  const first = splitTopLevel(args)[0];
  if (!first || /^\w+\s*=/.test(first)) return undefined;
  return unquote(first);
}

function keywordArg(args: string, name: string): string | undefined {
  for (const part of splitTopLevel(args)) {
    const m = part.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "s"));
    if (m?.[1]) return unquote(m[1].trim());
  }
  return undefined;
}

function unquote(value: string): string {
  const m = value.match(/^["'](.*)["']$/s);
  return m?.[1] ?? value;
}

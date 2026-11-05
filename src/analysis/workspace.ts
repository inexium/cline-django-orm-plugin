import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atLeast, dedupeFindings, type Confidence, type Finding } from "./findings.js";
import { buildRelationIndex, isModelsFile, parseModels, type ParsedModel, type RelationIndex } from "./models-parser.js";
import { scanPythonSource } from "./python-scanner.js";
import { scanTemplateSource } from "./template-scanner.js";

export interface WalkOptions {
  excludeDirs: readonly string[];
  maxFiles: number;
}

const TEMPLATE_EXTENSIONS = new Set([".html", ".htm", ".jinja", ".jinja2", ".j2", ".txt"]);
const MAX_FILE_BYTES = 1_000_000;

export function isTemplateFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return TEMPLATE_EXTENSIONS.has(extname(normalized)) && /(^|\/)(templates|jinja2)\//.test(normalized);
}

export function isPythonFile(path: string): boolean {
  return extname(path) === ".py" && !/(^|[\\/])migrations[\\/]/.test(path);
}

/** Lists files under `roots` (files or directories), skipping excluded directories and virtualenvs. */
export function walkFiles(roots: readonly string[], options: WalkOptions, filter: (path: string) => boolean): { files: string[]; truncated: boolean } {
  const excluded = new Set(options.excludeDirs);
  const files: string[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let stats;
    try {
      stats = statSync(current);
    } catch {
      continue;
    }
    if (stats.isFile()) {
      if (filter(current) && stats.size <= MAX_FILE_BYTES) files.push(current);
      if (files.length >= options.maxFiles) return { files, truncated: true };
      continue;
    }
    if (!stats.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      continue;
    }
    if (entries.includes("pyvenv.cfg")) continue;
    for (const entry of entries.reverse()) {
      if (excluded.has(entry)) continue;
      stack.push(join(current, entry));
    }
  }
  return { files, truncated: false };
}

export function loadRelationIndex(root: string, options: WalkOptions): RelationIndex {
  const { files } = walkFiles([root], options, (p) => isModelsFile(p) && isPythonFile(p));
  const models: ParsedModel[] = [];
  for (const file of files) {
    const source = readText(file);
    if (source !== undefined) models.push(...parseModels(source, relative(root, file)));
  }
  return buildRelationIndex(models);
}

export interface ScanRequest {
  workspaceRoot: string;
  paths?: readonly string[];
  includeTemplates?: boolean;
  minConfidence?: Confidence;
}

export interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  truncated: boolean;
  rejectedPaths: string[];
}

export function scanFiles(request: ScanRequest, relations: RelationIndex, options: WalkOptions): ScanResult {
  const { workspaceRoot } = request;
  const rejectedPaths: string[] = [];
  const roots: string[] = [];
  for (const p of request.paths?.length ? request.paths : ["."]) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
    if (!isInside(workspaceRoot, abs)) {
      rejectedPaths.push(p);
      continue;
    }
    roots.push(abs);
  }
  const includeTemplates = request.includeTemplates ?? true;
  const { files, truncated } = walkFiles(roots, options, (p) => isPythonFile(p) || (includeTemplates && isTemplateFile(p)));

  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...scanFile(file, workspaceRoot, relations));
  }
  const min = request.minConfidence ?? "medium";
  return {
    findings: dedupeFindings(findings.filter((f) => atLeast(f.confidence, min))),
    filesScanned: files.length,
    truncated,
    rejectedPaths,
  };
}

export function scanFile(absPath: string, workspaceRoot: string, relations: RelationIndex): Finding[] {
  const source = readText(absPath);
  if (source === undefined) return [];
  const rel = relative(workspaceRoot, absPath) || absPath;
  if (isPythonFile(absPath)) return scanPythonSource(source, rel, { relations });
  if (isTemplateFile(absPath)) return scanTemplateSource(source, rel, relations);
  return [];
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

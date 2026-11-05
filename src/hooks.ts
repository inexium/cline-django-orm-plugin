import { isAbsolute, resolve } from "node:path";
import { atLeast, formatFindings } from "./analysis/findings.js";
import { isModelsFile } from "./analysis/models-parser.js";
import { isInside, isPythonFile, isTemplateFile, scanFile } from "./analysis/workspace.js";
import { writesForcedDryRun } from "./config.js";
import { FILE_EDIT_TOOLS, MCP_CODE_EXECUTION_TOOLS, MCP_TOOLS, MCP_WRITE_TOOLS, mcpToolName } from "./constants.js";
import type { AfterToolContext, AfterToolResult, BeforeToolContext, BeforeToolResult } from "./sdk-types.js";
import type { PluginState } from "./state.js";

const MAX_FINDINGS_IN_CONTEXT = 8;

/**
 * beforeTool guard for the django_orm MCP tools. The Python server enforces
 * the same settings (env contract); this is defense in depth on the client.
 */
export function guardMcpToolCall(state: PluginState, ctx: Pick<BeforeToolContext, "tool" | "input">): BeforeToolResult | undefined {
  const prefix = mcpToolName(state.config.mcp.serverName, "");
  const name = ctx.tool?.name ?? "";
  if (!name.startsWith(prefix)) return undefined;
  const tool = name.slice(prefix.length);
  const { safety } = state.config;
  const input = isRecord(ctx.input) ? ctx.input : {};

  if (MCP_WRITE_TOOLS.includes(tool) && writesForcedDryRun(safety) && input.dry_run !== true) {
    return {
      input: { ...input, dry_run: true },
      appendContext: `django-orm: ${tool} was forced to dry_run=true because database writes are disabled (safety.readOnly / safety.allowWrites). Nothing was persisted.`,
    };
  }

  if (MCP_CODE_EXECUTION_TOOLS.includes(tool) && !safety.allowCodeExecution) {
    return {
      skip: true,
      reason:
        `django-orm: ${tool} executes Python code and safety.allowCodeExecution is false. ` +
        `Use ${mcpToolName(state.config.mcp.serverName, MCP_TOOLS.query)} or ${mcpToolName(state.config.mcp.serverName, MCP_TOOLS.profileUrl)} instead, or ask the user to enable it.`,
    };
  }

  if (tool === MCP_TOOLS.rawSql) {
    const sql = typeof input.sql === "string" ? input.sql : typeof input.query === "string" ? input.query : "";
    const verdict = classifySql(sql);
    if (verdict !== "read" && writesForcedDryRun(safety)) {
      return {
        skip: true,
        reason: `django-orm: raw SQL rejected (${verdict === "multiple" ? "multiple statements" : "not a read-only statement"}). Only single SELECT / WITH / EXPLAIN statements are allowed while writes are disabled.`,
      };
    }
  }
  return undefined;
}

export type SqlVerdict = "read" | "write" | "multiple";

/** Conservative classification of a SQL statement. */
export function classifySql(sql: string): SqlVerdict {
  const cleaned = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .trim()
    .replace(/;\s*$/, "");
  if (cleaned.includes(";")) return "multiple";
  if (!/^(select|with|explain|show|values|table|pragma|describe|desc)\b/i.test(cleaned)) return "write";
  if (/^pragma\b/i.test(cleaned) && cleaned.includes("=")) return "write";
  if (/\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|lock|reindex|cluster|refresh|attach|detach|into)\b/i.test(cleaned)) {
    return "write";
  }
  return "read";
}

/** Files touched by the built-in editor / apply_patch tools. */
export function editedPaths(toolName: string, input: unknown): string[] {
  if (toolName === "editor" && isRecord(input) && typeof input.path === "string") return [input.path];
  if (toolName === "apply_patch") {
    const patch = typeof input === "string" ? input : isRecord(input) && typeof input.input === "string" ? input.input : "";
    const paths: string[] = [];
    for (const m of patch.matchAll(/^\*\*\* (?:Update File|Add File|Move to):\s*(.+?)\s*$/gm)) {
      if (m[1]) paths.push(m[1]);
    }
    return [...new Set(paths)];
  }
  return [];
}

/**
 * afterTool hook: after a file edit, invalidate the model index if models
 * changed and run the static N+1 scan on edited Python files and templates.
 * Only findings not reported before in this session are surfaced.
 */
export function createAfterToolHandler(state: PluginState) {
  const reported = new Set<string>();
  return (ctx: Pick<AfterToolContext, "tool" | "input" | "result">): AfterToolResult | undefined => {
    const name = ctx.tool?.name ?? "";
    if (!FILE_EDIT_TOOLS.includes(name) || ctx.result?.isError) return undefined;
    const root = state.config.workspaceRoot;
    const files = editedPaths(name, ctx.input)
      .map((p) => (isAbsolute(p) ? p : resolve(root, p)))
      .filter((p) => isInside(root, p));
    if (files.length === 0) return undefined;

    if (files.some(isModelsFile)) state.invalidateRelations();
    if (!state.config.analysis.autoScanOnEdit) return undefined;

    const targets = files.filter((f) => isPythonFile(f) || isTemplateFile(f));
    if (targets.length === 0) return undefined;
    const relations = state.getRelations();
    const fresh = targets
      .flatMap((f) => scanFile(f, root, relations))
      .filter((f) => atLeast(f.confidence, "medium"))
      .filter((f) => {
        const key = `${f.file}|${f.rule}|${f.message}|${f.snippet}`;
        if (reported.has(key)) return false;
        reported.add(key);
        return true;
      });
    if (fresh.length === 0) return undefined;

    const confirm = state.mcpAvailable
      ? ` Confirm with ${mcpToolName(state.config.mcp.serverName, MCP_TOOLS.profileUrl)} before and after fixing.`
      : "";
    return {
      appendContext:
        `django-orm static check on the files you just edited found possible N+1 / ORM issues.${confirm}\n` +
        formatFindings(fresh, { maxFindings: MAX_FINDINGS_IN_CONTEXT }),
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

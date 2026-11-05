import { formatFindings, type Confidence } from "../analysis/findings.js";
import { scanFiles } from "../analysis/workspace.js";
import { MCP_TOOLS, mcpToolName, PLUGIN_TOOLS } from "../constants.js";
import type { AgentTool } from "../sdk-types.js";
import type { PluginState } from "../state.js";

interface ScanInput {
  paths?: string[];
  includeTemplates?: boolean;
  minConfidence?: Confidence;
  maxFindings?: number;
}

export function createScanNPlusOneTool(state: PluginState): AgentTool<ScanInput, string> {
  return {
    name: PLUGIN_TOOLS.scanNPlusOne,
    description:
      "Statically scan Django code (views, serializers, admin, services, templates) for likely N+1 queries and " +
      "inefficient ORM usage: relation access in loops without select_related/prefetch_related, queries/save()/create() " +
      "inside loops, len()/count() misuse, nested DRF serializers, template loops. Fast, no database needed; findings are " +
      "heuristic and should be confirmed with the MCP query-capture tools.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files or directories relative to the workspace. Default: the whole workspace.",
        },
        includeTemplates: { type: "boolean", description: "Also scan templates/ directories. Default true." },
        minConfidence: { type: "string", enum: ["low", "medium", "high"], description: "Default medium." },
        maxFindings: { type: "integer", minimum: 1, maximum: 500, description: "Default 50." },
      },
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    async execute(input) {
      const result = scanFiles(
        {
          workspaceRoot: state.config.workspaceRoot,
          paths: input?.paths,
          includeTemplates: input?.includeTemplates,
          minConfidence: input?.minConfidence,
        },
        state.getRelations(),
        state.walkOptions,
      );
      const out = [`Scanned ${result.filesScanned} file(s)${result.truncated ? " (limit reached, narrow the paths)" : ""}.`];
      if (result.rejectedPaths.length) out.push(`Ignored paths outside the workspace: ${result.rejectedPaths.join(", ")}`);
      out.push(formatFindings(result.findings, { maxFindings: input?.maxFindings ?? 50 }));
      if (result.findings.length && state.mcpAvailable) {
        const server = state.config.mcp.serverName;
        out.push(
          "",
          `Confirm before fixing: ${mcpToolName(server, MCP_TOOLS.profileUrl)} for a view, ` +
            `${mcpToolName(server, MCP_TOOLS.captureQueries)} for a function or queryset (duplicated SQL fingerprints = N+1).`,
        );
      }
      return out.join("\n");
    },
  };
}

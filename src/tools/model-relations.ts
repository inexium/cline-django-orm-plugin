import type { ParsedModel } from "../analysis/models-parser.js";
import { MCP_TOOLS, mcpToolName, PLUGIN_TOOLS } from "../constants.js";
import type { AgentTool } from "../sdk-types.js";
import type { PluginState } from "../state.js";

interface ModelRelationsInput {
  model?: string;
  format?: "text" | "mermaid";
}

export function createModelRelationsTool(state: PluginState): AgentTool<ModelRelationsInput, string> {
  return {
    name: PLUGIN_TOOLS.modelRelations,
    description:
      "List Django models and their relation fields (ForeignKey, OneToOne, ManyToMany, related_name) parsed statically " +
      "from models.py files, with the select_related / prefetch_related name to use for each relation. Works without a " +
      "database. Optional Mermaid ER diagram.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model name (case-insensitive). Shows the model and the models pointing to it." },
        format: { type: "string", enum: ["text", "mermaid"], description: "Default text." },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const { models } = state.getRelations();
      if (models.length === 0) return "No Django model found in models.py files.";
      const wanted = input?.model?.toLowerCase();
      let selected = models;
      if (wanted) {
        selected = models.filter(
          (m) => m.name.toLowerCase() === wanted || m.relations.some((r) => targetName(r.target).toLowerCase() === wanted),
        );
        if (selected.length === 0) return `Model "${input?.model}" not found. Known models: ${models.map((m) => m.name).join(", ")}`;
      }
      const body = input?.format === "mermaid" ? toMermaid(selected) : toText(selected, models);
      const footer = state.mcpAvailable
        ? `\n\nStatic view only. For live fields, indexes and constraints use ${mcpToolName(state.config.mcp.serverName, MCP_TOOLS.describeModel)}.`
        : "";
      return body + footer;
    },
  };
}

export function targetName(target: string): string {
  if (/AUTH_USER_MODEL|get_user_model/.test(target)) return "User";
  return target.split(".").pop() ?? target;
}

function toText(selected: ParsedModel[], all: ParsedModel[]): string {
  const out: string[] = [];
  for (const model of selected) {
    out.push(`## ${model.name} (${model.file}:${model.line})`);
    if (model.relations.length === 0) out.push("- no relation field");
    for (const rel of model.relations) {
      const loader = rel.kind === "ManyToManyField" ? "prefetch_related" : rel.kind === "GenericForeignKey" ? "prefetch_related" : "select_related";
      const reverse =
        rel.relatedName?.endsWith("+") ? "no reverse accessor" : `reverse: ${targetName(rel.target)}.${rel.relatedName ?? defaultReverse(model.name, rel.kind)}`;
      out.push(`- ${rel.name}: ${rel.kind} -> ${rel.target || "(generic)"} | ${loader}("${rel.name}") | ${reverse}`);
    }
    const incoming = all.flatMap((m) =>
      m.relations.filter((r) => targetName(r.target) === model.name || (r.target === "self" && m === model)).map((r) => ({ m, r })),
    );
    for (const { m, r } of incoming) {
      if (r.relatedName?.endsWith("+")) continue;
      const accessor = r.relatedName ?? defaultReverse(m.name, r.kind);
      const loader = r.kind === "OneToOneField" ? "select_related" : "prefetch_related";
      out.push(`- (reverse) ${accessor}: from ${m.name}.${r.name} | ${loader}("${accessor}")`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

function defaultReverse(modelName: string, kind: string): string {
  const lower = modelName.toLowerCase();
  return kind === "OneToOneField" ? lower : `${lower}_set`;
}

function toMermaid(models: ParsedModel[]): string {
  const lines = ["```mermaid", "erDiagram"];
  for (const model of models) {
    for (const rel of model.relations) {
      if (rel.kind === "GenericForeignKey") continue;
      const target = rel.target === "self" ? model.name : targetName(rel.target);
      const card = rel.kind === "ForeignKey" ? "}o--||" : rel.kind === "OneToOneField" ? "|o--||" : "}o--o{";
      lines.push(`  ${model.name} ${card} ${target} : ${rel.name}`);
    }
    if (model.relations.length === 0) lines.push(`  ${model.name} {}`);
  }
  lines.push("```");
  return lines.join("\n");
}

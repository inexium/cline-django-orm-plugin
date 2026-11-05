import { CONFIG_FILE, MCP_TOOLS, mcpToolName, PLUGIN_TOOLS } from "./constants.js";
import type { PluginCommand } from "./sdk-types.js";
import type { PluginState } from "./state.js";

export function buildCommands(state: PluginState): PluginCommand[] {
  const server = state.config.mcp.serverName;
  const t = (tool: string) => mcpToolName(server, tool);
  const mcp = state.mcpAvailable;
  const noMcp = `The django_orm MCP server is not available (${state.mcpPlan.register ? "" : state.mcpPlan.reason}); rely on static analysis and say which checks could not be run.`;
  const prompt = (text: string[]) => ({ submitPrompt: text.filter(Boolean).join("\n") });

  return [
    {
      name: "django-doctor",
      description: "Check the Django ORM plugin setup (virtualenv, settings, MCP server)",
      handler: () =>
        prompt([
          `Run ${PLUGIN_TOOLS.envCheck} with checkManagementCommand=true.`,
          mcp ? `If the MCP server is registered, call ${t(MCP_TOOLS.migrationsStatus)} to confirm the database connection.` : "",
          `Summarize what works, what is broken and the exact fix for each problem (commands to run or keys to set in ${CONFIG_FILE}). Do not change any file.`,
        ]),
    },
    {
      name: "n-plus-one-audit",
      description: "Audit the project (or a path) for N+1 queries and rank the hotspots",
      handler: (args) => {
        const scope = args.trim();
        return prompt([
          `Audit ${scope ? `"${scope}"` : "this Django project"} for N+1 queries and inefficient ORM usage.`,
          `1. Run ${PLUGIN_TOOLS.scanNPlusOne}${scope ? ` with paths=["${scope}"]` : ""} and ${PLUGIN_TOOLS.modelRelations}.`,
          mcp
            ? `2. Confirm the most likely hotspots dynamically: ${t(MCP_TOOLS.profileUrl)} for views/endpoints (find their URLs in urls.py), ${t(MCP_TOOLS.profileTest)} for code covered by tests. Record query count, duplicated fingerprints and total SQL time.`
            : `2. ${noMcp}`,
          "3. Present a table ranked by impact: location, pattern, measured or estimated queries, proposed fix.",
          "4. Do not modify code yet: ask which items to fix.",
        ]);
      },
    },
    {
      name: "optimize-view",
      description: "Optimize the queries of one view, viewset or URL: measure, fix, verify, pin with a test",
      handler: (args) => {
        const target = args.trim() || "the view the user is working on (ask if unclear)";
        return prompt([
          `Optimize the database access of ${target}.`,
          `1. Locate the view, its queryset, serializer(s) and template(s); run ${PLUGIN_TOOLS.scanNPlusOne} on those files.`,
          mcp ? `2. Measure the baseline with ${t(MCP_TOOLS.profileUrl)} (create enough rows to reveal an N+1 if the local DB is empty, and say so).` : `2. ${noMcp}`,
          "3. Apply the minimal fix: select_related / prefetch_related / Prefetch / annotate / only(), in get_queryset() for DRF.",
          mcp ? `4. Measure again with ${t(MCP_TOOLS.profileUrl)}${state.config.safety.allowCodeExecution ? ` or ${t(MCP_TOOLS.compareQuerysets)}` : ""} and report before/after query counts.` : "4. Explain the expected query count after the fix.",
          `5. Generate a regression test with ${PLUGIN_TOOLS.queryCountTest} and add it to the app's tests.`,
        ]);
      },
    },
    {
      name: "explain-queryset",
      description: "Show the SQL and execution plan of a queryset and suggest indexes",
      handler: (args) =>
        prompt([
          `Explain this queryset: ${args.trim() || "(ask the user for the queryset expression)"}`,
          mcp
            ? `Use ${t(MCP_TOOLS.explainQueryset)} (with analyze=true on the local DB) and ${t(MCP_TOOLS.indexAdvisor)}. Explain the plan in plain words: scans, joins, estimated vs actual rows.`
            : noMcp,
          "If an index would help, propose the Meta.indexes change and the migration, but do not apply it without confirmation.",
        ]),
    },
    {
      name: "django-schema",
      description: "Describe Django models and their relations",
      handler: (args) => {
        const model = args.trim();
        return prompt([
          model ? `Describe the Django model "${model}" and its relations.` : "Give an overview of the Django models and how they relate.",
          mcp ? `Use ${t(model ? MCP_TOOLS.describeModel : MCP_TOOLS.listModels)} and ${t(MCP_TOOLS.modelGraph)}.` : `Use ${PLUGIN_TOOLS.modelRelations}${model ? ` with model="${model}"` : ""} and format="mermaid".`,
          "Include a Mermaid diagram and, for each relation, whether to load it with select_related or prefetch_related.",
        ]);
      },
    },
    {
      name: "index-advisor",
      description: "Look for missing or unused database indexes",
      handler: (args) =>
        prompt([
          `Review database indexes${args.trim() ? ` for ${args.trim()}` : ""}.`,
          mcp ? `Use ${t(MCP_TOOLS.indexAdvisor)} and ${t(MCP_TOOLS.tableStats)}; cross-check with the filters/order_by found in the code.` : noMcp,
          "Propose Meta.indexes / db_index changes with the generated migration; do not apply without confirmation.",
        ]),
    },
  ];
}

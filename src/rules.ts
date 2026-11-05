import { CONFIG_FILE, MCP_TOOLS, mcpToolName, PLUGIN_TOOLS } from "./constants.js";
import type { PluginRule } from "./sdk-types.js";
import type { PluginState } from "./state.js";

export function buildRules(state: PluginState): PluginRule[] {
  const server = state.config.mcp.serverName;
  const t = (tool: string) => mcpToolName(server, tool);

  const rules: PluginRule[] = [
    {
      id: "django-orm-safety",
      source: "django-orm plugin",
      content: () => {
        const s = state.config.safety;
        return [
          "# Django ORM: database safety",
          "- The database reachable through the django-orm tools is the LOCAL DEVELOPMENT database. Never point them at staging or production.",
          `- Database writes are ${s.readOnly || !s.allowWrites ? "DISABLED: write tools always run as dry-run (the transaction is rolled back)" : "allowed but must be previewed with dry_run=true first and confirmed by the user"}.`,
          `- Arbitrary Python execution in the Django process is ${s.allowCodeExecution ? "enabled; keep snippets side-effect free" : `disabled; use the structured ${t(MCP_TOOLS.query)} tool, ${t(MCP_TOOLS.profileUrl)} and ${t(MCP_TOOLS.profileTest)}`}.`,
          "- Never run manage.py flush, reset_db, sqlflush or destructive raw SQL, and never print secrets (passwords, tokens, API keys) from the database.",
          `- Settings live in ${CONFIG_FILE}; ask the user before changing safety settings.`,
        ].join("\n");
      },
    },
    {
      id: "django-orm-performance",
      source: "django-orm plugin",
      content: [
        "# Django ORM: query performance conventions",
        "- Accessing a ForeignKey / OneToOne in a loop, template loop, serializer field or admin column requires select_related(\"<fk>\") on the queryset.",
        "- Accessing a reverse FK or ManyToMany (.all(), nested serializer many=True, {% for x in obj.rel.all %}) requires prefetch_related(\"<rel>\"); filtering it per object requires Prefetch(\"<rel>\", queryset=..., to_attr=...).",
        "- Counting related rows per object: annotate(n=Count(\"<rel>\")) instead of obj.rel.count().",
        "- Existence checks use .exists(); counts use .count() (not len(qs)) unless the rows are iterated anyway.",
        "- No .save(), .create() or .objects.get() inside loops: use bulk_create, bulk_update, queryset.update() or one query plus a dict lookup.",
        "- Fetch only what is needed: values()/values_list() for plain data, only()/defer() for wide tables, iterator() for large exports.",
        "- DRF: optimize in the view's get_queryset(), not in the serializer.",
        `- After changing a view, serializer, template or queryset, check it: ${PLUGIN_TOOLS.scanNPlusOne} statically${state.mcpAvailable ? `, then ${t(MCP_TOOLS.profileUrl)} or ${t(MCP_TOOLS.captureQueries)} to measure the real query count` : ""}.`,
        `- Pin optimized views with a query-count test (${PLUGIN_TOOLS.queryCountTest}).`,
      ].join("\n"),
    },
  ];

  if (state.mcpAvailable) {
    rules.push({
      id: "django-orm-mcp-tools",
      source: "django-orm plugin",
      whenToolAvailable: t(MCP_TOOLS.listModels),
      content: [
        `# Django ORM: MCP server "${server}"`,
        `- Schema: ${t(MCP_TOOLS.listModels)}, ${t(MCP_TOOLS.describeModel)}, ${t(MCP_TOOLS.modelGraph)}, ${t(MCP_TOOLS.migrationsStatus)}. Read the schema before writing a query on an unfamiliar model.`,
        `- Data: prefer ${t(MCP_TOOLS.query)} (structured filters) over ${t(MCP_TOOLS.rawSql)}; ${t(MCP_TOOLS.sampleRows)} for a quick look. Results are truncated and sensitive fields masked.`,
        `- Plans: ${t(MCP_TOOLS.explainQueryset)} (EXPLAIN / ANALYZE), ${t(MCP_TOOLS.indexAdvisor)} for missing indexes.`,
        `- N+1: ${t(MCP_TOOLS.profileUrl)} (a URL through the test client), ${t(MCP_TOOLS.profileTest)} (a test label), ${t(MCP_TOOLS.captureQueries)} (a snippet). Repeated SQL fingerprints with a project stack frame are the N+1 to fix.`,
        `- Validate an optimization with ${t(MCP_TOOLS.compareQuerysets)} (before/after query count and time).`,
        `- After editing models or project code the server may hold stale modules: call ${t(MCP_TOOLS.reload)}.`,
      ].join("\n"),
    });
  }
  return rules;
}

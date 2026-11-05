/**
 * Shared names, including the contract with the Python MCP server
 * (see docs/MCP_CONTRACT.md). Keep both in sync.
 */

export const PLUGIN_NAME = "django-orm";
export const CONFIG_FILE = ".cline/django-orm.json";

/** Default MCP server name. Cline exposes its tools as `<server>__<tool>`. */
export const DEFAULT_MCP_SERVER_NAME = "django_orm";

/** Management command the Python package must provide (stdio transport). */
export const DEFAULT_MCP_MANAGEMENT_COMMAND = "mcp_serve";

/** Tools the Python MCP server is expected to expose. */
export const MCP_TOOLS = {
  // Introspection
  listModels: "list_models",
  describeModel: "describe_model",
  modelGraph: "model_graph",
  migrationsStatus: "migrations_status",
  sqlmigrate: "sqlmigrate",
  sampleRows: "sample_rows",
  tableStats: "table_stats",
  // Queries
  query: "query",
  runQueryset: "run_queryset",
  explainQueryset: "explain_queryset",
  rawSql: "raw_sql",
  aggregate: "aggregate",
  // Writes (dry-run by default)
  createObjects: "create_objects",
  updateObjects: "update_objects",
  deleteObjects: "delete_objects",
  // Performance
  captureQueries: "capture_queries",
  profileUrl: "profile_url",
  profileTest: "profile_test",
  suggestOptimizations: "suggest_optimizations",
  indexAdvisor: "index_advisor",
  compareQuerysets: "compare_querysets",
  // Lifecycle
  reload: "reload",
} as const;

export type McpToolKey = keyof typeof MCP_TOOLS;

export const MCP_WRITE_TOOLS: readonly string[] = [
  MCP_TOOLS.createObjects,
  MCP_TOOLS.updateObjects,
  MCP_TOOLS.deleteObjects,
];

/** Tools that evaluate arbitrary Python code inside the Django process. */
export const MCP_CODE_EXECUTION_TOOLS: readonly string[] = [
  MCP_TOOLS.runQueryset,
  MCP_TOOLS.captureQueries,
  MCP_TOOLS.compareQuerysets,
];

/** Environment variables passed to the MCP server (contract). */
export const MCP_ENV = {
  settingsModule: "DJANGO_SETTINGS_MODULE",
  readOnly: "DJANGO_ORM_MCP_READ_ONLY",
  allowWrites: "DJANGO_ORM_MCP_ALLOW_WRITES",
  allowCodeExecution: "DJANGO_ORM_MCP_ALLOW_CODE_EXECUTION",
  maxRows: "DJANGO_ORM_MCP_MAX_ROWS",
  statementTimeoutMs: "DJANGO_ORM_MCP_STATEMENT_TIMEOUT_MS",
  maskedFields: "DJANGO_ORM_MCP_MASKED_FIELDS",
  allowNonLocalDb: "DJANGO_ORM_MCP_ALLOW_NON_LOCAL_DB",
  database: "DJANGO_ORM_MCP_DATABASE",
} as const;

/** Built-in Cline tools that modify files (names from @cline/core). */
export const FILE_EDIT_TOOLS: readonly string[] = ["editor", "apply_patch"];

/** Plugin-side tools (registered with registerTool). */
export const PLUGIN_TOOLS = {
  envCheck: "django_env_check",
  scanNPlusOne: "django_scan_n_plus_one",
  modelRelations: "django_model_relations",
  queryCountTest: "django_query_count_test",
} as const;

/**
 * Name under which Cline exposes an MCP tool to the model. Mirrors the SDK's
 * default transform: `<server>__<tool>` with characters outside
 * `[a-zA-Z0-9_-]` replaced by `_` (names longer than 64 chars are hashed by
 * Cline; keep server and tool names short to avoid that).
 */
export function mcpToolName(serverName: string, tool: string): string {
  return `${serverName}__${tool}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

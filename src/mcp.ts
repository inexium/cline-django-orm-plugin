import { DEFAULT_MCP_ARGS, writesForcedDryRun, type ResolvedConfig } from "./config.js";
import { MCP_ENV } from "./constants.js";
import type { McpServerDefinition } from "./sdk-types.js";

export type McpRegistrationPlan =
  | { register: true; server: McpServerDefinition; description: string }
  | { register: false; reason: string };

/** Builds the env contract passed to the Python MCP server (docs/MCP_CONTRACT.md). */
export function buildMcpEnv(config: ResolvedConfig): Record<string, string> {
  const { safety } = config;
  const env: Record<string, string> = {
    [MCP_ENV.readOnly]: flag(safety.readOnly),
    [MCP_ENV.allowWrites]: flag(!writesForcedDryRun(safety)),
    [MCP_ENV.allowCodeExecution]: flag(safety.allowCodeExecution),
    [MCP_ENV.allowNonLocalDb]: flag(safety.allowNonLocalDb),
    [MCP_ENV.maxRows]: String(safety.maxRows),
    [MCP_ENV.statementTimeoutMs]: String(safety.statementTimeoutMs),
    [MCP_ENV.maskedFields]: safety.maskedFields.join(","),
    PYTHONUNBUFFERED: "1",
  };
  if (config.settingsModule) env[MCP_ENV.settingsModule] = config.settingsModule.value;
  if (config.database) env[MCP_ENV.database] = config.database;
  // User-provided values win, except they cannot loosen safety flags silently:
  // those come only from the `safety` section.
  const protectedKeys = new Set<string>([
    MCP_ENV.readOnly,
    MCP_ENV.allowWrites,
    MCP_ENV.allowCodeExecution,
    MCP_ENV.allowNonLocalDb,
  ]);
  for (const [key, value] of Object.entries(config.mcp.env)) {
    if (!protectedKeys.has(key)) env[key] = value;
  }
  return env;
}

export function planMcpRegistration(config: ResolvedConfig): McpRegistrationPlan {
  const { mcp } = config;
  if (!mcp.enabled) return { register: false, reason: "MCP server disabled (mcp.enabled = false)" };

  if (mcp.url) {
    return {
      register: true,
      server: {
        name: mcp.serverName,
        transport: { type: mcp.transport, url: mcp.url },
        metadata: { plugin: "django-orm" },
      },
      description: `${mcp.transport} ${mcp.url}`,
    };
  }

  if (!config.projectRoot) {
    return { register: false, reason: "No Django project (manage.py) detected in the workspace" };
  }

  const [command, ...args] = mcp.command ?? [config.python.path, ...DEFAULT_MCP_ARGS];
  if (!command) return { register: false, reason: "mcp.command is empty" };

  return {
    register: true,
    server: {
      name: mcp.serverName,
      transport: { type: "stdio", command, args, cwd: config.projectRoot, env: buildMcpEnv(config) },
      metadata: { plugin: "django-orm", projectRoot: config.projectRoot },
    },
    description: `stdio: ${[command, ...args].join(" ")} (cwd ${config.projectRoot})`,
  };
}

function flag(value: boolean): string {
  return value ? "1" : "0";
}

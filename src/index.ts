/**
 * Cline plugin for Django ORM.
 *
 * - Registers the Python MCP server (django-orm-mcp) that talks to the local
 *   development database through the project's own Django settings.
 * - Adds plugin-side tools that need no database: environment check, static
 *   N+1 scanner, model relations, query-count test generator.
 * - Adds rules, slash commands, and hooks (MCP safety guard, N+1 check after
 *   each file edit).
 */
import { buildCommands } from "./commands.js";
import { resolveConfig } from "./config.js";
import { PLUGIN_NAME } from "./constants.js";
import { createAfterToolHandler, guardMcpToolCall } from "./hooks.js";
import { planMcpRegistration } from "./mcp.js";
import { buildRules } from "./rules.js";
import type { AgentPlugin, PluginApi, PluginContext } from "./sdk-types.js";
import { PluginState } from "./state.js";
import { createEnvCheckTool } from "./tools/env-check.js";
import { createModelRelationsTool } from "./tools/model-relations.js";
import { createQueryCountTestTool } from "./tools/query-count-test.js";
import { createScanNPlusOneTool } from "./tools/scan-n-plus-one.js";

export interface CreatePluginOptions {
  /** Overrides process.env (tests). */
  env?: NodeJS.ProcessEnv;
}

export function createDjangoOrmPlugin(options: CreatePluginOptions = {}): AgentPlugin {
  // Hooks are declared statically on the plugin, so they read the state
  // created by setup(). Each session evaluates its own copy of the module.
  let state: PluginState | undefined;
  let afterTool: ReturnType<typeof createAfterToolHandler> | undefined;

  return {
    name: PLUGIN_NAME,
    manifest: {
      capabilities: ["mcp", "tools", "rules", "commands", "hooks"],
    },
    hooks: {
      beforeTool: (ctx) => (state ? guardMcpToolCall(state, ctx) : undefined),
      afterTool: (ctx) => (afterTool ? afterTool(ctx) : undefined),
    },
    setup(api: PluginApi, ctx: PluginContext) {
      const workspaceRoot = ctx?.workspaceInfo?.rootPath ?? ctx?.cwd ?? process.cwd();
      const config = resolveConfig(workspaceRoot, options.env ?? process.env);
      const plan = planMcpRegistration(config);
      state = new PluginState(config, plan, ctx?.logger ?? {});
      afterTool = createAfterToolHandler(state);

      for (const warning of config.warnings) ctx?.logger?.warn?.(`django-orm: ${warning}`);
      if (plan.register) {
        api.registerMcpServer(plan.server);
        ctx?.logger?.info?.(`django-orm: MCP server "${plan.server.name}" -> ${plan.description}`);
      } else {
        ctx?.logger?.info?.(`django-orm: MCP server not registered: ${plan.reason}`);
      }

      api.registerTool(createEnvCheckTool(state));
      api.registerTool(createScanNPlusOneTool(state));
      api.registerTool(createModelRelationsTool(state));
      api.registerTool(createQueryCountTestTool());
      for (const rule of buildRules(state)) api.registerRule(rule);
      for (const command of buildCommands(state)) api.registerCommand(command);
    },
  };
}

const plugin = createDjangoOrmPlugin();

export { plugin };
export default plugin;

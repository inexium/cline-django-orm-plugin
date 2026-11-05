import { existsSync } from "node:fs";
import { relative } from "node:path";
import { CONFIG_FILE, DEFAULT_MCP_MANAGEMENT_COMMAND, PLUGIN_TOOLS } from "../constants.js";
import type { AgentTool } from "../sdk-types.js";
import type { PluginState } from "../state.js";
import { run } from "../util/exec.js";

interface EnvCheckInput {
  checkManagementCommand?: boolean;
}

interface PythonProbe {
  python: string;
  executable: string;
  django: string | null;
  mcp: string | null;
  django_orm_mcp: string | null;
  django_orm_mcp_module: boolean;
  drf: string | null;
}

/** Stdlib-only probe: does not import Django settings or project code. */
export const PYTHON_PROBE = [
  "import json, sys",
  "from importlib import metadata, util",
  "def ver(name):",
  "    try:",
  "        return metadata.version(name)",
  "    except Exception:",
  "        return None",
  "print(json.dumps({'python': sys.version.split()[0], 'executable': sys.executable,",
  "    'django': ver('Django'), 'mcp': ver('mcp'), 'django_orm_mcp': ver('django-orm-mcp'),",
  "    'django_orm_mcp_module': util.find_spec('django_orm_mcp') is not None,",
  "    'drf': ver('djangorestframework')}))",
].join("\n");

export function createEnvCheckTool(state: PluginState): AgentTool<EnvCheckInput, string> {
  return {
    name: PLUGIN_TOOLS.envCheck,
    description:
      "Diagnose the local Django setup used by the django-orm plugin: manage.py location, virtualenv Python, " +
      "DJANGO_SETTINGS_MODULE, installed Django / MCP packages, MCP server registration and safety settings. " +
      "Run it first when the django_orm MCP tools are missing or failing.",
    inputSchema: {
      type: "object",
      properties: {
        checkManagementCommand: {
          type: "boolean",
          description: `Also run "manage.py help ${DEFAULT_MCP_MANAGEMENT_COMMAND}" (loads the Django settings; slower). Default false.`,
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    async execute(input, context) {
      const { config, mcpPlan } = state;
      const rel = (p?: string) => (p ? relative(config.workspaceRoot, p) || "." : "-");
      const lines: string[] = ["# Django ORM plugin: environment check", ""];

      lines.push("## Project");
      lines.push(`- Workspace: ${config.workspaceRoot}`);
      lines.push(`- Django project root: ${config.projectRoot ? rel(config.projectRoot) : "NOT FOUND"}`);
      lines.push(`- Settings module: ${config.settingsModule ? `${config.settingsModule.value} (from ${config.settingsModule.source})` : "UNKNOWN"}`);
      lines.push(`- Config file: ${config.configFile ? rel(config.configFile) : `none (optional: ${CONFIG_FILE})`}`);

      lines.push("", "## Python");
      const pythonExists = config.python.source === "fallback" || existsSync(config.python.path);
      lines.push(`- Interpreter: ${config.python.path} (from ${config.python.source})${pythonExists ? "" : " - FILE NOT FOUND"}`);
      const probe = await run(config.python.path, ["-I", "-c", PYTHON_PROBE], {
        cwd: config.projectRoot ?? config.workspaceRoot,
        signal: context?.signal,
      });
      let info: PythonProbe | undefined;
      if (probe.ok) {
        try {
          info = JSON.parse(probe.stdout.trim().split("\n").pop() ?? "") as PythonProbe;
        } catch {
          info = undefined;
        }
      }
      if (!info) {
        lines.push(`- Probe failed: ${probe.error ?? "unexpected output"}${probe.stderr ? `\n  ${probe.stderr.trim().slice(0, 500)}` : ""}`);
      } else {
        lines.push(`- Python ${info.python} (${info.executable})`);
        lines.push(`- Django: ${info.django ?? "NOT INSTALLED"}`);
        lines.push(`- Django REST framework: ${info.drf ?? "not installed"}`);
        lines.push(`- MCP Python SDK (mcp): ${info.mcp ?? "not installed"}`);
        lines.push(`- django-orm-mcp: ${info.django_orm_mcp ?? (info.django_orm_mcp_module ? "module found" : "NOT INSTALLED")}`);
      }

      if (input?.checkManagementCommand && config.managePy) {
        const help = await run(config.python.path, ["manage.py", "help", DEFAULT_MCP_MANAGEMENT_COMMAND], {
          cwd: config.projectRoot,
          timeoutMs: 45_000,
          signal: context?.signal,
        });
        lines.push(
          `- manage.py ${DEFAULT_MCP_MANAGEMENT_COMMAND}: ${help.ok ? "available" : `FAILED (${(help.stderr.trim().split("\n").pop() ?? help.error ?? "").slice(0, 300)})`}`,
        );
      }

      lines.push("", "## MCP server");
      if (mcpPlan.register) {
        lines.push(`- Registered as "${mcpPlan.server.name}": ${mcpPlan.description}`);
        lines.push(`- Its tools are exposed as ${mcpPlan.server.name}__<tool> (e.g. ${mcpPlan.server.name}__list_models)`);
      } else {
        lines.push(`- Not registered: ${mcpPlan.reason}`);
      }

      const s = config.safety;
      lines.push("", "## Safety");
      lines.push(`- Read-only: ${s.readOnly}; writes allowed: ${s.allowWrites && !s.readOnly}; code execution: ${s.allowCodeExecution}`);
      lines.push(`- Non-local database allowed: ${s.allowNonLocalDb}; max rows: ${s.maxRows}; statement timeout: ${s.statementTimeoutMs} ms`);
      lines.push(`- Masked fields: ${s.maskedFields.join(", ")}`);

      const problems = [...config.warnings];
      if (info && !info.django) problems.push("Django is not installed in the selected interpreter: set \"python\" in " + CONFIG_FILE);
      if (info && !info.django_orm_mcp && !info.django_orm_mcp_module && mcpPlan.register && !config.mcp.url && !config.mcp.command) {
        problems.push("The django-orm-mcp package is not installed: the MCP server cannot start (pip install django-orm-mcp and add it to INSTALLED_APPS)");
      }
      lines.push("", "## Problems");
      lines.push(...(problems.length ? problems.map((p) => `- ${p}`) : ["- None detected"]));
      return lines.join("\n");
    },
  };
}

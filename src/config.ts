import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_MCP_MANAGEMENT_COMMAND, DEFAULT_MCP_SERVER_NAME } from "./constants.js";

/** Shape of `.cline/django-orm.json` (every field is optional). */
export interface UserConfig {
  /** Directory containing manage.py, relative to the workspace root. */
  projectRoot?: string;
  /** Python interpreter of the project's virtualenv. */
  python?: string;
  /** DJANGO_SETTINGS_MODULE used by the MCP server. */
  settingsModule?: string;
  /** Django database alias the MCP server should use (default: "default"). */
  database?: string;
  mcp?: {
    enabled?: boolean;
    serverName?: string;
    /** Full command override, e.g. ["uv", "run", "python", "manage.py", "mcp_serve"]. */
    command?: string[];
    /** Connect to an already running server instead of spawning one. */
    url?: string;
    transport?: "streamableHttp" | "sse";
    env?: Record<string, string>;
  };
  safety?: {
    readOnly?: boolean;
    allowWrites?: boolean;
    allowCodeExecution?: boolean;
    allowNonLocalDb?: boolean;
    maxRows?: number;
    statementTimeoutMs?: number;
    maskedFields?: string[];
  };
  analysis?: {
    autoScanOnEdit?: boolean;
    excludeDirs?: string[];
    maxFiles?: number;
  };
}

export interface SafetyConfig {
  readOnly: boolean;
  allowWrites: boolean;
  allowCodeExecution: boolean;
  allowNonLocalDb: boolean;
  maxRows: number;
  statementTimeoutMs: number;
  maskedFields: string[];
}

export interface AnalysisConfig {
  autoScanOnEdit: boolean;
  excludeDirs: string[];
  maxFiles: number;
}

export interface ResolvedConfig {
  workspaceRoot: string;
  /** Absolute directory containing manage.py, or undefined when not found. */
  projectRoot?: string;
  managePy?: string;
  python: { path: string; source: "config" | "VIRTUAL_ENV" | "venv" | "fallback" };
  settingsModule?: { value: string; source: "config" | "env" | "manage.py" };
  database?: string;
  mcp: {
    enabled: boolean;
    serverName: string;
    command?: string[];
    url?: string;
    transport: "streamableHttp" | "sse";
    env: Record<string, string>;
  };
  safety: SafetyConfig;
  analysis: AnalysisConfig;
  configFile?: string;
  warnings: string[];
}

export const DEFAULT_MASKED_FIELDS = [
  "password",
  "token",
  "secret",
  "api_key",
  "apikey",
  "private_key",
  "session_key",
];

export const DEFAULT_EXCLUDE_DIRS = [
  ".git",
  ".hg",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages",
  "dist",
  "build",
  "static",
  "staticfiles",
  "media",
  "migrations",
  ".cline",
];

const VENV_DIR_NAMES = [".venv", "venv", "env", ".env"];

export function readUserConfig(workspaceRoot: string): { config: UserConfig; file?: string; error?: string } {
  const file = join(workspaceRoot, CONFIG_FILE);
  if (!existsSync(file)) return { config: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: {}, file, error: `${CONFIG_FILE} must contain a JSON object` };
    }
    return { config: parsed as UserConfig, file };
  } catch (error) {
    return { config: {}, file, error: `Cannot parse ${CONFIG_FILE}: ${(error as Error).message}` };
  }
}

/** Finds the directory holding manage.py: workspace root first, then up to two levels down. */
export function findDjangoProjectRoot(workspaceRoot: string, excludeDirs: readonly string[] = DEFAULT_EXCLUDE_DIRS): string | undefined {
  const excluded = new Set(excludeDirs);
  let level: string[] = [workspaceRoot];
  for (let depth = 0; depth <= 2; depth++) {
    const next: string[] = [];
    for (const dir of level.sort()) {
      if (existsSync(join(dir, "manage.py"))) return dir;
      for (const child of safeReaddir(dir)) {
        if (excluded.has(child) || child.startsWith(".")) continue;
        const full = join(dir, child);
        if (isDirectory(full) && !existsSync(join(full, "pyvenv.cfg"))) next.push(full);
      }
    }
    level = next;
  }
  return undefined;
}

/** Reads `os.environ.setdefault("DJANGO_SETTINGS_MODULE", "...")` from manage.py. */
export function parseSettingsModuleFromManagePy(source: string): string | undefined {
  const match = source.match(/setdefault\(\s*["']DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/);
  return match?.[1];
}

export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

export function findPython(
  dirs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedConfig["python"] {
  for (const dir of dirs) {
    for (const name of VENV_DIR_NAMES) {
      const candidate = venvPython(join(dir, name), platform);
      if (existsSync(candidate)) return { path: candidate, source: "venv" };
    }
  }
  if (env.VIRTUAL_ENV) {
    const candidate = venvPython(env.VIRTUAL_ENV, platform);
    if (existsSync(candidate)) return { path: candidate, source: "VIRTUAL_ENV" };
  }
  return { path: platform === "win32" ? "python" : "python3", source: "fallback" };
}

export function resolveConfig(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const warnings: string[] = [];
  const { config, file, error } = readUserConfig(workspaceRoot);
  if (error) warnings.push(error);

  const analysis: AnalysisConfig = {
    autoScanOnEdit: config.analysis?.autoScanOnEdit ?? true,
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS, ...(config.analysis?.excludeDirs ?? [])],
    maxFiles: positiveInt(config.analysis?.maxFiles, 2000),
  };

  let projectRoot: string | undefined;
  if (config.projectRoot) {
    projectRoot = resolvePath(workspaceRoot, config.projectRoot);
    if (!existsSync(join(projectRoot, "manage.py"))) {
      warnings.push(`projectRoot "${config.projectRoot}" does not contain manage.py`);
    }
  } else {
    projectRoot = findDjangoProjectRoot(workspaceRoot, analysis.excludeDirs);
    if (!projectRoot) warnings.push("No manage.py found in the workspace (searched two levels deep)");
  }
  const managePy = projectRoot ? join(projectRoot, "manage.py") : undefined;

  let python: ResolvedConfig["python"];
  if (config.python) {
    python = { path: resolvePath(workspaceRoot, config.python), source: "config" };
  } else {
    const dirs = projectRoot && projectRoot !== workspaceRoot ? [projectRoot, workspaceRoot] : [workspaceRoot];
    python = findPython(dirs, env);
    if (python.source === "fallback") {
      warnings.push(`No virtualenv found; falling back to "${python.path}" from PATH`);
    }
  }

  let settingsModule: ResolvedConfig["settingsModule"];
  if (config.settingsModule) {
    settingsModule = { value: config.settingsModule, source: "config" };
  } else if (env.DJANGO_SETTINGS_MODULE) {
    settingsModule = { value: env.DJANGO_SETTINGS_MODULE, source: "env" };
  } else if (managePy && existsSync(managePy)) {
    const value = parseSettingsModuleFromManagePy(readFileSync(managePy, "utf8"));
    if (value) settingsModule = { value, source: "manage.py" };
  }
  if (projectRoot && !settingsModule) {
    warnings.push("DJANGO_SETTINGS_MODULE could not be determined; set settingsModule in " + CONFIG_FILE);
  }

  const transport = config.mcp?.transport === "sse" ? "sse" : "streamableHttp";
  const safety: SafetyConfig = {
    readOnly: config.safety?.readOnly ?? true,
    allowWrites: config.safety?.allowWrites ?? false,
    allowCodeExecution: config.safety?.allowCodeExecution ?? false,
    allowNonLocalDb: config.safety?.allowNonLocalDb ?? false,
    maxRows: positiveInt(config.safety?.maxRows, 200),
    statementTimeoutMs: positiveInt(config.safety?.statementTimeoutMs, 5000),
    maskedFields: uniq([...DEFAULT_MASKED_FIELDS, ...(config.safety?.maskedFields ?? [])]),
  };
  if (safety.allowWrites && safety.readOnly) {
    warnings.push("safety.allowWrites is ignored while safety.readOnly is true");
  }

  return {
    workspaceRoot,
    projectRoot,
    managePy,
    python,
    settingsModule,
    database: config.database,
    mcp: {
      enabled: config.mcp?.enabled ?? true,
      serverName: config.mcp?.serverName ?? DEFAULT_MCP_SERVER_NAME,
      command: config.mcp?.command?.length ? config.mcp.command : undefined,
      url: config.mcp?.url,
      transport,
      env: config.mcp?.env ?? {},
    },
    safety,
    analysis,
    configFile: file,
    warnings,
  };
}

/** True when writes must be forced to dry-run on the client side. */
export function writesForcedDryRun(safety: SafetyConfig): boolean {
  return safety.readOnly || !safety.allowWrites;
}

export const DEFAULT_MCP_ARGS = ["manage.py", DEFAULT_MCP_MANAGEMENT_COMMAND];

function resolvePath(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

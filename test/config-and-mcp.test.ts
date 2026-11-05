import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettingsModuleFromManagePy, resolveConfig } from "../src/config.js";
import { buildMcpEnv, planMcpRegistration } from "../src/mcp.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "django-orm-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content = ""): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

const MANAGE = 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings.dev")\n';

describe("resolveConfig", () => {
  it("detects manage.py in a subdirectory, the venv and the settings module", () => {
    write("backend/manage.py", MANAGE);
    write("backend/.venv/bin/python");
    write("backend/.venv/pyvenv.cfg");
    const config = resolveConfig(dir, {});
    expect(config.projectRoot).toBe(join(dir, "backend"));
    expect(config.python).toEqual({ path: join(dir, "backend/.venv/bin/python"), source: "venv" });
    expect(config.settingsModule).toEqual({ value: "mysite.settings.dev", source: "manage.py" });
    expect(config.safety).toMatchObject({ readOnly: true, allowWrites: false, allowCodeExecution: false });
    expect(config.warnings).toEqual([]);
  });

  it("does not mistake a virtualenv for the project", () => {
    write(".venv/pyvenv.cfg");
    write(".venv/lib/manage.py", MANAGE);
    const config = resolveConfig(dir, {});
    expect(config.projectRoot).toBeUndefined();
    expect(config.warnings.join("\n")).toContain("No manage.py");
  });

  it("applies .cline/django-orm.json and environment overrides", () => {
    write("manage.py", MANAGE);
    write(
      ".cline/django-orm.json",
      JSON.stringify({
        python: "tools/py",
        settingsModule: "mysite.settings.local",
        mcp: { serverName: "orm", env: { FOO: "1", DJANGO_ORM_MCP_ALLOW_WRITES: "1" } },
        safety: { readOnly: false, allowWrites: true, maxRows: 50, maskedFields: ["iban"] },
        analysis: { autoScanOnEdit: false },
      }),
    );
    const config = resolveConfig(dir, { DJANGO_SETTINGS_MODULE: "ignored.settings" });
    expect(config.python).toEqual({ path: join(dir, "tools/py"), source: "config" });
    expect(config.settingsModule?.value).toBe("mysite.settings.local");
    expect(config.mcp.serverName).toBe("orm");
    expect(config.safety.maxRows).toBe(50);
    expect(config.safety.maskedFields).toContain("iban");
    expect(config.analysis.autoScanOnEdit).toBe(false);
  });

  it("reports an invalid config file", () => {
    write("manage.py", MANAGE);
    write(".cline/django-orm.json", "{ nope");
    expect(resolveConfig(dir, {}).warnings.join("\n")).toContain("Cannot parse");
  });

  it("parses manage.py settings", () => {
    expect(parseSettingsModuleFromManagePy("os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'a.b')")).toBe("a.b");
    expect(parseSettingsModuleFromManagePy("print(1)")).toBeUndefined();
  });
});

describe("planMcpRegistration", () => {
  it("spawns manage.py mcp_serve with the venv python and the safety env", () => {
    write("manage.py", MANAGE);
    write("venv/bin/python");
    const config = resolveConfig(dir, {});
    const plan = planMcpRegistration(config);
    expect(plan.register).toBe(true);
    if (!plan.register) return;
    expect(plan.server.name).toBe("django_orm");
    expect(plan.server.transport).toMatchObject({
      type: "stdio",
      command: join(dir, "venv/bin/python"),
      args: ["manage.py", "mcp_serve"],
      cwd: dir,
    });
    const env = (plan.server.transport as { env: Record<string, string> }).env;
    expect(env).toMatchObject({
      DJANGO_SETTINGS_MODULE: "mysite.settings.dev",
      DJANGO_ORM_MCP_READ_ONLY: "1",
      DJANGO_ORM_MCP_ALLOW_WRITES: "0",
      DJANGO_ORM_MCP_ALLOW_CODE_EXECUTION: "0",
      DJANGO_ORM_MCP_MAX_ROWS: "200",
    });
  });

  it("does not let mcp.env loosen safety flags", () => {
    write("manage.py", MANAGE);
    write(".cline/django-orm.json", JSON.stringify({ mcp: { env: { DJANGO_ORM_MCP_READ_ONLY: "0", EXTRA: "x" } } }));
    const env = buildMcpEnv(resolveConfig(dir, {}));
    expect(env.DJANGO_ORM_MCP_READ_ONLY).toBe("1");
    expect(env.EXTRA).toBe("x");
  });

  it("supports a custom command, a remote URL, and disabling", () => {
    write("manage.py", MANAGE);
    write(".cline/django-orm.json", JSON.stringify({ mcp: { command: ["uv", "run", "python", "manage.py", "mcp_serve"] } }));
    const custom = planMcpRegistration(resolveConfig(dir, {}));
    expect(custom.register && custom.server.transport).toMatchObject({ command: "uv", args: ["run", "python", "manage.py", "mcp_serve"] });

    write(".cline/django-orm.json", JSON.stringify({ mcp: { url: "http://127.0.0.1:8765/mcp" } }));
    const remote = planMcpRegistration(resolveConfig(dir, {}));
    expect(remote.register && remote.server.transport).toEqual({ type: "streamableHttp", url: "http://127.0.0.1:8765/mcp" });

    write(".cline/django-orm.json", JSON.stringify({ mcp: { enabled: false } }));
    expect(planMcpRegistration(resolveConfig(dir, {})).register).toBe(false);
  });

  it("does not register without a Django project", () => {
    const plan = planMcpRegistration(resolveConfig(dir, {}));
    expect(plan).toMatchObject({ register: false });
  });
});

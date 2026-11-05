import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifySql, editedPaths } from "../src/hooks.js";
import { createDjangoOrmPlugin } from "../src/index.js";
import type { AgentTool, McpServerDefinition, PluginCommand, PluginRule } from "../src/sdk-types.js";
import { generateQueryCountTest } from "../src/tools/query-count-test.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "blog-project");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "django-orm-plugin-"));
  cpSync(FIXTURE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup(config?: object) {
  if (config) {
    mkdirSync(join(dir, ".cline"), { recursive: true });
    writeFileSync(join(dir, ".cline", "django-orm.json"), JSON.stringify(config));
  }
  const plugin = createDjangoOrmPlugin({ env: {} });
  const registered = {
    tools: [] as AgentTool<any, any>[],
    rules: [] as PluginRule[],
    commands: [] as PluginCommand[],
    servers: [] as McpServerDefinition[],
  };
  await plugin.setup?.(
    {
      registerTool: (t) => registered.tools.push(t),
      registerRule: (r) => registered.rules.push(r),
      registerCommand: (c) => registered.commands.push(c),
      registerMcpServer: (s) => registered.servers.push(s),
    },
    { cwd: dir, workspaceInfo: { rootPath: dir } },
  );
  const tool = (name: string) => {
    const t = registered.tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t;
  };
  return { plugin, registered, tool };
}

const toolCtx = { agentId: "a", iteration: 0 };

describe("plugin setup", () => {
  it("declares its capabilities and registers MCP server, tools, rules and commands", async () => {
    const { plugin, registered } = await setup();
    expect(plugin.name).toBe("django-orm");
    expect(plugin.manifest.capabilities).toEqual(expect.arrayContaining(["mcp", "tools", "rules", "commands", "hooks"]));
    expect(registered.servers.map((s) => s.name)).toEqual(["django_orm"]);
    expect(registered.servers[0]?.transport).toMatchObject({ type: "stdio", args: ["manage.py", "mcp_serve"], cwd: dir });
    expect(registered.tools.map((t) => t.name).sort()).toEqual([
      "django_env_check",
      "django_model_relations",
      "django_query_count_test",
      "django_scan_n_plus_one",
    ]);
    expect(registered.rules.map((r) => r.id)).toEqual(["django-orm-safety", "django-orm-performance", "django-orm-mcp-tools"]);
    expect(registered.rules[2]?.whenToolAvailable).toBe("django_orm__list_models");
    expect(registered.commands.map((c) => c.name)).toEqual([
      "django-doctor",
      "n-plus-one-audit",
      "optimize-view",
      "explain-queryset",
      "django-schema",
      "index-advisor",
    ]);
    for (const t of registered.tools) expect(t.inputSchema).toMatchObject({ type: "object" });
  });

  it("commands submit prompts that reference the right tools", async () => {
    const { registered } = await setup();
    const audit = registered.commands.find((c) => c.name === "n-plus-one-audit");
    const result = await audit?.handler?.("blog/views.py");
    expect(typeof result === "object" && result.submitPrompt).toContain('paths=["blog/views.py"]');
    expect(typeof result === "object" && result.submitPrompt).toContain("django_orm__profile_url");
  });

  it("safety rule reflects the configuration", async () => {
    const { registered } = await setup();
    const rule = registered.rules.find((r) => r.id === "django-orm-safety");
    const content = typeof rule?.content === "function" ? await rule.content() : rule?.content;
    expect(content).toContain("DISABLED");
  });

  it("scan tool reports the fixture's N+1 and skips migrations", async () => {
    const { tool } = await setup();
    const out: string = await tool("django_scan_n_plus_one").execute({}, toolCtx);
    expect(out).toContain("blog/views.py");
    expect(out).toContain("post.author.name");
    expect(out).toContain("blog/templates/blog/post_list.html");
    expect(out).not.toContain("migrations");
    expect(out).toContain("django_orm__profile_url");
  });

  it("scan tool rejects paths outside the workspace", async () => {
    const { tool } = await setup();
    const out: string = await tool("django_scan_n_plus_one").execute({ paths: ["../../etc"] }, toolCtx);
    expect(out).toContain("Ignored paths outside the workspace: ../../etc");
  });

  it("model relations tool lists relations and loaders", async () => {
    const { tool } = await setup();
    const out: string = await tool("django_model_relations").execute({ model: "post" }, toolCtx);
    expect(out).toContain('author: ForeignKey -> Author | select_related("author") | reverse: Author.posts');
    expect(out).toContain('(reverse) comment_set: from Comment.post | prefetch_related("comment_set")');
    const mermaid: string = await tool("django_model_relations").execute({ format: "mermaid" }, toolCtx);
    expect(mermaid).toContain("Post }o--|| Author : author");
  });

  it("env check tool reports the project even when Python is missing", async () => {
    const { tool } = await setup({ python: "missing/python" });
    const out: string = await tool("django_env_check").execute({}, toolCtx);
    expect(out).toContain("Settings module: config.settings.local (from manage.py)");
    expect(out).toContain("FILE NOT FOUND");
    expect(out).toContain('Registered as "django_orm"');
  });
});

describe("hooks", () => {
  it("forces dry-run on MCP write tools", async () => {
    const { plugin } = await setup();
    const res = await plugin.hooks?.beforeTool?.({
      tool: { name: "django_orm__update_objects" } as AgentTool,
      input: { model: "blog.Post", dry_run: false },
    });
    expect(res?.input).toEqual({ model: "blog.Post", dry_run: true });
  });

  it("blocks code execution tools unless enabled", async () => {
    const { plugin } = await setup();
    const res = await plugin.hooks?.beforeTool?.({ tool: { name: "django_orm__run_queryset" } as AgentTool, input: { code: "1" } });
    expect(res?.skip).toBe(true);

    const enabled = await setup({ safety: { allowCodeExecution: true } });
    expect(await enabled.plugin.hooks?.beforeTool?.({ tool: { name: "django_orm__run_queryset" } as AgentTool, input: {} })).toBeUndefined();
  });

  it("rejects non read-only raw SQL", async () => {
    const { plugin } = await setup();
    const call = (sql: string) => plugin.hooks?.beforeTool?.({ tool: { name: "django_orm__raw_sql" } as AgentTool, input: { sql } });
    expect(await call("SELECT * FROM blog_post")).toBeUndefined();
    expect((await call("DELETE FROM blog_post"))?.skip).toBe(true);
  });

  it("ignores tools of other servers", async () => {
    const { plugin } = await setup();
    expect(await plugin.hooks?.beforeTool?.({ tool: { name: "other__run_queryset" } as AgentTool, input: {} })).toBeUndefined();
  });

  it("scans edited files once and appends new findings only", async () => {
    const { plugin } = await setup();
    const after = (input: unknown, name = "editor") =>
      plugin.hooks?.afterTool?.({ tool: { name } as AgentTool, input, result: { output: "ok" } });
    const first = await after({ path: "blog/views.py", new_text: "" });
    expect(first?.appendContext).toContain("post.author.name");
    expect(await after({ path: "blog/views.py", new_text: "" })).toBeUndefined();

    const patch = "*** Begin Patch\n*** Update File: blog/admin.py\n@@\n*** End Patch";
    expect((await after({ input: patch }, "apply_patch"))?.appendContext).toContain("PostAdmin.author_name");
    expect(await after({ path: "README.md" })).toBeUndefined();
    expect(await after({ path: "/etc/passwd" })).toBeUndefined();
  });

  it("refreshes the model index when models.py is edited", async () => {
    const { plugin, tool } = await setup();
    expect(await tool("django_model_relations").execute({ model: "Review" }, toolCtx)).toContain("not found");
    const models = join(dir, "blog", "models.py");
    writeFileSync(models, `${readFileSync(models, "utf8")}\n\nclass Review(models.Model):\n    post = models.ForeignKey(Post, on_delete=models.CASCADE)\n`);
    await plugin.hooks?.afterTool?.({ tool: { name: "editor" } as AgentTool, input: { path: "blog/models.py" }, result: { output: "" } });
    expect(await tool("django_model_relations").execute({ model: "Review" }, toolCtx)).toContain("## Review");
  });
});

describe("helpers", () => {
  it("classifies SQL conservatively", () => {
    expect(classifySql("select 1;")).toBe("read");
    expect(classifySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("read");
    expect(classifySql("EXPLAIN ANALYZE SELECT * FROM t WHERE name = 'drop table'")).toBe("read");
    expect(classifySql("SELECT 1; DROP TABLE t")).toBe("multiple");
    expect(classifySql("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toBe("write");
    expect(classifySql("SELECT * INTO backup FROM t")).toBe("write");
    expect(classifySql("PRAGMA foreign_keys = OFF")).toBe("write");
    expect(classifySql("UPDATE t SET a = 1")).toBe("write");
  });

  it("extracts edited paths", () => {
    expect(editedPaths("editor", { path: "a.py" })).toEqual(["a.py"]);
    expect(editedPaths("apply_patch", "*** Add File: b.py\n*** Update File: c.py\n*** Move to: d.py\n")).toEqual(["b.py", "c.py", "d.py"]);
    expect(editedPaths("read_files", { path: "a.py" })).toEqual([]);
  });

  it("generates query-count tests", () => {
    const django = generateQueryCountTest({ url: "/api/posts/", maxQueries: 3, login: true });
    expect(django).toContain("with self.assertNumQueries(3):");
    expect(django).toContain('self.client.get("/api/posts/")');
    expect(django).toContain("def test_get_api_posts_query_count(self):");
    const pytest = generateQueryCountTest({ url: "/x/", maxQueries: 1, style: "pytest", method: "post", data: { a: true, b: null } });
    expect(pytest).toContain("with django_assert_num_queries(1):");
    expect(pytest).toContain('client.post("/x/", {"a": True, "b": None}, content_type="application/json")');
  });
});

import { PLUGIN_TOOLS } from "../constants.js";
import type { AgentTool } from "../sdk-types.js";

export interface QueryCountTestInput {
  /** URL path, e.g. "/api/orders/". */
  url: string;
  /** Number of queries the optimized view is expected to run. */
  maxQueries: number;
  method?: "get" | "post" | "put" | "patch" | "delete";
  style?: "django" | "pytest";
  testName?: string;
  /** Log in a freshly created user before the request. */
  login?: boolean;
  /** Request payload (JSON-serializable). */
  data?: Record<string, unknown>;
  /** Number of rows the test should create so an N+1 would show (documentation only). */
  fixtureSize?: number;
}

export function createQueryCountTestTool(): AgentTool<QueryCountTestInput, string> {
  return {
    name: PLUGIN_TOOLS.queryCountTest,
    description:
      "Generate a regression test that pins the number of SQL queries of a Django view (assertNumQueries for " +
      "Django TestCase, django_assert_num_queries for pytest-django). Use it after fixing an N+1 so the fix stays fixed. " +
      "Returns code; write it into the project's tests yourself and adapt the fixtures.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: 'URL path of the view, e.g. "/api/orders/"' },
        maxQueries: { type: "integer", minimum: 0, description: "Expected number of queries after optimization" },
        method: { type: "string", enum: ["get", "post", "put", "patch", "delete"] },
        style: { type: "string", enum: ["django", "pytest"], description: "Default django" },
        testName: { type: "string" },
        login: { type: "boolean" },
        data: { type: "object" },
        fixtureSize: { type: "integer", minimum: 1, description: "Rows to create in fixtures (default 5)" },
      },
      required: ["url", "maxQueries"],
      additionalProperties: false,
    },
    async execute(input) {
      return generateQueryCountTest(input);
    },
  };
}

export function generateQueryCountTest(input: QueryCountTestInput): string {
  const method = input.method ?? "get";
  const name = sanitizeIdentifier(input.testName ?? `test_${method}_${input.url}_query_count`);
  const size = input.fixtureSize ?? 5;
  const url = JSON.stringify(input.url);
  const payload = input.data ? `, ${pyLiteral(input.data)}${method === "get" ? "" : ', content_type="application/json"'}` : "";
  const fixtureComment = `# Create ${size}+ related rows here: with an N+1, the query count grows with them.`;

  if (input.style === "pytest") {
    return [
      "import pytest",
      "",
      "",
      "@pytest.mark.django_db",
      `def ${name}(client, django_assert_num_queries${input.login ? ", django_user_model" : ""}):`,
      `    ${fixtureComment}`,
      ...(input.login
        ? ['    user = django_user_model.objects.create_user(username="perf", password="perf")', "    client.force_login(user)"]
        : []),
      `    with django_assert_num_queries(${input.maxQueries}):`,
      `        response = client.${method}(${url}${payload})`,
      "    assert response.status_code < 400",
      "",
    ].join("\n");
  }

  return [
    "from django.test import TestCase",
    ...(input.login ? ["from django.contrib.auth import get_user_model"] : []),
    "",
    "",
    "class QueryCountTests(TestCase):",
    "    @classmethod",
    "    def setUpTestData(cls):",
    `        ${fixtureComment}`,
    ...(input.login ? ['        cls.user = get_user_model().objects.create_user(username="perf", password="perf")'] : ["        pass"]),
    "",
    `    def ${name}(self):`,
    ...(input.login ? ["        self.client.force_login(self.user)"] : []),
    `        with self.assertNumQueries(${input.maxQueries}):`,
    `            response = self.client.${method}(${url}${payload})`,
    "        self.assertLess(response.status_code, 400)",
    "",
  ].join("\n");
}

function sanitizeIdentifier(value: string): string {
  const id = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/_$/, "").toLowerCase();
  return id.startsWith("test") ? id : `test_${id}`;
}

/** Converts JSON data to a Python literal. */
export function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pyLiteral(v)}`).join(", ")}}`;
  }
  return "None";
}

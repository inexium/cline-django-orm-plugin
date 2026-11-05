/**
 * Local copy of the Cline SDK plugin contract (@cline/sdk 0.2.0).
 *
 * Copied from @cline/shared's `extensions/contribution-registry.d.ts`,
 * `agents/types.d.ts` and `agent.d.ts`. The published 0.2.0 declarations do
 * not type-check (@cline/agents imports names that @cline/shared does not
 * export), so importing them yields `any`. Keeping the subset we use here also
 * means the plugin has no runtime dependency and loads in Cline's plugin
 * worker without node_modules. Re-check against the SDK when upgrading.
 */

// --- Tools -----------------------------------------------------------------

export interface AgentToolContext {
  sessionId?: string;
  agentId: string;
  conversationId?: string;
  runId?: string;
  iteration: number;
  toolCallId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  emitUpdate?: (update: unknown) => void;
  /** Session working directory. Set by the host for plugin tools. */
  cwd?: string;
  emitEvent?: (name: string, payload?: unknown) => void;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** JSON Schema of the input. */
  inputSchema: Record<string, unknown>;
  resultPolicy?: "cache-oversized";
  lifecycle?: { completesRun?: boolean };
  successContext?: string;
  executionMode?: "sequential" | "parallel";
  timeoutMs?: number;
  retryable?: boolean;
  maxRetries?: number;
  execute: (input: TInput, context: AgentToolContext) => Promise<TOutput> | TOutput;
}

export interface AgentToolResult<TOutput = unknown> {
  output: TOutput;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

// --- Hooks (subset of AgentRuntimeHooks) -----------------------------------

export interface ToolCallPart {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface BeforeToolContext {
  snapshot?: unknown;
  tool: AgentTool;
  toolCall?: ToolCallPart;
  input: unknown;
}

export interface BeforeToolResult {
  skip?: boolean;
  stop?: boolean;
  reason?: string;
  input?: unknown;
  /** Appended as a <hook_context> user message after this iteration's tool results. */
  appendContext?: string;
}

export interface AfterToolContext {
  snapshot?: unknown;
  tool: AgentTool;
  toolCall?: ToolCallPart;
  input: unknown;
  result: AgentToolResult;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
}

export interface AfterToolResult {
  stop?: boolean;
  reason?: string;
  result?: AgentToolResult;
  appendContext?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface PluginHooks {
  beforeTool?: (context: BeforeToolContext) => MaybePromise<BeforeToolResult | undefined>;
  afterTool?: (context: AfterToolContext) => MaybePromise<AfterToolResult | undefined>;
}

// --- Contributions ---------------------------------------------------------

export interface McpStdioTransport {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpHttpTransport {
  type: "sse" | "streamableHttp";
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerDefinition {
  name: string;
  transport: McpStdioTransport | McpHttpTransport;
  env?: Record<string, string | { fromEnv?: string; value?: string; required?: boolean }>;
  metadata?: Record<string, unknown>;
}

export interface PluginRule {
  id: string;
  content: string | (() => string | Promise<string>);
  source?: string;
  /** Include the rule only while the named tool is available. */
  whenToolAvailable?: string;
}

export type PluginCommandResult = string | { reply?: string; submitPrompt?: string };

export interface PluginCommand {
  name: string;
  description?: string;
  handler?: (input: string) => PluginCommandResult | Promise<PluginCommandResult>;
}

export interface PluginApi {
  registerTool: (tool: AgentTool<any, any>) => void;
  registerCommand: (command: PluginCommand) => void;
  registerRule: (rule: PluginRule) => void;
  registerMcpServer: (server: McpServerDefinition) => void;
}

// --- Plugin ----------------------------------------------------------------

export interface Logger {
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

export interface PluginContext {
  session?: { sessionId?: string };
  client?: unknown;
  workspaceInfo?: { rootPath?: string; [key: string]: unknown };
  logger?: Logger;
  /** The session's working directory (use instead of process.cwd()). */
  cwd?: string;
  onDispose?: (cleanup: () => void | Promise<void>) => void;
}

export type PluginCapability = "hooks" | "tools" | "commands" | "rules" | "skills" | "messageBuilders" | "providers" | "automationEvents" | "mcp";

export interface AgentPlugin {
  name: string;
  manifest: { capabilities: PluginCapability[]; paths?: string[]; providerIds?: string[]; modelIds?: string[] };
  hooks?: PluginHooks;
  setup?: (api: PluginApi, ctx: PluginContext) => void | Promise<void>;
}

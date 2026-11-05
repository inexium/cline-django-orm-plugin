import type { ResolvedConfig } from "./config.js";
import type { McpRegistrationPlan } from "./mcp.js";
import type { RelationIndex } from "./analysis/models-parser.js";
import { loadRelationIndex } from "./analysis/workspace.js";
import type { Logger } from "./sdk-types.js";

/** Per-session state shared by tools, hooks, rules and commands. */
export class PluginState {
  private relations?: RelationIndex;

  constructor(
    readonly config: ResolvedConfig,
    readonly mcpPlan: McpRegistrationPlan,
    readonly logger: Logger = {},
  ) {}

  get walkOptions(): { excludeDirs: readonly string[]; maxFiles: number } {
    return { excludeDirs: this.config.analysis.excludeDirs, maxFiles: this.config.analysis.maxFiles };
  }

  get mcpAvailable(): boolean {
    return this.mcpPlan.register;
  }

  /** Relation index built from models.py files, cached until a models file changes. */
  getRelations(): RelationIndex {
    if (!this.relations) {
      const root = this.config.projectRoot ?? this.config.workspaceRoot;
      this.relations = loadRelationIndex(root, this.walkOptions);
      this.logger.debug?.(`django-orm: indexed ${this.relations.models.length} model(s)`);
    }
    return this.relations;
  }

  invalidateRelations(): void {
    this.relations = undefined;
  }
}

import { z } from "zod";

export const AgentEcosystemSchema = z.enum([
  "agents-hub",
  "claude",
  "claude-workspace",
  "agents-workspace",
  "codex",
  "codex-system",
  "opencode",
  "pi-agent",
  "pi",
  "openclaw",
  "continue",
  "trae",
  "custom",
]);

export type AgentEcosystem = z.infer<typeof AgentEcosystemSchema>;

export interface AgentMountRoot {
  agent: AgentEcosystem;
  label: string;
  path: string;
  scope: "global" | "workspace";
  canToggleMount?: boolean;
  primaryToggle?: boolean;
  sharedViaAgentsHub?: boolean;
}

export interface LockProvenance {
  source: string;
  sourceType: string;
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
  installedAt?: string;
  updatedAt?: string;
}

export interface AgentMount {
  agent: AgentEcosystem;
  label?: string;
  mountPath: string;
  targetPath?: string;
  isSymlink: boolean;
  status: "mounted" | "standalone" | "broken_symlink" | "auto_hub";
  suggestedRepairPath?: string;
  skillName?: string;
}

export const FormFieldTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "select",
  "multi-select",
  "file",
  "directory",
  "env-secret",
  "key-value",
  "code",
  "date",
]);

export type FormFieldType = z.infer<typeof FormFieldTypeSchema>;

export const FormFieldOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  meta: z.string().optional(),
});

export type FormFieldOption = z.infer<typeof FormFieldOptionSchema>;

export const FormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: FormFieldTypeSchema,
  flag: z.string().optional(),
  positional: z.boolean().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
  options: z.array(FormFieldOptionSchema).optional(),
  fromData: z.string().optional(),
  valueColumn: z.string().optional(),
  labelColumn: z.string().optional(),
  metaColumn: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  envVar: z.string().optional(),
  when: z
    .object({
      field: z.string(),
      equals: z.union([z.string(), z.boolean(), z.number()]),
    })
    .optional(),
});

export type FormField = z.infer<typeof FormFieldSchema>;

export const SkillEnvVarSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  secret: z.boolean().optional(),
});

export type SkillEnvVar = z.infer<typeof SkillEnvVarSchema>;

export const ContextFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["select", "toggle", "text"]).default("select"),
  default: z.union([z.string(), z.boolean()]).optional(),
  options: z.array(FormFieldOptionSchema).optional(),
  fromData: z.string().optional(),
  valueColumn: z.string().optional(),
  labelColumn: z.string().optional(),
  description: z.string().optional(),
});

export type ContextField = z.infer<typeof ContextFieldSchema>;

export const DataParserFormatSchema = z.enum([
  "auto",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "whitespace-table",
  "regex",
  "kv",
  "lines",
  "raw",
]);

export type DataParserFormat = z.infer<typeof DataParserFormatSchema>;

export const DataParserSchema = z.object({
  format: DataParserFormatSchema.default("auto"),
  path: z.string().optional(),
  pattern: z.string().optional(),
  delimiter: z.string().optional(),
});

export type DataParser = z.infer<typeof DataParserSchema>;

export const DataTransformSchema = z.object({
  runtime: z.enum(["ts", "python"]).default("ts"),
  prelude: z.boolean().default(false).optional(),
  code: z.string(),
});

export type DataTransform = z.infer<typeof DataTransformSchema>;

export const DataShapeSchema = z.enum([
  "scalar",
  "kv",
  "list",
  "table",
  "matrix",
  "tree",
  "stream",
  "raw",
]);

export type DataShape = z.infer<typeof DataShapeSchema>;

export const TableColumnTypeSchema = z.enum([
  "text",
  "code",
  "badge",
  "bytes",
  "datetime",
  "progress",
  "boolean",
  "number",
]);

export type TableColumnType = z.infer<typeof TableColumnTypeSchema>;

export const TableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: TableColumnTypeSchema.default("text"),
  toneMap: z.record(z.string(), z.enum(["neutral", "info", "success", "warn", "danger"])).optional(),
  width: z.string().optional(),
});

export type TableColumn = z.infer<typeof TableColumnSchema>;

export const BoundActionTriggerSchema = z.object({
  label: z.string(),
  actionId: z.string(),
  mode: z.enum(["run", "prefill"]).default("run"),
  args: z.record(z.string(), z.unknown()).optional(),
});

export type BoundActionTrigger = z.infer<typeof BoundActionTriggerSchema>;

export const DataSyncSchema = z.object({
  onMount: z.boolean().default(true),
  ttlMs: z.number().default(15000),
  dependsOn: z.array(z.string()).optional(),
  watchFiles: z.array(z.string()).optional(),
  invalidateOnActions: z.array(z.string()).optional(),
  pollMs: z.number().optional(),
  stream: z.boolean().optional(),
});

export type DataSync = z.infer<typeof DataSyncSchema>;

export const DataRuntimeSchema = z.enum([
  "zsh",
  "ts",
  "python",
  "sqlite",
  "glob",
  "file",
  "passive",
]);

export type DataRuntime = z.infer<typeof DataRuntimeSchema>;

export const DataNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  intermediate: z.boolean().optional(),
  hidden: z.boolean().optional(),
  runtime: DataRuntimeSchema.default("zsh"),
  prelude: z.boolean().default(false).optional(),
  command: z.string().optional(),
  script: z.string().optional(),
  code: z.string().optional(),
  entry: z.string().optional(),
  db: z.string().optional(),
  sql: z.string().optional(),
  pattern: z.union([z.string(), z.array(z.string())]).optional(),
  valueFormat: z.enum(["basename", "relative", "abspath"]).default("basename").optional(),
  filePath: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().default(15000).optional(),
  parse: DataParserSchema.optional(),
  transform: DataTransformSchema.optional(),
  shape: DataShapeSchema.default("raw"),
  primaryKey: z.string().optional(),
  valueColumn: z.string().optional(),
  labelColumn: z.string().optional(),
  metaColumn: z.string().optional(),
  columns: z.array(TableColumnSchema).optional(),
  pivot: z
    .object({
      rowKey: z.string(),
      colKey: z.string(),
      valueKey: z.string(),
    })
    .optional(),
  quickActions: z.array(BoundActionTriggerSchema).optional(),
  rowActions: z.array(BoundActionTriggerSchema).optional(),
  bulkActions: z.array(BoundActionTriggerSchema).optional(),
  cellAction: BoundActionTriggerSchema.optional(),
  sync: DataSyncSchema.optional(),
});

export type DataNode = z.infer<typeof DataNodeSchema>;

export const ActionOutputSchema = z.object({
  intoData: z.string().optional(),
  parse: DataParserSchema.optional(),
  transform: DataTransformSchema.optional(),
  shape: DataShapeSchema.optional(),
});

export type ActionOutput = z.infer<typeof ActionOutputSchema>;

export const ArtifactKindSchema = z.enum(["html", "file", "json", "image", "markdown"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactOnCompleteSchema = z.enum(["badge", "open", "download"]);
export type ArtifactOnComplete = z.infer<typeof ArtifactOnCompleteSchema>;

export const ArtifactRuleObjectSchema = z.object({
  path: z.string().optional(),
  fromStdout: z.string().optional(),
  label: z.string().optional(),
  kind: ArtifactKindSchema.optional(),
  onComplete: ArtifactOnCompleteSchema.default("badge").optional(),
});

export type ArtifactRuleObject = z.infer<typeof ArtifactRuleObjectSchema>;

export const ArtifactRuleSchema = z.union([z.string(), ArtifactRuleObjectSchema]);
export type ArtifactRule = z.infer<typeof ArtifactRuleSchema>;

export interface RunArtifact {
  label: string;
  path: string;
  filename: string;
  kind: ArtifactKind;
  sizeBytes: number;
  onComplete: ArtifactOnComplete;
}

export const ActionItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    subgroup: z.string().optional(),
    description: z.string().optional(),
    danger: z.enum(["safe", "warn", "danger"]).default("safe"),
    requiresHumanApprovalFlag: z.string().optional(),
    interactive: z.boolean().optional(),
    defaultRunner: z
      .enum(["web_terminal", "external_terminal", "copy_command", "copy_agent_prompt"])
      .default("web_terminal"),
    cwd: z.string().optional(),
    command: z.string().optional(),
    script: z.string().optional(),
    form: z.array(FormFieldSchema).optional(),
    artifacts: z.array(ArtifactRuleSchema).optional(),
    output: ActionOutputSchema.optional(),
  })
  .transform((val) => ({
    ...val,
    command: val.script || val.command || "",
  }));

export interface ActionItem {
  id: z.infer<typeof ActionItemSchema>["id"];
  title: string;
  subgroup?: string;
  description?: string;
  danger: "safe" | "warn" | "danger";
  requiresHumanApprovalFlag?: string;
  interactive?: boolean;
  defaultRunner: "web_terminal" | "external_terminal" | "copy_command" | "copy_agent_prompt";
  cwd?: string;
  command: string;
  script?: string;
  form?: FormField[];
  artifacts?: ArtifactRule[];
  output?: ActionOutput;
}

export interface ActionGroup {
  name: string;
  description?: string;
  subgroups?: ActionGroup[];
  actions: ActionItem[];
}

export const ActionGroupSchema: z.ZodType<ActionGroup, z.ZodTypeDef, any> = z.lazy(() =>
  z.object({
    name: z.string(),
    description: z.string().optional(),
    subgroups: z.array(ActionGroupSchema).optional(),
    actions: z.array(ActionItemSchema).default([]),
  })
);

export const SkillViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["markdown", "html", "image", "file"]).default("markdown"),
  source: z.string(),
});

export type SkillView = z.infer<typeof SkillViewSchema>;

export const SkillManifestSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  banner: z.string().optional(),
  defaultWorkspace: z.string().optional(),
  tsPrelude: z.boolean().default(false).optional(),
  includes: z.array(z.string()).optional(),
  defs: z.record(z.string(), z.any()).optional(),
  envVars: z.array(SkillEnvVarSchema).optional(),
  context: z.array(ContextFieldSchema).optional(),
  data: z.array(DataNodeSchema).optional(),
  tags: z.array(z.string()).optional(),
  defaultPrompt: z.string().optional(),
  views: z.array(SkillViewSchema).optional(),
  actionGroups: z.array(ActionGroupSchema).optional(),
});

export type PartialSkillManifest = z.infer<typeof SkillManifestSchema>;

export interface SkillManifest {
  id: string;
  name: string;
  category: string;
  description: string;
  icon?: string;
  banner?: string;
  defaultWorkspace?: string;
  tsPrelude?: boolean;
  includes?: string[];
  defs?: Record<string, any>;
  envVars: SkillEnvVar[];
  context: ContextField[];
  data: DataNode[];
  tags: string[];
  defaultPrompt?: string;
  views: SkillView[];
  actionGroups: ActionGroup[];
}

export interface ScalarPayload {
  value: string | number | boolean;
  unit?: string;
  label?: string;
  tone?: "neutral" | "info" | "success" | "warn" | "danger";
}

export interface KvEntry {
  key: string;
  label: string;
  value: string | number | boolean;
  tone?: "neutral" | "info" | "success" | "warn" | "danger";
}

export interface KvPayload {
  entries: KvEntry[];
  record: Record<string, unknown>;
}

export interface ListItem {
  value: string;
  label: string;
  meta?: string;
  raw?: unknown;
}

export interface ListPayload {
  items: ListItem[];
}

export interface TablePayload {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
  primaryKey?: string;
}

export interface MatrixPayload {
  rowKeys: string[];
  colKeys: string[];
  cells: Record<string, Record<string, unknown>>;
}

export interface RawPayload {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DataSnapshot {
  nodeId: string;
  title: string;
  description?: string;
  category?: string;
  intermediate?: boolean;
  rawParsed?: unknown;
  consumedBy?: string[];
  shape: DataShape;
  runtime: DataRuntime;
  status: "idle" | "loading" | "streaming" | "ready" | "error";
  value: ScalarPayload | KvPayload | ListPayload | TablePayload | MatrixPayload | RawPayload | any;
  options: FormFieldOption[];
  quickActions?: BoundActionTrigger[];
  rowActions?: BoundActionTrigger[];
  bulkActions?: BoundActionTrigger[];
  cellAction?: BoundActionTrigger;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  updatedAt: number;
  fromCache: boolean;
  error?: string;
}

export interface ManifestSymbolProvenance {
  moduleFiles: string[];
  defs: Record<string, string>;
  context: Record<string, string>;
  data: Record<string, string>;
  actions: Record<string, { file: string; group: string }>;
  views: Record<string, string>;
  contextSource: Record<string, string>;
  dataSource: Record<string, string>;
  actionSource: Record<string, string>;
  viewSource: Record<string, string>;
}

export interface ConfigLayerStatus {
  zeroConfig: boolean;
  companion: boolean;
  companionPath: string;
  moduleFiles?: string[];
  provenance?: ManifestSymbolProvenance;
  globalOverride: boolean;
  globalOverridePath: string;
  workspaceOverride: boolean;
  workspaceOverridePath: string;
}

export type SkillUpdateStrategy = "npx-lock" | "git" | "local";

export type UnitKind = "skill" | "workspace" | "scratchpad";

export type UnconfiguredFolderAction = "ask" | "agent" | "skeleton" | "raw";

export interface ManagedFolderEntry {
  path: string;
  label?: string;
  addedAt: string;
}

export interface DashboardConfig {
  server?: {
    port?: number;
    defaultWorkspace?: string;
  };
  preferences: {
    unconfiguredFolderAction: UnconfiguredFolderAction;
    scratchpadTtlDays: number;
  };
  managedFolders: ManagedFolderEntry[];
  watchRoots: string[];
}

export interface UnitEvent {
  id: number;
  unitId: string;
  eventType: "run_completed" | "decision_submitted";
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CanonicalSkill {
  id: string;
  unitKind?: UnitKind;
  hasManifest?: boolean;
  projectSlug?: string;
  canonicalPath: string;
  inAgentsHub: boolean;
  updateStrategy: SkillUpdateStrategy;
  effectiveWorkspace: string;
  pythonExecutable: string;
  configuredEnv: Record<string, string>;
  mounts: AgentMount[];
  provenance?: LockProvenance;
  hasOpenAiYaml: boolean;
  layers: ConfigLayerStatus;
  manifest: SkillManifest;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface ExecutionRun {
  id: string;
  skillId: string;
  actionId: string;
  actionTitle: string;
  status: RunStatus;
  command: string;
  maskedCommand: string;
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  paramsJson: string;
  logPath: string;
  artifacts: Array<string | RunArtifact>;
  artifactItems?: RunArtifact[];
  interactive: boolean;
}

export interface FileTreeNode {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  depth?: number;
  size?: number;
  extension?: string;
  children?: FileTreeNode[];
}

export interface AgentFixTarget {
  kind: "action-group" | "action" | "data-node" | "context" | "view" | "manifest";
  id: string;
  title: string;
  provenanceFile?: string;
  snippet?: unknown;
}

export interface AgentManifestSyncRequest {
  agentCli?: "claude" | "codex";
  userInstruction?: string;
  targets?: AgentFixTarget[];
  targetLayer?: "auto" | "companion" | "global_override" | "workspace_override";
  previewOnly?: boolean;
}

export interface DashboardServerOptions {
  port?: number;
  hostname?: string;
  homeDir?: string;
  defaultWorkspace?: string;
  candidateWorkspaces?: string[];
  configDir?: string;
  dataDir?: string;
  cacheDir?: string;
  agentRoots?: AgentMountRoot[];
  lockfiles?: string[];
}

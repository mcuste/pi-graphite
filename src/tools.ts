import { type Static, type TSchema, Type } from "typebox";
import {
  assertBranchMissing,
  hasSafeBranchSyntax,
  type ParsedBranchName,
  type ParsedExistingBranchName,
  parseBranchName,
  parseExistingBranchName,
} from "./branch.js";
import {
  type GraphiteCapability,
  GraphiteCapabilityResolver,
  GraphiteUnavailableError,
} from "./capability.js";
import {
  CommandCancelledError,
  CommandInvocationError,
  type CommandResult,
  type CommandRunner,
  runChecked,
  runCommand,
} from "./process.js";

const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 20_000;

const ExistingBranchName = Type.String({
  minLength: 1,
  maxLength: 255,
  description: "Exact local branch name. Leading options are rejected.",
});

const NewBranchName = Type.String({
  minLength: 1,
  maxLength: 255,
  description:
    "Requested Graphite branch name. Graphite may add the user's configured branch prefix.",
});

const CommitSubject = Type.String({
  minLength: 1,
  maxLength: MAX_SUBJECT_LENGTH,
  description: "Single-line commit subject.",
});

const CommitBody = Type.String({
  minLength: 1,
  maxLength: MAX_BODY_LENGTH,
  description: "Commit body.",
});

const GraphiteParameters = Type.Union([
  Type.Object(
    {
      operation: Type.Literal("inspect"),
      target: Type.Union(
        [
          Type.Literal("stack"),
          Type.Literal("stack_short"),
          Type.Literal("state"),
          Type.Literal("parent"),
          Type.Literal("children"),
          Type.Literal("trunk"),
          Type.Literal("info"),
        ],
        {
          description:
            "stack and stack_short draw the tracked stack, state reports it as JSON, parent, children, trunk, and info describe the current branch.",
        },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("checkout"),
      branch: ExistingBranchName,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("create"),
      name: NewBranchName,
      subject: CommitSubject,
      body: CommitBody,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("modify_commit"),
      subject: CommitSubject,
      body: CommitBody,
    },
    { additionalProperties: false },
  ),
  Type.Object({ operation: Type.Literal("modify_amend") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("squash"),
      subject: CommitSubject,
      body: CommitBody,
    },
    { additionalProperties: false },
  ),
  Type.Object({ operation: Type.Literal("fold") }, { additionalProperties: false }),
  Type.Object(
    { operation: Type.Literal("rename"), name: NewBranchName },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("move"),
      source: ExistingBranchName,
      onto: ExistingBranchName,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("restack"), branch: ExistingBranchName },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("delete"), branch: ExistingBranchName },
    { additionalProperties: false },
  ),
  Type.Object({ operation: Type.Literal("continue") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("abort") }, { additionalProperties: false }),
]);

declare const messageTextBrand: unique symbol;

type ParsedMessageText = string & { readonly [messageTextBrand]: true };

interface ParsedCommitMessage {
  readonly subject: ParsedMessageText;
  readonly body: ParsedMessageText;
}

type ParsedGraphiteOperation =
  | { readonly operation: "inspect"; readonly target: InspectTarget }
  | { readonly operation: "checkout"; readonly branch: ParsedExistingBranchName }
  | {
      readonly operation: "create";
      readonly name: ParsedBranchName;
      readonly message: ParsedCommitMessage;
    }
  | {
      readonly operation: "modify_commit";
      readonly message: ParsedCommitMessage;
    }
  | { readonly operation: "modify_amend" }
  | { readonly operation: "squash"; readonly message: ParsedCommitMessage }
  | { readonly operation: "fold" }
  | { readonly operation: "rename"; readonly name: ParsedBranchName }
  | {
      readonly operation: "move";
      readonly source: ParsedExistingBranchName;
      readonly onto: ParsedExistingBranchName;
    }
  | { readonly operation: "restack"; readonly branch: ParsedExistingBranchName }
  | { readonly operation: "delete"; readonly branch: ParsedExistingBranchName }
  | { readonly operation: "continue" }
  | { readonly operation: "abort" };

type GraphiteParameters = Static<typeof GraphiteParameters>;
type GraphiteOperation = GraphiteParameters["operation"];
type InspectTarget = Extract<GraphiteParameters, { operation: "inspect" }>["target"];
type MutationOperation = Exclude<GraphiteOperation, "inspect">;

/**
 * The complete Graphite vocabulary this extension can spawn. Everything the tool passes
 * to `gt` is either one of these fixed tokens or a value that was parsed first.
 */
const GRAPHITE_SUBCOMMANDS = [
  "log",
  "state",
  "parent",
  "children",
  "trunk",
  "info",
  "checkout",
  "create",
  "modify",
  "squash",
  "fold",
  "rename",
  "move",
  "restack",
  "delete",
  "continue",
  "abort",
] as const;

const GRAPHITE_KEYWORDS = ["short"] as const;

const GRAPHITE_SWITCHES = ["--no-interactive", "--stack", "--commit", "--force"] as const;

const GRAPHITE_BRANCH_OPTIONS = ["--source", "--onto", "--branch"] as const;

const MESSAGE_OPTION_PREFIX = "--message=";

type GraphiteToken =
  | (typeof GRAPHITE_SUBCOMMANDS)[number]
  | (typeof GRAPHITE_KEYWORDS)[number]
  | (typeof GRAPHITE_SWITCHES)[number];

declare const graphiteValueBrand: unique symbol;

/** A `--flag=value` argument built from an already parsed value. */
type GraphiteValueArgument = string & { readonly [graphiteValueBrand]: true };

type GraphiteArgument = GraphiteToken | ParsedBranchName | GraphiteValueArgument;

const subcommands: ReadonlySet<string> = new Set(GRAPHITE_SUBCOMMANDS);
const switches: ReadonlySet<string> = new Set(GRAPHITE_SWITCHES);
const branchOptions: ReadonlySet<string> = new Set(GRAPHITE_BRANCH_OPTIONS);

function messageOption(text: ParsedMessageText): GraphiteValueArgument {
  return `${MESSAGE_OPTION_PREFIX}${text}` as GraphiteValueArgument;
}

function branchOption(
  flag: (typeof GRAPHITE_BRANCH_OPTIONS)[number],
  branch: ParsedBranchName,
): GraphiteValueArgument {
  return `${flag}=${branch}` as GraphiteValueArgument;
}

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

interface ToolResult<TDetails> {
  readonly content: readonly TextContent[];
  readonly details: TDetails;
}

interface ToolContext {
  readonly cwd: string;
  readonly ui?: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

type ToolTier = "read" | "write" | "exec";

type ToolApprovalDecision =
  | ToolTier
  | {
      readonly tier: ToolTier;
      readonly reason?: string;
      readonly policy?: "allow" | "deny" | "prompt";
    };

interface ToolDefinition<TParameters extends TSchema, TDetails> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly approval: ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);
  readonly loadMode: "essential" | "discoverable";
  readonly concurrency?:
    | "shared"
    | "exclusive"
    | ((args: Partial<Static<TParameters>>) => "shared" | "exclusive");
  readonly executionMode?: "sequential" | "parallel";
  readonly formatApprovalDetails?: (args: unknown) => string | readonly string[] | undefined;
  execute(
    toolCallId: string,
    parameters: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ): Promise<ToolResult<TDetails>>;
}

export interface GraphiteExtensionApi {
  registerTool<TParameters extends TSchema, TDetails>(
    definition: ToolDefinition<TParameters, TDetails>,
  ): void;
}

interface CommandDetails {
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CapabilityDetails {
  readonly repositoryRoot: string;
  readonly trunk: string;
  readonly gtVersion: string;
  readonly cache: GraphiteCapability["cache"];
  readonly cacheWarning?: string;
}

interface InspectDetails {
  readonly operation: "inspect";
  readonly target: InspectTarget;
  readonly capability: CapabilityDetails;
  readonly command: CommandDetails;
}

interface WorkingTreeState {
  readonly status: string;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly stack: string;
}

/** A worktree with a branch checked out. */
interface AttachedWorkingTree extends WorkingTreeState {
  readonly branch: string;
}

/** A worktree with a detached HEAD, which is how a halted Graphite rebase looks. */
interface DetachedWorkingTree extends WorkingTreeState {
  readonly branch: null;
}

type WorkingTreeSnapshot = AttachedWorkingTree | DetachedWorkingTree;

interface MutationDetails {
  readonly operation: MutationOperation;
  readonly capability: CapabilityDetails;
  readonly before: WorkingTreeSnapshot;
  readonly command: CommandDetails;
  readonly after: WorkingTreeSnapshot;
}

type GraphiteToolDetails = InspectDetails | MutationDetails;

export interface GraphiteExtensionDependencies {
  readonly runner?: CommandRunner;
  readonly capabilities?: GraphiteCapabilityResolver;
}
const repositoryQueues = new Map<string, Promise<void>>();

function commandDetails(result: CommandResult): CommandDetails {
  return {
    executable: result.command,
    args: result.args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function capabilityDetails(capability: GraphiteCapability): CapabilityDetails {
  return {
    repositoryRoot: capability.repository.root,
    trunk: capability.trunk,
    gtVersion: capability.gtVersion,
    cache: capability.cache,
    ...(capability.cacheWarning ? { cacheWarning: capability.cacheWarning } : {}),
  };
}

function successfulResult<TDetails>(
  label: string,
  result: CommandResult,
  details: TDetails,
  cacheWarning?: string,
): ToolResult<TDetails> {
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  const warning = cacheWarning ? `\n\n${cacheWarning}` : "";
  return {
    content: [
      {
        type: "text",
        text: `${output || `${label} completed successfully.`}${warning}`,
      },
    ],
    details,
  };
}

async function withRepositoryLock<T>(
  repositoryRoot: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = repositoryQueues.get(repositoryRoot) ?? Promise.resolve();
  const { promise: releasePromise, resolve: release } = Promise.withResolvers<void>();
  const queueTail = predecessor.then(() => releasePromise);
  repositoryQueues.set(repositoryRoot, queueTail);

  await predecessor;
  try {
    if (signal?.aborted) {
      throw new CommandCancelledError("Graphite operation");
    }
    return await operation();
  } finally {
    release();
    if (repositoryQueues.get(repositoryRoot) === queueTail) {
      repositoryQueues.delete(repositoryRoot);
    }
  }
}

function parseCommitMessage(subject: unknown, body: unknown): ParsedCommitMessage {
  if (
    typeof subject !== "string" ||
    subject.length > MAX_SUBJECT_LENGTH ||
    !subject.trim() ||
    subject.includes("\0")
  ) {
    throw new Error(
      `subject must contain non-whitespace text, contain no NUL characters, and be at most ${MAX_SUBJECT_LENGTH} characters.`,
    );
  }
  if (/[\n\r]/u.test(subject)) {
    throw new Error("subject must be a single line. Put the remaining text in body.");
  }
  if (
    typeof body !== "string" ||
    body.length > MAX_BODY_LENGTH ||
    !body.trim() ||
    body.includes("\0")
  ) {
    throw new Error(
      `body must contain non-whitespace text, contain no NUL characters, and be at most ${MAX_BODY_LENGTH} characters.`,
    );
  }
  return { subject: subject as ParsedMessageText, body: body as ParsedMessageText };
}

function parseOperationFrom(args: unknown): GraphiteOperation | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  switch (Reflect.get(args, "operation")) {
    case "inspect":
      return "inspect";
    case "checkout":
      return "checkout";
    case "create":
      return "create";
    case "modify_commit":
      return "modify_commit";
    case "modify_amend":
      return "modify_amend";
    case "squash":
      return "squash";
    case "fold":
      return "fold";
    case "rename":
      return "rename";
    case "move":
      return "move";
    case "restack":
      return "restack";
    case "delete":
      return "delete";
    case "continue":
      return "continue";
    case "abort":
      return "abort";
    default:
      return undefined;
  }
}

function assertExactFields(
  value: unknown,
  operation: GraphiteOperation,
  expectedFields: readonly string[],
): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Operation ${operation} requires an object request.`);
  }
  const actualFields = Object.keys(value);
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field) => !expectedFields.includes(field))
  ) {
    throw new Error(
      `Operation ${operation} accepts exactly these fields: ${expectedFields.join(", ")}.`,
    );
  }
}

function parseInspectTarget(value: unknown): InspectTarget {
  switch (value) {
    case "stack":
    case "stack_short":
    case "state":
    case "parent":
    case "children":
    case "trunk":
    case "info":
      return value;
    default:
      throw new Error(`Invalid Graphite inspection target: ${JSON.stringify(value)}.`);
  }
}

async function parseGraphiteOperation(
  parameters: unknown,
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ParsedGraphiteOperation> {
  const operation = parseOperationFrom(parameters);
  if (!operation) {
    throw new Error("Unknown Graphite operation.");
  }

  switch (operation) {
    case "inspect": {
      assertExactFields(parameters, operation, ["operation", "target"]);
      return { operation, target: parseInspectTarget(Reflect.get(parameters, "target")) };
    }
    case "checkout":
      assertExactFields(parameters, operation, ["operation", "branch"]);
      return {
        operation,
        branch: await parseExistingBranchName(
          runner,
          Reflect.get(parameters, "branch"),
          "branch",
          cwd,
          signal,
        ),
      };
    case "create": {
      assertExactFields(parameters, operation, ["operation", "name", "subject", "body"]);
      const message = parseCommitMessage(
        Reflect.get(parameters, "subject"),
        Reflect.get(parameters, "body"),
      );
      return {
        operation,
        name: await parseBranchName(runner, Reflect.get(parameters, "name"), "name", cwd, signal),
        message,
      };
    }
    case "modify_commit":
    case "squash":
      assertExactFields(parameters, operation, ["operation", "subject", "body"]);
      return {
        operation,
        message: parseCommitMessage(
          Reflect.get(parameters, "subject"),
          Reflect.get(parameters, "body"),
        ),
      };
    case "rename":
      assertExactFields(parameters, operation, ["operation", "name"]);
      return {
        operation,
        name: await parseBranchName(runner, Reflect.get(parameters, "name"), "name", cwd, signal),
      };
    case "modify_amend":
    case "fold":
      assertExactFields(parameters, operation, ["operation"]);
      return { operation };
    case "move": {
      assertExactFields(parameters, operation, ["operation", "source", "onto"]);
      const [source, onto] = await Promise.all([
        parseExistingBranchName(runner, Reflect.get(parameters, "source"), "source", cwd, signal),
        parseExistingBranchName(runner, Reflect.get(parameters, "onto"), "onto", cwd, signal),
      ]);
      if (source === onto) {
        throw new Error("source and onto must name different local branches.");
      }
      return { operation, source, onto };
    }
    case "restack":
    case "delete":
      assertExactFields(parameters, operation, ["operation", "branch"]);
      return {
        operation,
        branch: await parseExistingBranchName(
          runner,
          Reflect.get(parameters, "branch"),
          "branch",
          cwd,
          signal,
        ),
      };
    case "continue":
    case "abort":
      assertExactFields(parameters, operation, ["operation"]);
      return { operation };
  }
}

function approvalFor(args: unknown): ToolApprovalDecision {
  const operation = parseOperationFrom(args);
  if (operation === "inspect") {
    return "read";
  }
  if (operation === "abort") {
    return {
      tier: "exec",
      policy: "prompt",
      reason: "Graphite abort requires --force after an active rebase is verified.",
    };
  }
  if (operation === "delete") {
    return {
      tier: "exec",
      policy: "prompt",
      reason: "Graphite delete uses --force and permanently removes a local branch.",
    };
  }
  if (operation) {
    return "exec";
  }
  return {
    tier: "exec",
    policy: "deny",
    reason: "Unknown Graphite operation.",
  };
}

function concurrencyFor(args: Partial<GraphiteParameters>): "shared" | "exclusive" {
  return parseOperationFrom(args) === "inspect" ? "shared" : "exclusive";
}

function approvalDetails(args: unknown): readonly string[] | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const operation = parseOperationFrom(args);
  switch (operation) {
    case "inspect":
      return [`Operation: inspect ${String(Reflect.get(args, "target"))}`];
    case "checkout":
      return [`Operation: checkout ${String(Reflect.get(args, "branch"))}`];
    case "create":
      return [`Operation: create ${String(Reflect.get(args, "name"))}`];
    case "rename":
      return [`Operation: rename to ${String(Reflect.get(args, "name"))}`];
    case "move":
      return [
        `Operation: move ${String(Reflect.get(args, "source"))}`,
        `New parent: ${String(Reflect.get(args, "onto"))}`,
      ];
    case "restack":
      return [`Operation: restack ${String(Reflect.get(args, "branch"))}`];
    case "delete":
      return [`Operation: delete ${String(Reflect.get(args, "branch"))}`];
    default:
      return operation ? [`Operation: ${operation.replaceAll("_", " ")}`] : undefined;
  }
}

/**
 * Last line of defense before spawning `gt`: every argument must be a fixed token or a
 * `--flag=value` pair built from a parsed value, so caller text can never become an option.
 */
function assertFixedGraphiteArguments(args: readonly GraphiteArgument[]): void {
  const subcommand = args[0];
  if (!subcommand || !subcommands.has(subcommand)) {
    throw new Error(`Refusing to run an unknown Graphite subcommand: ${JSON.stringify(args[0])}.`);
  }
  for (const argument of args) {
    if (typeof argument !== "string" || !argument || argument.includes("\0")) {
      throw new Error(`Refusing to pass an unsafe Graphite argument: ${JSON.stringify(argument)}.`);
    }
    if (!argument.startsWith("-") || switches.has(argument)) {
      continue;
    }
    if (argument.startsWith(MESSAGE_OPTION_PREFIX)) {
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? "" : argument.slice(separator + 1);
    if (!branchOptions.has(flag) || !hasSafeBranchSyntax(value)) {
      throw new Error(`Refusing to pass ${JSON.stringify(argument)} to Graphite as an option.`);
    }
  }
}

async function inspectStack(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
  allowFailure: boolean,
): Promise<string> {
  const args = ["log", "--stack", "--no-interactive"] as const;
  if (!allowFailure) {
    const result = await runChecked(
      runner,
      "gt",
      args,
      { cwd, signal },
      "Unable to inspect the Graphite stack",
    );
    return result.stdout.trimEnd();
  }

  try {
    const result = await runner("gt", args, { cwd, signal });
    if (result.exitCode === 0) {
      return result.stdout.trimEnd();
    }
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    return `[stack unavailable during conflict: ${detail}]`;
  } catch (error) {
    if (error instanceof CommandCancelledError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return `[stack unavailable during conflict: ${detail}]`;
  }
}

async function inspectWorkingTree(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
  allowStackFailure = false,
): Promise<WorkingTreeSnapshot> {
  const options = { cwd, signal };
  const [branch, status, stagedDiff, unstagedDiff, stack] = await Promise.all([
    runChecked(
      runner,
      "git",
      ["branch", "--show-current"],
      options,
      "Unable to read the current branch",
    ),
    runChecked(runner, "git", ["status", "--short"], options, "Unable to read Git status"),
    runChecked(
      runner,
      "git",
      ["diff", "--cached", "--stat"],
      options,
      "Unable to inspect staged changes",
    ),
    runChecked(runner, "git", ["diff", "--stat"], options, "Unable to inspect unstaged changes"),
    inspectStack(runner, cwd, signal, allowStackFailure),
  ]);

  const state: WorkingTreeState = {
    status: status.stdout.trimEnd(),
    stagedDiff: stagedDiff.stdout.trimEnd(),
    unstagedDiff: unstagedDiff.stdout.trimEnd(),
    stack,
  };
  const current = branch.stdout.trim();
  return current ? { ...state, branch: current } : { ...state, branch: null };
}

function parseAttachedWorkingTree(
  snapshot: WorkingTreeSnapshot,
  message: string,
): AttachedWorkingTree {
  if (snapshot.branch === null) {
    throw new Error(message);
  }
  return snapshot;
}

async function runGraphiteCommand(
  runner: CommandRunner,
  capabilities: GraphiteCapabilityResolver,
  capability: GraphiteCapability,
  args: readonly GraphiteArgument[],
  signal: AbortSignal | undefined,
  failureContext: string,
): Promise<CommandResult> {
  assertFixedGraphiteArguments(args);
  try {
    return await runChecked(
      runner,
      "gt",
      args,
      { cwd: capability.repository.root, signal },
      failureContext,
    );
  } catch (error) {
    if (error instanceof CommandInvocationError) {
      capabilities.forget(capability.repository.root);
      throw new GraphiteUnavailableError(
        "The cached repository is Graphite-enabled, but the `gt` executable could not be started.",
        { cause: error },
      );
    }
    throw error;
  }
}

type CommitVerificationMode = "new_branch" | "new_commit" | "amend";

interface CommitExpectation {
  readonly expectedTree: string;
  readonly head: string;
  readonly parent: string | undefined;
  readonly unstagedPatch: string;
  readonly untrackedPaths: string;
}

interface MutationVerification<TPrepared> {
  readonly before: WorkingTreeSnapshot;
  readonly after: AttachedWorkingTree;
  readonly prepared: TPrepared;
}

/**
 * `allowDetachedBefore` decides what `prepare` receives: only conflict recovery runs with a
 * detached HEAD, so every other operation gets a snapshot whose branch is known.
 */
interface MutationOptions<TPrepared, TDetached extends boolean = false> {
  readonly requireCleanWorktree?: boolean;
  readonly requireStagedChanges?: boolean;
  readonly requireBranchOffTrunk?: boolean;
  readonly allowStackFailureBefore?: boolean;
  readonly allowDetachedBefore?: TDetached;
  readonly commitVerification?: CommitVerificationMode;
  readonly preserveBranch?: boolean;
  readonly preserveWorkingTree?: boolean;
  readonly confirmation?: () => Promise<void>;
  readonly prepare?: (
    before: TDetached extends true ? WorkingTreeSnapshot : AttachedWorkingTree,
  ) => Promise<TPrepared>;
  readonly verify?: (verification: MutationVerification<TPrepared>) => Promise<void>;
}

async function checkedOutput(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  failureContext: string,
): Promise<string> {
  const result = await runChecked(runner, command, args, { cwd, signal }, failureContext);
  return result.stdout.trimEnd();
}

async function captureCommitExpectation(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
  mode: CommitVerificationMode,
): Promise<CommitExpectation> {
  const options = { cwd, signal };
  const [tree, head, unstagedPatch, untrackedPaths] = await Promise.all([
    runChecked(runner, "git", ["write-tree"], options, "Unable to snapshot the staged tree"),
    runChecked(runner, "git", ["rev-parse", "HEAD"], options, "Unable to read HEAD"),
    runChecked(runner, "git", ["diff", "--binary"], options, "Unable to snapshot unstaged changes"),
    runChecked(
      runner,
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options,
      "Unable to snapshot untracked paths",
    ),
  ]);
  const parent =
    mode === "amend"
      ? await checkedOutput(
          runner,
          "git",
          ["rev-parse", "HEAD^"],
          cwd,
          signal,
          "Unable to read the amended commit parent",
        )
      : undefined;

  return {
    expectedTree: tree.stdout.trim(),
    head: head.stdout.trim(),
    parent,
    unstagedPatch: unstagedPatch.stdout,
    untrackedPaths: untrackedPaths.stdout,
  };
}

async function verifyCommitMutation(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
  mode: CommitVerificationMode,
  expectation: CommitExpectation,
  before: WorkingTreeSnapshot,
  after: WorkingTreeSnapshot,
): Promise<void> {
  const options = { cwd, signal };
  const [head, tree, parent, unstagedPatch, untrackedPaths] = await Promise.all([
    runChecked(runner, "git", ["rev-parse", "HEAD"], options, "Unable to verify HEAD"),
    runChecked(
      runner,
      "git",
      ["rev-parse", "HEAD^{tree}"],
      options,
      "Unable to verify the committed tree",
    ),
    runChecked(
      runner,
      "git",
      ["rev-parse", "HEAD^"],
      options,
      "Unable to verify the commit parent",
    ),
    runChecked(runner, "git", ["diff", "--binary"], options, "Unable to verify unstaged changes"),
    runChecked(
      runner,
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options,
      "Unable to verify untracked paths",
    ),
  ]);

  if (tree.stdout.trim() !== expectation.expectedTree) {
    throw new Error("Graphite committed a tree that differs from the staged snapshot.");
  }
  if (unstagedPatch.stdout !== expectation.unstagedPatch) {
    throw new Error("Graphite changed unstaged tracked content unexpectedly.");
  }
  if (untrackedPaths.stdout !== expectation.untrackedPaths) {
    throw new Error("Graphite changed the untracked path set unexpectedly.");
  }
  if (after.stagedDiff) {
    throw new Error("Graphite left staged changes after reporting commit success.");
  }

  const resultingHead = head.stdout.trim();
  const resultingParent = parent.stdout.trim();
  if (resultingHead === expectation.head) {
    throw new Error("Graphite reported success without changing HEAD.");
  }
  if (mode === "amend") {
    if (resultingParent !== expectation.parent || after.branch !== before.branch) {
      throw new Error("Graphite amend changed the branch or commit parent unexpectedly.");
    }
    return;
  }
  if (resultingParent !== expectation.head) {
    throw new Error("Graphite created a commit on an unexpected parent.");
  }
  if (mode === "new_branch" && after.branch === before.branch) {
    throw new Error("Graphite create did not switch to a new branch.");
  }
  if (mode === "new_commit" && after.branch !== before.branch) {
    throw new Error("Graphite modify switched branches unexpectedly.");
  }
}

async function assertRebaseInProgress(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const symbolicHead = await runner("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, signal });
  if (symbolicHead.exitCode === 0) {
    throw new Error("No rebase conflict is available for Graphite recovery.");
  }
  await runChecked(
    runner,
    "git",
    ["rev-parse", "--verify", "REBASE_HEAD"],
    { cwd, signal },
    "No rebase conflict is available for Graphite recovery",
  );
}

async function assertConflictsResolved(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const unmerged = await checkedOutput(
    runner,
    "git",
    ["diff", "--name-only", "--diff-filter=U"],
    cwd,
    signal,
    "Unable to inspect unresolved conflicts",
  );
  if (unmerged) {
    throw new Error(`Resolve and stage these conflicts before continuing:\n${unmerged}`);
  }
}

async function assertRebaseFinished(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await runChecked(
    runner,
    "git",
    ["symbolic-ref", "--quiet", "HEAD"],
    { cwd, signal },
    "Graphite reported success but the repository is still detached",
  );
}

function headTree(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return checkedOutput(
    runner,
    "git",
    ["rev-parse", "HEAD^{tree}"],
    cwd,
    signal,
    "Unable to read the branch tree",
  );
}

function headCommit(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return checkedOutput(runner, "git", ["rev-parse", "HEAD"], cwd, signal, "Unable to read HEAD");
}

async function graphiteParentBranch(
  runner: CommandRunner,
  capabilities: GraphiteCapabilityResolver,
  capability: GraphiteCapability,
  signal: AbortSignal | undefined,
): Promise<ParsedExistingBranchName> {
  const result = await runGraphiteCommand(
    runner,
    capabilities,
    capability,
    ["parent", "--no-interactive"],
    signal,
    "Unable to read the parent branch",
  );
  return parseExistingBranchName(
    runner,
    result.stdout.trim(),
    "parent",
    capability.repository.root,
    signal,
  );
}

async function runMutation<TPrepared = undefined, TDetached extends boolean = false>(
  runner: CommandRunner,
  capabilities: GraphiteCapabilityResolver,
  capability: GraphiteCapability,
  operation: MutationOperation,
  args: readonly GraphiteArgument[],
  signal: AbortSignal | undefined,
  options: MutationOptions<TPrepared, TDetached> = {},
): Promise<ToolResult<MutationDetails>> {
  const label = operation.replaceAll("_", " ");
  return withRepositoryLock(capability.repository.root, signal, async () => {
    const cwd = capability.repository.root;
    const snapshot = await inspectWorkingTree(runner, cwd, signal, options.allowStackFailureBefore);
    const before = options.allowDetachedBefore
      ? snapshot
      : parseAttachedWorkingTree(snapshot, `${operation} requires an attached local branch.`);
    if (options.requireBranchOffTrunk && before.branch === capability.trunk) {
      throw new Error(
        `${operation} cannot run on the trunk branch ${JSON.stringify(capability.trunk)}.`,
      );
    }
    if (options.requireCleanWorktree && before.status) {
      throw new Error(
        `${operation} requires a clean worktree. Commit or stash these changes first:\n${before.status}`,
      );
    }
    if (options.requireStagedChanges && !before.stagedDiff) {
      throw new Error(`${operation} requires deliberately staged changes.`);
    }
    // `before` already satisfies the checkout requirement the options describe.
    const prepared = (await options.prepare?.(
      before as TDetached extends true ? WorkingTreeSnapshot : AttachedWorkingTree,
    )) as TPrepared;
    await options.confirmation?.();

    const expectation = options.commitVerification
      ? await captureCommitExpectation(runner, cwd, signal, options.commitVerification)
      : undefined;
    const command = await runGraphiteCommand(
      runner,
      capabilities,
      capability,
      args,
      signal,
      `Graphite ${label} failed`,
    );

    let after: AttachedWorkingTree;
    try {
      after = parseAttachedWorkingTree(
        await inspectWorkingTree(runner, cwd, signal),
        "Graphite reported success but left the repository detached.",
      );
      if (options.requireCleanWorktree && after.status) {
        throw new Error(`Graphite ${operation} left the worktree dirty:\n${after.status}`);
      }
      if (options.preserveBranch && after.branch !== before.branch) {
        throw new Error(`Graphite ${operation} changed the current branch unexpectedly.`);
      }
      if (
        options.preserveWorkingTree &&
        (after.status !== before.status ||
          after.stagedDiff !== before.stagedDiff ||
          after.unstagedDiff !== before.unstagedDiff)
      ) {
        throw new Error(`Graphite ${operation} changed the worktree unexpectedly.`);
      }
      if (options.commitVerification && expectation) {
        await verifyCommitMutation(
          runner,
          cwd,
          signal,
          options.commitVerification,
          expectation,
          before,
          after,
        );
      }
      await options.verify?.({ before, after, prepared });
    } catch (error) {
      throw new Error(
        `Graphite ${label} completed, but post-operation verification failed. The operation may already have changed the repository; inspect it before retrying.`,
        { cause: error },
      );
    }

    const details: MutationDetails = {
      operation,
      capability: capabilityDetails(capability),
      before,
      command: commandDetails(command),
      after,
    };
    return successfulResult(`Graphite ${label}`, command, details, capability.cacheWarning);
  });
}

const inspectionArguments: Record<InspectTarget, readonly GraphiteArgument[]> = {
  stack: ["log", "--stack", "--no-interactive"],
  stack_short: ["log", "short", "--no-interactive"],
  state: ["state", "--no-interactive"],
  parent: ["parent", "--no-interactive"],
  children: ["children", "--no-interactive"],
  trunk: ["trunk", "--no-interactive"],
  info: ["info", "--no-interactive"],
};

async function runInspection(
  runner: CommandRunner,
  capabilities: GraphiteCapabilityResolver,
  capability: GraphiteCapability,
  target: InspectTarget,
  signal: AbortSignal | undefined,
): Promise<ToolResult<InspectDetails>> {
  return withRepositoryLock(capability.repository.root, signal, async () => {
    const result = await runGraphiteCommand(
      runner,
      capabilities,
      capability,
      inspectionArguments[target],
      signal,
      `Graphite ${target} inspection failed`,
    );
    const details: InspectDetails = {
      operation: "inspect",
      target,
      capability: capabilityDetails(capability),
      command: commandDetails(result),
    };
    return successfulResult(
      `Graphite ${target} inspection`,
      result,
      details,
      capability.cacheWarning,
    );
  });
}

/** Graphite may prepend the user's configured branch prefix to a requested name. */
function isRequestedBranch(actual: string, requested: ParsedBranchName): boolean {
  return actual === requested || actual.endsWith(`/${requested}`);
}

export function registerGraphiteTools(
  pi: GraphiteExtensionApi,
  dependencies: GraphiteExtensionDependencies = {},
): void {
  const runner = dependencies.runner ?? runCommand;
  const capabilities = dependencies.capabilities ?? new GraphiteCapabilityResolver(runner);

  pi.registerTool<typeof GraphiteParameters, GraphiteToolDetails>({
    name: "graphite",
    label: "Graphite",
    description:
      "Run deterministic Graphite operations for stack inspection, explicit checkout, local stack changes, branch cleanup, and conflict recovery.",
    parameters: GraphiteParameters,
    approval: approvalFor,
    formatApprovalDetails: approvalDetails,
    loadMode: "discoverable",
    concurrency: concurrencyFor,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const capability = await capabilities.ensure(context.cwd, signal);
      const cwd = capability.repository.root;
      const operation = await parseGraphiteOperation(parameters, runner, cwd, signal);

      switch (operation.operation) {
        case "inspect":
          return runInspection(runner, capabilities, capability, operation.target, signal);
        case "checkout":
          return runMutation(
            runner,
            capabilities,
            capability,
            "checkout",
            ["checkout", operation.branch, "--no-interactive"],
            signal,
            {
              requireCleanWorktree: true,
              verify: async ({ after }) => {
                if (after.branch !== operation.branch) {
                  throw new Error(
                    `Graphite checked out ${JSON.stringify(after.branch)} instead of ${JSON.stringify(operation.branch)}.`,
                  );
                }
              },
            },
          );
        case "create":
          return runMutation(
            runner,
            capabilities,
            capability,
            "create",
            [
              "create",
              operation.name,
              messageOption(operation.message.subject),
              messageOption(operation.message.body),
              "--no-interactive",
            ],
            signal,
            { requireStagedChanges: true, commitVerification: "new_branch" },
          );
        case "modify_commit":
          return runMutation(
            runner,
            capabilities,
            capability,
            "modify_commit",
            [
              "modify",
              "--commit",
              messageOption(operation.message.subject),
              messageOption(operation.message.body),
              "--no-interactive",
            ],
            signal,
            { requireStagedChanges: true, commitVerification: "new_commit" },
          );
        case "modify_amend":
          return runMutation(
            runner,
            capabilities,
            capability,
            "modify_amend",
            ["modify", "--no-interactive"],
            signal,
            { requireStagedChanges: true, commitVerification: "amend" },
          );
        case "squash":
          return runMutation(
            runner,
            capabilities,
            capability,
            "squash",
            [
              "squash",
              messageOption(operation.message.subject),
              messageOption(operation.message.body),
              "--no-interactive",
            ],
            signal,
            {
              requireCleanWorktree: true,
              requireBranchOffTrunk: true,
              preserveBranch: true,
              prepare: async () => ({
                tree: await headTree(runner, cwd, signal),
                parent: await graphiteParentBranch(runner, capabilities, capability, signal),
              }),
              verify: async ({ prepared }) => {
                if ((await headTree(runner, cwd, signal)) !== prepared.tree) {
                  throw new Error("Graphite squash changed the branch content.");
                }
                const commits = await checkedOutput(
                  runner,
                  "git",
                  ["rev-list", "--count", `${prepared.parent}..HEAD`],
                  cwd,
                  signal,
                  "Unable to count the squashed commits",
                );
                if (commits !== "1") {
                  throw new Error(
                    `Graphite squash left ${commits} commits above ${JSON.stringify(prepared.parent)}.`,
                  );
                }
              },
            },
          );
        case "fold":
          return runMutation(
            runner,
            capabilities,
            capability,
            "fold",
            ["fold", "--no-interactive"],
            signal,
            {
              requireCleanWorktree: true,
              requireBranchOffTrunk: true,
              prepare: async (before) => {
                const parent = await graphiteParentBranch(runner, capabilities, capability, signal);
                if (parent === capability.trunk) {
                  throw new Error(
                    `fold cannot fold ${JSON.stringify(before.branch)} into the trunk branch ${JSON.stringify(capability.trunk)}.`,
                  );
                }
                return {
                  parent,
                  folded: before.branch,
                  tree: await headTree(runner, cwd, signal),
                };
              },
              verify: async ({ after, prepared }) => {
                if (after.branch !== prepared.parent) {
                  throw new Error(
                    `Graphite fold left ${JSON.stringify(after.branch)} checked out instead of ${JSON.stringify(prepared.parent)}.`,
                  );
                }
                if ((await headTree(runner, cwd, signal)) !== prepared.tree) {
                  throw new Error("Graphite fold changed the combined branch content.");
                }
                await assertBranchMissing(
                  runner,
                  prepared.folded,
                  "The folded branch",
                  cwd,
                  signal,
                );
              },
            },
          );
        case "rename":
          return runMutation(
            runner,
            capabilities,
            capability,
            "rename",
            ["rename", operation.name, "--no-interactive"],
            signal,
            {
              requireBranchOffTrunk: true,
              preserveWorkingTree: true,
              prepare: async (before) => ({
                previous: before.branch,
                head: await headCommit(runner, cwd, signal),
              }),
              verify: async ({ after, prepared }) => {
                if (!isRequestedBranch(after.branch, operation.name)) {
                  throw new Error(
                    `Graphite renamed the branch to ${JSON.stringify(after.branch)} instead of ${JSON.stringify(operation.name)}.`,
                  );
                }
                if ((await headCommit(runner, cwd, signal)) !== prepared.head) {
                  throw new Error("Graphite rename changed the branch commit.");
                }
                await assertBranchMissing(
                  runner,
                  prepared.previous,
                  "The renamed branch",
                  cwd,
                  signal,
                );
              },
            },
          );
        case "move":
          return runMutation(
            runner,
            capabilities,
            capability,
            "move",
            [
              "move",
              branchOption("--source", operation.source),
              branchOption("--onto", operation.onto),
              "--no-interactive",
            ],
            signal,
            {
              requireCleanWorktree: true,
              preserveBranch: true,
              verify: async () => {
                await runChecked(
                  runner,
                  "git",
                  ["merge-base", "--is-ancestor", operation.onto, operation.source],
                  { cwd, signal },
                  "Moved branch is not based on the requested parent",
                );
              },
            },
          );
        case "restack":
          return runMutation(
            runner,
            capabilities,
            capability,
            "restack",
            ["restack", branchOption("--branch", operation.branch), "--no-interactive"],
            signal,
            { requireCleanWorktree: true, preserveBranch: true },
          );
        case "delete":
          return runMutation(
            runner,
            capabilities,
            capability,
            "delete",
            ["delete", operation.branch, "--force", "--no-interactive"],
            signal,
            {
              requireCleanWorktree: true,
              preserveBranch: true,
              prepare: async (before) => {
                if (operation.branch === capability.trunk) {
                  throw new Error(
                    `delete cannot remove the trunk branch ${JSON.stringify(capability.trunk)}.`,
                  );
                }
                if (operation.branch === before.branch) {
                  throw new Error(
                    `delete cannot remove ${JSON.stringify(operation.branch)} while it is checked out. Check out another branch first.`,
                  );
                }
              },
              confirmation: async () => {
                const confirmed = await context.ui?.confirm(
                  `Delete Graphite branch ${operation.branch}?`,
                  "This runs `gt delete --force`, which removes the local branch and its Graphite metadata even when it is unmerged.",
                );
                if (!confirmed) {
                  throw new Error("Graphite delete requires explicit user confirmation.");
                }
              },
              verify: async () => {
                await assertBranchMissing(
                  runner,
                  operation.branch,
                  "The deleted branch",
                  cwd,
                  signal,
                );
              },
            },
          );
        case "continue":
          return runMutation(
            runner,
            capabilities,
            capability,
            "continue",
            ["continue", "--no-interactive"],
            signal,
            {
              allowStackFailureBefore: true,
              allowDetachedBefore: true,
              prepare: async () => {
                await assertRebaseInProgress(runner, cwd, signal);
                await assertConflictsResolved(runner, cwd, signal);
              },
              verify: async () => assertRebaseFinished(runner, cwd, signal),
            },
          );
        case "abort":
          return runMutation(
            runner,
            capabilities,
            capability,
            "abort",
            ["abort", "--force", "--no-interactive"],
            signal,
            {
              allowStackFailureBefore: true,
              allowDetachedBefore: true,
              prepare: async () => assertRebaseInProgress(runner, cwd, signal),
              confirmation: async () => {
                const confirmed = await context.ui?.confirm(
                  "Abort Graphite rebase?",
                  "This runs `gt abort --force` after verifying an active Graphite rebase.",
                );
                if (!confirmed) {
                  throw new Error("Graphite abort requires explicit user confirmation.");
                }
              },
              verify: async () => assertRebaseFinished(runner, cwd, signal),
            },
          );
      }
    },
  });
}

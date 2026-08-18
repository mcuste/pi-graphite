import { type Static, type TSchema, Type } from "typebox";
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

const ExistingBranchName = Type.String({
  minLength: 1,
  maxLength: 255,
  description: "Exact local branch name. Leading option characters are rejected.",
});

const NewBranchName = Type.String({
  minLength: 1,
  maxLength: 255,
  description:
    "Requested Graphite branch name. Graphite may add the user's configured branch prefix.",
});

const InspectParameters = Type.Object(
  {
    operation: Type.Union([Type.Literal("stack"), Type.Literal("parent"), Type.Literal("trunk")], {
      description: "Graphite state to inspect.",
    }),
  },
  { additionalProperties: false },
);

const RestackParameters = Type.Object(
  { branch: ExistingBranchName },
  { additionalProperties: false },
);

const CreateParameters = Type.Object(
  {
    name: NewBranchName,
    subject: Type.String({
      minLength: 1,
      maxLength: 500,
      description: "Commit subject for the new branch.",
    }),
    body: Type.String({
      minLength: 1,
      maxLength: 20_000,
      description: "Commit body for the new branch.",
    }),
  },
  { additionalProperties: false },
);

const MoveParameters = Type.Object(
  {
    source: ExistingBranchName,
    onto: ExistingBranchName,
  },
  { additionalProperties: false },
);

type InspectParameters = Static<typeof InspectParameters>;

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
}

interface ToolDefinition<TParameters extends TSchema, TDetails> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly approval: "read" | "write" | "exec";
  readonly loadMode: "essential" | "discoverable";
  readonly executionMode?: "sequential" | "parallel";
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
  readonly operation: InspectParameters["operation"];
  readonly capability: CapabilityDetails;
  readonly command: CommandDetails;
}

interface WorkingTreeSnapshot {
  readonly branch: string;
  readonly status: string;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly stack: string;
}

interface MutationDetails {
  readonly operation: "restack" | "create" | "move";
  readonly capability: CapabilityDetails;
  readonly before: WorkingTreeSnapshot;
  readonly command: CommandDetails;
  readonly after: WorkingTreeSnapshot;
}

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

async function validateBranchName(
  runner: CommandRunner,
  branch: string,
  label: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (branch !== branch.trim() || branch.startsWith("-") || branch.includes("\0")) {
    throw new Error(`${label} is not a safe branch name: ${JSON.stringify(branch)}.`);
  }

  try {
    await runChecked(
      runner,
      "git",
      ["check-ref-format", "--branch", branch],
      { cwd, signal },
      `${label} is not a valid Git branch name`,
    );
  } catch (error) {
    if (error instanceof CommandCancelledError) {
      throw error;
    }
    throw new Error(`${label} is not a valid Git branch name: ${JSON.stringify(branch)}.`, {
      cause: error,
    });
  }
}

function validateCommitMessage(subject: string, body: string): void {
  if (!subject.trim() || subject.includes("\0")) {
    throw new Error("subject must contain non-whitespace text and no NUL characters.");
  }
  if (!body.trim() || body.includes("\0")) {
    throw new Error("body must contain non-whitespace text and no NUL characters.");
  }
}

async function inspectWorkingTree(
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
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
    runChecked(
      runner,
      "gt",
      ["log", "--stack", "--no-interactive"],
      options,
      "Unable to inspect the Graphite stack",
    ),
  ]);

  return {
    branch: branch.stdout.trim(),
    status: status.stdout.trimEnd(),
    stagedDiff: stagedDiff.stdout.trimEnd(),
    unstagedDiff: unstagedDiff.stdout.trimEnd(),
    stack: stack.stdout.trimEnd(),
  };
}

async function runGraphiteCommand(
  runner: CommandRunner,
  capabilities: GraphiteCapabilityResolver,
  capability: GraphiteCapability,
  args: readonly string[],
  signal: AbortSignal | undefined,
  failureContext: string,
): Promise<CommandResult> {
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

async function runMutation(
  runner: CommandRunner,
  capabilities: GraphiteCapabilityResolver,
  capability: GraphiteCapability,
  operation: MutationDetails["operation"],
  args: readonly string[],
  signal: AbortSignal | undefined,
  requireCleanWorktree: boolean,
): Promise<ToolResult<MutationDetails>> {
  return withRepositoryLock(capability.repository.root, signal, async () => {
    const before = await inspectWorkingTree(runner, capability.repository.root, signal);
    if (requireCleanWorktree && before.status) {
      throw new Error(
        `${operation} requires a clean worktree. Commit or stash these changes first:\n${before.status}`,
      );
    }

    const command = await runGraphiteCommand(
      runner,
      capabilities,
      capability,
      args,
      signal,
      `Graphite ${operation} failed`,
    );

    let after: WorkingTreeSnapshot;
    try {
      after = await inspectWorkingTree(runner, capability.repository.root, signal);
    } catch (error) {
      throw new Error(
        `Graphite ${operation} completed, but post-operation stack verification failed. Inspect the repository before retrying.`,
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
    return successfulResult(`Graphite ${operation}`, command, details, capability.cacheWarning);
  });
}

export function registerGraphiteTools(
  pi: GraphiteExtensionApi,
  dependencies: GraphiteExtensionDependencies = {},
): void {
  const runner = dependencies.runner ?? runCommand;
  const capabilities = dependencies.capabilities ?? new GraphiteCapabilityResolver(runner);

  pi.registerTool({
    name: "graphite_inspect",
    label: "Graphite Inspect",
    description:
      "Inspect the current Graphite stack, direct parent, or trunk using a fixed read-only Graphite command.",
    approval: "read",
    loadMode: "discoverable",
    executionMode: "parallel",
    parameters: InspectParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const capability = await capabilities.ensure(context.cwd, signal);
      const argsByOperation: Record<InspectParameters["operation"], readonly string[]> = {
        stack: ["log", "--stack", "--no-interactive"],
        parent: ["parent", "--no-interactive"],
        trunk: ["trunk", "--no-interactive"],
      };

      return withRepositoryLock(capability.repository.root, signal, async () => {
        const args = argsByOperation[parameters.operation];
        const result = await runGraphiteCommand(
          runner,
          capabilities,
          capability,
          args,
          signal,
          `Graphite ${parameters.operation} inspection failed`,
        );
        const details: InspectDetails = {
          operation: parameters.operation,
          capability: capabilityDetails(capability),
          command: commandDetails(result),
        };
        return successfulResult(
          `Graphite ${parameters.operation} inspection`,
          result,
          details,
          capability.cacheWarning,
        );
      });
    },
  });

  pi.registerTool({
    name: "graphite_restack",
    label: "Graphite Restack",
    description:
      "Restack one branch and its descendants locally. Requires a clean worktree and never submits remote changes.",
    approval: "exec",
    loadMode: "discoverable",
    executionMode: "sequential",
    parameters: RestackParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const capability = await capabilities.ensure(context.cwd, signal);
      await validateBranchName(
        runner,
        parameters.branch,
        "branch",
        capability.repository.root,
        signal,
      );
      return runMutation(
        runner,
        capabilities,
        capability,
        "restack",
        ["restack", "--branch", parameters.branch, "--no-interactive"],
        signal,
        true,
      );
    },
  });

  pi.registerTool({
    name: "graphite_create",
    label: "Graphite Create",
    description:
      "Create a child branch and commit only already-staged changes. Unstaged and untracked changes remain uncommitted.",
    approval: "exec",
    loadMode: "discoverable",
    executionMode: "sequential",
    parameters: CreateParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const capability = await capabilities.ensure(context.cwd, signal);
      await validateBranchName(runner, parameters.name, "name", capability.repository.root, signal);
      validateCommitMessage(parameters.subject, parameters.body);
      return runMutation(
        runner,
        capabilities,
        capability,
        "create",
        [
          "create",
          parameters.name,
          "-m",
          parameters.subject,
          "-m",
          parameters.body,
          "--no-interactive",
        ],
        signal,
        false,
      );
    },
  });

  pi.registerTool({
    name: "graphite_move",
    label: "Graphite Move",
    description:
      "Move a branch onto an explicit parent and restack its descendants. Requires a clean worktree.",
    approval: "exec",
    loadMode: "discoverable",
    executionMode: "sequential",
    parameters: MoveParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const capability = await capabilities.ensure(context.cwd, signal);
      await Promise.all([
        validateBranchName(runner, parameters.source, "source", capability.repository.root, signal),
        validateBranchName(runner, parameters.onto, "onto", capability.repository.root, signal),
      ]);
      return runMutation(
        runner,
        capabilities,
        capability,
        "move",
        ["move", "--source", parameters.source, "--onto", parameters.onto, "--no-interactive"],
        signal,
        true,
      );
    },
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { CommandCancelledError, CommandInvocationError } from "../dist/process.js";
import { registerGraphiteTools } from "../dist/tools.js";

const repositoryRoot = "/virtual/repository";
const capability = {
  repository: {
    root: repositoryRoot,
    gitDir: `${repositoryRoot}/.git`,
    cachePath: `${repositoryRoot}/.git/pi-graphite.json`,
  },
  gtVersion: "1.8.6",
  trunk: "main",
  cache: "persistent",
};

function registerWith(runner, forget = () => {}) {
  const tools = new Map();
  const capabilities = {
    async ensure() {
      return capability;
    },
    forget,
  };
  registerGraphiteTools(
    {
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    },
    { runner, capabilities },
  );
  return tools;
}

const READ_SUBCOMMANDS = new Set(["log", "parent", "children", "trunk", "info", "state"]);

function mutatedWith(calls, subcommand) {
  return calls.some(([command, operation]) => command === "gt" && operation === subcommand);
}

function mutated(calls) {
  return calls.some(([command, operation]) => command === "gt" && !READ_SUBCOMMANDS.has(operation));
}

function createRunner({
  status = "",
  staged = true,
  rebase = false,
  unresolved = "",
  postStatusFailure = false,
  stackFailure = "",
  mergeBaseFailure = false,
  branchPrefix = "",
  commitsAboveParent = "1",
  stagedAfterMutation = false,
  branchAfter = "",
  headAfter = "",
  parentAfter = "",
  treeAfter = "",
  unstagedPatchAfter = "",
  untrackedAfter = "",
} = {}) {
  const calls = [];
  let mutationCompleted = false;
  let stagingConsumed = false;
  let currentBranch = "current";
  let currentHead = "head-before";
  let currentParent = "parent-before";
  let rebaseInProgress = rebase;
  const missingBranches = new Set();
  const stagedTree = "tree-staged";

  const runner = async (command, args) => {
    calls.push([command, ...args]);
    // `gt log` fails until the mutation runs, the way it does while a rebase is halted.
    if (stackFailure && !mutationCompleted && command === "gt" && args[0] === "log") {
      if (stackFailure === "throw") {
        throw new Error("gt log crashed");
      }
      return {
        command,
        args,
        exitCode: 1,
        stdout: "",
        stderr: "gt log is unavailable during a rebase",
      };
    }
    let exitCode = 0;
    let stdout = "";
    let stderr = "";

    if (command === "git") {
      switch (args[0]) {
        case "branch":
          stdout = rebaseInProgress ? "" : `${currentBranch}\n`;
          break;
        case "status":
          if (postStatusFailure && mutationCompleted) {
            exitCode = 1;
            stderr = "status failed";
          } else {
            stdout = status;
          }
          break;
        case "diff":
          if (args.includes("--diff-filter=U")) {
            stdout = unresolved;
          } else if (args.includes("--cached")) {
            stdout = staged && !stagingConsumed ? "staged summary\n" : "";
          } else if (args.includes("--binary")) {
            stdout =
              mutationCompleted && unstagedPatchAfter ? unstagedPatchAfter : "unstaged patch\n";
          } else {
            stdout = "unstaged summary\n";
          }
          break;
        case "check-ref-format":
          stdout = `${args.at(-1)}\n`;
          break;
        case "show-ref":
          if (missingBranches.has(String(args.at(-1)).replace("refs/heads/", ""))) {
            exitCode = 1;
            stderr = "missing ref";
          }
          break;
        case "write-tree":
          stdout = `${stagedTree}\n`;
          break;
        case "ls-files":
          stdout = mutationCompleted && untrackedAfter ? untrackedAfter : "untracked.txt\0";
          break;
        case "merge-base":
          if (mergeBaseFailure) {
            exitCode = 1;
            stderr = "merge-base failed";
          }
          break;
        case "rev-list":
          stdout = `${commitsAboveParent}\n`;
          break;
        case "symbolic-ref":
          if (rebaseInProgress) exitCode = 1;
          else stdout = `refs/heads/${currentBranch}\n`;
          break;
        case "rev-parse":
          if (args.at(-1) === "REBASE_HEAD") {
            if (rebaseInProgress) stdout = "rebase-head\n";
            else exitCode = 1;
          } else if (args.at(-1) === "HEAD^{tree}") {
            stdout = `${mutationCompleted && treeAfter ? treeAfter : stagedTree}\n`;
          } else if (args.at(-1) === "HEAD^") {
            stdout = `${currentParent}\n`;
          } else {
            stdout = `${currentHead}\n`;
          }
          break;
      }
    }

    if (command === "gt") {
      const operation = args[0];
      if (operation === "log") stdout = args[1] === "short" ? "short stack\n" : "stack output\n";
      else if (operation === "parent") stdout = "parent-branch\n";
      else if (operation === "children") stdout = "child-branch\n";
      else if (operation === "trunk") stdout = "main\n";
      else if (operation === "state") stdout = '{"main":{"trunk":true}}\n';
      else if (operation === "info") stdout = "branch info\n";
      else {
        mutationCompleted = true;
        stdout = `${operation} complete\n`;
        if (operation === "create") {
          stagingConsumed = true;
          currentParent = currentHead;
          currentHead = "head-created";
          currentBranch = `${branchPrefix}${args[1]}`;
        }
        if (operation === "checkout") currentBranch = args[1];
        if (operation === "modify") {
          stagingConsumed = true;
          if (args.includes("--commit")) currentParent = currentHead;
          currentHead = args.includes("--commit") ? "head-committed" : "head-amended";
        }
        if (operation === "rename") {
          missingBranches.add(currentBranch);
          currentBranch = `${branchPrefix}${args[1]}`;
        }
        if (operation === "fold") {
          missingBranches.add(currentBranch);
          currentBranch = "parent-branch";
        }
        if (operation === "delete") missingBranches.add(args[1]);
        if (operation === "continue" || operation === "abort") rebaseInProgress = false;
        if (stagedAfterMutation) stagingConsumed = false;
        if (branchAfter) currentBranch = branchAfter;
        if (headAfter) currentHead = headAfter;
        if (parentAfter) currentParent = parentAfter;
      }
    }

    return { command, args, exitCode, stdout, stderr };
  };
  return { calls, runner };
}

function createContext(confirmed) {
  const confirms = [];
  const context = {
    cwd: repositoryRoot,
    ui: {
      async confirm(title, message) {
        confirms.push([title, message]);
        return confirmed;
      },
    },
  };
  return { confirms, context };
}

const approvedContext = createContext(true).context;

/** Asserts the generic wrapper message and which verification check produced it. */
function verificationFailed(expectedCause) {
  return (error) => {
    assert.match(error.message, /completed, but post-operation verification failed/u);
    assert.equal(error.cause.message, expectedCause);
    return true;
  };
}

function execute(tool, parameters, signal, context = approvedContext) {
  return tool.execute("graphite-call", parameters, signal, undefined, context);
}

test("registers one dynamically classified Graphite tool", () => {
  const { runner } = createRunner();
  const tools = registerWith(runner);

  assert.deepEqual([...tools.keys()], ["graphite"]);
  const graphite = tools.get("graphite");
  assert.equal(graphite.executionMode, "sequential");
  assert.equal(graphite.concurrency({ operation: "inspect", target: "stack" }), "shared");
  assert.equal(graphite.concurrency({ operation: "move" }), "exclusive");
  assert.equal(graphite.concurrency({}), "exclusive");
  assert.equal(graphite.approval({ operation: "inspect", target: "trunk" }), "read");
  assert.equal(graphite.approval({ operation: "move" }), "exec");
  assert.equal(graphite.approval({ operation: "squash" }), "exec");
  assert.deepEqual(graphite.approval({ operation: "abort" }), {
    tier: "exec",
    policy: "prompt",
    reason: "Graphite abort requires --force after an active rebase is verified.",
  });
  assert.deepEqual(graphite.approval({ operation: "delete" }), {
    tier: "exec",
    policy: "prompt",
    reason: "Graphite delete uses --force and permanently removes a local branch.",
  });
  assert.equal(graphite.approval({ operation: "sync" }).policy, "deny");
  assert.equal(graphite.approval({ operation: "unknown" }).policy, "deny");
});

test("the parameter schema accepts one canonical payload per operation", () => {
  const payloads = [
    { operation: "inspect", target: "stack" },
    { operation: "checkout", branch: "feature/child" },
    { operation: "create", name: "feature/new", subject: "Add child", body: "Focused." },
    { operation: "modify_commit", subject: "Add follow-up", body: "Focused." },
    { operation: "modify_amend" },
    { operation: "squash", subject: "Squashed", body: "Focused." },
    { operation: "fold" },
    { operation: "rename", name: "feature/renamed" },
    { operation: "move", source: "feature/child", onto: "main" },
    { operation: "restack", branch: "feature/child" },
    { operation: "delete", branch: "feature/stale" },
    { operation: "continue" },
    { operation: "abort" },
  ];
  const { runner } = createRunner();
  const graphite = registerWith(runner).get("graphite");

  for (const payload of payloads) {
    assert.equal(Value.Check(graphite.parameters, payload), true, payload.operation);
  }
});

test("the parameter schema rejects payloads outside the declared shape", () => {
  const cases = [
    ["extra field", { operation: "fold", branch: "feature/child" }],
    ["missing body", { operation: "create", name: "feature/new", subject: "Add child" }],
    ["empty branch", { operation: "restack", branch: "" }],
    ["overlong name", { operation: "rename", name: "x".repeat(256) }],
    ["unknown operation", { operation: "sync" }],
  ];
  const { runner } = createRunner();
  const graphite = registerWith(runner).get("graphite");

  for (const [label, payload] of cases) {
    assert.equal(Value.Check(graphite.parameters, payload), false, label);
  }
});

test("approval details spell out the operation the user is authorizing", () => {
  const cases = [
    [{ operation: "inspect", target: "stack" }, ["Operation: inspect stack"]],
    [{ operation: "checkout", branch: "feature/child" }, ["Operation: checkout feature/child"]],
    [
      { operation: "create", name: "feature/new", subject: "Add child", body: "Focused." },
      ["Operation: create feature/new"],
    ],
    [
      { operation: "modify_commit", subject: "Add follow-up", body: "Focused." },
      ["Operation: modify commit"],
    ],
    [{ operation: "modify_amend" }, ["Operation: modify amend"]],
    [{ operation: "squash", subject: "Squashed", body: "Focused." }, ["Operation: squash"]],
    [{ operation: "fold" }, ["Operation: fold"]],
    [{ operation: "rename", name: "feature/renamed" }, ["Operation: rename to feature/renamed"]],
    [
      { operation: "move", source: "feature/child", onto: "main" },
      ["Operation: move feature/child", "New parent: main"],
    ],
    [{ operation: "restack", branch: "feature/child" }, ["Operation: restack feature/child"]],
    [{ operation: "delete", branch: "feature/stale" }, ["Operation: delete feature/stale"]],
    [{ operation: "continue" }, ["Operation: continue"]],
    [{ operation: "abort" }, ["Operation: abort"]],
    ["delete feature/stale", undefined],
  ];
  const { runner } = createRunner();
  const graphite = registerWith(runner).get("graphite");

  for (const [args, expected] of cases) {
    assert.deepEqual(graphite.formatApprovalDetails(args), expected, JSON.stringify(args));
  }
});

test("inspection targets map to fixed read-only argument arrays", async () => {
  const cases = [
    ["stack", ["log", "--stack", "--no-interactive"]],
    ["stack_short", ["log", "short", "--no-interactive"]],
    ["state", ["state", "--no-interactive"]],
    ["parent", ["parent", "--no-interactive"]],
    ["children", ["children", "--no-interactive"]],
    ["trunk", ["trunk", "--no-interactive"]],
    ["info", ["info", "--no-interactive"]],
  ];

  for (const [target, expectedArgs] of cases) {
    const { calls, runner } = createRunner();
    const graphite = registerWith(runner).get("graphite");
    const result = await execute(graphite, { operation: "inspect", target });

    assert.deepEqual(calls, [["gt", ...expectedArgs]], target);
    assert.equal(result.details.operation, "inspect");
    assert.equal(result.details.target, target);
  }
});

test("every stateful operation maps to a fixed argument array", async () => {
  const cases = [
    [
      { operation: "checkout", branch: "feature/child" },
      ["checkout", "feature/child", "--no-interactive"],
    ],
    [
      { operation: "create", name: "feature/new", subject: "Add child", body: "Focused." },
      ["create", "feature/new", "--message=Add child", "--message=Focused.", "--no-interactive"],
    ],
    [
      { operation: "modify_commit", subject: "Add follow-up", body: "Focused." },
      ["modify", "--commit", "--message=Add follow-up", "--message=Focused.", "--no-interactive"],
    ],
    [{ operation: "modify_amend" }, ["modify", "--no-interactive"]],
    [
      { operation: "squash", subject: "Squashed", body: "Focused." },
      ["squash", "--message=Squashed", "--message=Focused.", "--no-interactive"],
    ],
    [{ operation: "fold" }, ["fold", "--no-interactive"]],
    [
      { operation: "rename", name: "feature/renamed" },
      ["rename", "feature/renamed", "--no-interactive"],
    ],
    [
      { operation: "move", source: "feature/child", onto: "main" },
      ["move", "--source=feature/child", "--onto=main", "--no-interactive"],
    ],
    [
      { operation: "restack", branch: "feature/child" },
      ["restack", "--branch=feature/child", "--no-interactive"],
    ],
    [
      { operation: "delete", branch: "feature/stale" },
      ["delete", "feature/stale", "--force", "--no-interactive"],
    ],
    [{ operation: "continue" }, ["continue", "--no-interactive"], { rebase: true }],
    [{ operation: "abort" }, ["abort", "--force", "--no-interactive"], { rebase: true }],
  ];

  for (const [parameters, expectedArgs, runnerOptions] of cases) {
    const { calls, runner } = createRunner(runnerOptions);
    const graphite = registerWith(runner).get("graphite");
    const result = await execute(graphite, parameters);

    assert.deepEqual(
      calls
        .find(([command, operation]) => command === "gt" && operation === expectedArgs[0])
        ?.slice(1),
      expectedArgs,
      parameters.operation,
    );
    assert.equal(result.details.operation, parameters.operation);
    assert.equal(result.details.after.stack, "stack output");
  }
});

test("commit message text is passed as a value and never as an option", async () => {
  const { calls, runner } = createRunner();
  const graphite = registerWith(runner).get("graphite");

  await execute(graphite, {
    operation: "create",
    name: "feature/new",
    subject: "Add child",
    body: "- bullet one\n- bullet two",
  });

  const create = calls.find(([command, operation]) => command === "gt" && operation === "create");
  assert.deepEqual(create.slice(1), [
    "create",
    "feature/new",
    "--message=Add child",
    "--message=- bullet one\n- bullet two",
    "--no-interactive",
  ]);
});

test("branch values keep every valid character when they become flag values", async () => {
  const { calls, runner } = createRunner();
  const graphite = registerWith(runner).get("graphite");

  await execute(graphite, { operation: "restack", branch: "feature/a=b" });

  assert.deepEqual(
    calls.find(([command, operation]) => command === "gt" && operation === "restack")?.slice(1),
    ["restack", "--branch=feature/a=b", "--no-interactive"],
  );
});

test("operations that require a clean worktree stop before Graphite runs", async () => {
  const cases = [
    { operation: "checkout", branch: "feature/child" },
    { operation: "move", source: "feature/child", onto: "main" },
    { operation: "restack", branch: "feature/child" },
    { operation: "squash", subject: "Squashed", body: "Focused." },
    { operation: "fold" },
    { operation: "delete", branch: "feature/stale" },
  ];

  for (const parameters of cases) {
    const { calls, runner } = createRunner({ status: " M src/file.ts\n" });
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), /requires a clean worktree/u);
    assert.equal(mutated(calls), false, parameters.operation);
  }
});

test("commit operations require deliberately staged changes", async () => {
  const cases = [
    { operation: "create", name: "feature/new", subject: "Add child", body: "Focused." },
    { operation: "modify_commit", subject: "Add child", body: "Focused." },
    { operation: "modify_amend" },
  ];

  for (const parameters of cases) {
    const { calls, runner } = createRunner({ staged: false });
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), /requires deliberately staged changes/u);
    assert.equal(mutated(calls), false);
  }
});

test("branch rewriting operations refuse to run on trunk", async () => {
  const cases = [
    { operation: "squash", subject: "Squashed", body: "Focused." },
    { operation: "fold" },
    { operation: "rename", name: "feature/renamed" },
  ];

  for (const parameters of cases) {
    const fixture = createRunner();
    const runner = async (command, args, options) => {
      const result = await fixture.runner(command, args, options);
      if (command === "git" && args[0] === "branch") {
        return { ...result, stdout: "main\n" };
      }
      return result;
    };
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), /cannot run on the trunk branch "main"/u);
    assert.equal(mutated(fixture.calls), false, parameters.operation);
  }
});

test("fold refuses to move commits onto trunk", async () => {
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (command === "gt" && args[0] === "parent") {
      return { ...result, stdout: "main\n" };
    }
    return result;
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "fold" }),
    /cannot fold "current" into the trunk branch "main"/u,
  );
  assert.equal(mutatedWith(fixture.calls, "fold"), false);
});

test("delete refuses trunk, the current branch, and unconfirmed removals", async () => {
  const cases = [
    ["main", true, /cannot remove the trunk branch "main"/u, 0],
    ["current", true, /while it is checked out/u, 0],
    ["feature/stale", false, /requires explicit user confirmation/u, 1],
  ];

  for (const [branch, confirmed, expectedError, expectedConfirms] of cases) {
    const { calls, runner } = createRunner();
    const { confirms, context } = createContext(confirmed);
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(
      execute(graphite, { operation: "delete", branch }, undefined, context),
      expectedError,
    );
    assert.equal(mutatedWith(calls, "delete"), false, branch);
    assert.equal(confirms.length, expectedConfirms, branch);
  }
});

test("delete asks the user to confirm the exact branch it removes", async () => {
  const { runner } = createRunner();
  const { confirms, context } = createContext(true);
  const graphite = registerWith(runner).get("graphite");

  await execute(graphite, { operation: "delete", branch: "feature/stale" }, undefined, context);

  assert.equal(confirms.length, 1);
  assert.equal(confirms[0][0], "Delete Graphite branch feature/stale?");
  assert.match(confirms[0][1], /gt delete --force/u);
});

test("delete and abort fail closed when the host offers no confirmation prompt", async () => {
  const cases = [
    [{ operation: "delete", branch: "feature/stale" }, undefined],
    [{ operation: "abort" }, { rebase: true }],
  ];

  for (const [parameters, runnerOptions] of cases) {
    const { calls, runner } = createRunner(runnerOptions);
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(
      execute(graphite, parameters, undefined, { cwd: repositoryRoot }),
      /requires explicit user confirmation/u,
      parameters.operation,
    );
    assert.equal(mutated(calls), false, parameters.operation);
  }
});

test("rename and fold verify that the previous branch is gone", async () => {
  const cases = [
    [
      { operation: "rename", name: "feature/renamed" },
      'The renamed branch still exists: "current".',
    ],
    [{ operation: "fold" }, 'The folded branch still exists: "current".'],
  ];

  for (const [parameters, expectedCause] of cases) {
    const fixture = createRunner();
    const runner = async (command, args, options) => {
      const result = await fixture.runner(command, args, options);
      if (command === "git" && args[0] === "show-ref" && args.at(-1) === "refs/heads/current") {
        return { ...result, exitCode: 0, stderr: "" };
      }
      return result;
    };
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), verificationFailed(expectedCause));
  }
});

test("rename accepts the configured Graphite branch prefix", async () => {
  const { runner } = createRunner({ branchPrefix: "user/" });
  const graphite = registerWith(runner).get("graphite");

  const result = await execute(graphite, { operation: "rename", name: "feature/renamed" });
  assert.equal(result.details.after.branch, "user/feature/renamed");
});

test("squash verifies a single commit above the parent branch", async () => {
  const { calls, runner } = createRunner({ commitsAboveParent: "2" });
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "squash", subject: "Squashed", body: "Focused." }),
    verificationFailed('Graphite squash left 2 commits above "parent-branch".'),
  );
  assert.deepEqual(
    calls.find(([command, operation]) => command === "git" && operation === "rev-list")?.slice(1),
    ["rev-list", "--count", "parent-branch..HEAD"],
  );
});

test("branch-like values and invalid refs cannot become Graphite options", async () => {
  const cases = [
    [{ operation: "restack", branch: "--force" }, /not a safe branch name/u],
    [{ operation: "restack", branch: "x".repeat(256) }, /not a safe branch name/u],
    [{ operation: "restack", branch: "feature..child" }, /not a valid Git branch name/u],
    [{ operation: "rename", name: "--onto=main" }, /not a safe branch name/u],
    [{ operation: "delete", branch: "-rf" }, /not a safe branch name/u],
    [
      { operation: "create", name: "feature.lock", subject: "Add child", body: "Focused." },
      /not a valid Git branch name/u,
    ],
    [
      { operation: "move", source: "feature/child", onto: "bad ref" },
      /not a valid Git branch name/u,
    ],
  ];

  for (const [parameters, expectedError] of cases) {
    const fixture = createRunner();
    const runner = async (command, args, options) => {
      const result = await fixture.runner(command, args, options);
      const invalid =
        command === "git" &&
        args[0] === "check-ref-format" &&
        ["feature..child", "feature.lock", "bad ref"].includes(args.at(-1));
      return invalid ? { ...result, exitCode: 1, stderr: "invalid ref" } : result;
    };
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), expectedError);
    assert.equal(mutated(fixture.calls), false);
  }
});

test("existing branch inputs are parsed before Graphite execution", async () => {
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (
      command === "git" &&
      args[0] === "show-ref" &&
      args.at(-1) === "refs/heads/feature/missing"
    ) {
      return { ...result, exitCode: 1, stderr: "missing ref" };
    }
    return result;
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "checkout", branch: "feature/missing" }),
    /does not name an existing local branch/u,
  );
  assert.equal(mutated(fixture.calls), false);
});

test("runtime parsing rejects invalid variants before Graphite execution", async () => {
  const cases = [
    [{ operation: "inspect", target: "unknown" }, /Invalid Graphite inspection target/u],
    [{ operation: "modify_amend", unexpected: true }, /accepts exactly these fields/u],
    [{ operation: "fold", branch: "feature/child" }, /accepts exactly these fields/u],
    [{ operation: "rename" }, /accepts exactly these fields/u],
    [
      { operation: "move", source: "feature/child", onto: "feature/child" },
      /must name different local branches/u,
    ],
  ];

  for (const [parameters, expectedError] of cases) {
    const { calls, runner } = createRunner();
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), expectedError);
    assert.equal(mutated(calls), false);
  }
});

test("whitespace, NUL, and multiline commit subjects are rejected before mutation", async () => {
  const cases = [
    [{ subject: " \t\n", body: "Valid body" }, /subject must contain non-whitespace/u],
    [{ subject: "Bad\0subject", body: "Valid body" }, /subject must contain non-whitespace/u],
    [{ subject: "Two\nlines", body: "Valid body" }, /subject must be a single line/u],
    [{ subject: "Valid subject", body: " \t\n" }, /body must contain non-whitespace/u],
    [{ subject: "Valid subject", body: "Bad\0body" }, /body must contain non-whitespace/u],
    [{ subject: "x".repeat(501), body: "Valid body" }, /at most 500 characters/u],
    [{ subject: "Valid subject", body: "x".repeat(20_001) }, /at most 20000 characters/u],
  ];

  for (const [message, expectedError] of cases) {
    const { calls, runner } = createRunner();
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(
      execute(graphite, { operation: "create", name: "feature/child", ...message }),
      expectedError,
    );
    assert.deepEqual(calls, []);
  }
});

test("continue requires a rebase with every conflict resolved", async () => {
  const cases = [
    [{ rebase: false }, /No rebase conflict is available/u],
    [{ rebase: true, unresolved: "src/conflict.ts\n" }, /Resolve and stage these conflicts/u],
  ];

  for (const [options, expectedError] of cases) {
    const { calls, runner } = createRunner(options);
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, { operation: "continue" }), expectedError);
    assert.equal(mutatedWith(calls, "continue"), false);
  }
});

test("abort fails closed without explicit user confirmation", async () => {
  const { calls, runner } = createRunner({ rebase: true });
  const { confirms, context } = createContext(false);
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "abort" }, undefined, context),
    /requires explicit user confirmation/u,
  );
  assert.equal(mutatedWith(calls, "abort"), false);
  assert.equal(confirms.length, 1);
});

test("same-repository mutations execute serially", async () => {
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const secondValidated = Promise.withResolvers();
  const starts = [];
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "show-ref" && args.at(-1) === "refs/heads/feature/two") {
      secondValidated.resolve();
    }
    if (command === "gt" && args[0] === "restack") {
      starts.push(args[1]);
      if (args[1] === "--branch=feature/one") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    }
    return fixture.runner(command, args, options);
  };
  const graphite = registerWith(runner).get("graphite");

  const first = execute(graphite, { operation: "restack", branch: "feature/one" });
  await firstStarted.promise;
  const second = execute(graphite, { operation: "restack", branch: "feature/two" });
  await secondValidated.promise;
  await Promise.resolve();
  assert.deepEqual(starts, ["--branch=feature/one"]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ["--branch=feature/one", "--branch=feature/two"]);
});

test("cancellation prevents a queued mutation from starting", async () => {
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const secondValidated = Promise.withResolvers();
  const starts = [];
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "show-ref" && args.at(-1) === "refs/heads/feature/two") {
      secondValidated.resolve();
    }
    if (command === "gt" && args[0] === "restack") {
      starts.push(args[1]);
      if (args[1] === "--branch=feature/one") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    }
    return fixture.runner(command, args, options);
  };
  const graphite = registerWith(runner).get("graphite");

  const first = execute(graphite, { operation: "restack", branch: "feature/one" });
  await firstStarted.promise;
  const controller = new AbortController();
  const second = execute(
    graphite,
    { operation: "restack", branch: "feature/two" },
    controller.signal,
  );
  await secondValidated.promise;
  controller.abort();
  releaseFirst.resolve();

  await first;
  await assert.rejects(second, CommandCancelledError);
  assert.deepEqual(starts, ["--branch=feature/one"]);
});

test("repository lock releases after a mutation failure", async () => {
  const starts = [];
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    if (command === "gt" && args[0] === "restack") {
      starts.push(args[1]);
      if (args[1] === "--branch=feature/fail") {
        return { command, args, exitCode: 1, stdout: "", stderr: "restack failed" };
      }
    }
    return fixture.runner(command, args, options);
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/fail" }),
    /Graphite restack failed/u,
  );
  await execute(graphite, { operation: "restack", branch: "feature/succeeds" });
  assert.deepEqual(starts, ["--branch=feature/fail", "--branch=feature/succeeds"]);
});

test("failed post-verification reports that mutation may have completed", async () => {
  const { calls, runner } = createRunner({ postStatusFailure: true });
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/child" }),
    (error) => {
      assert.match(
        error.message,
        /completed, but post-operation verification failed[\s\S]*may already have changed[\s\S]*before retrying/u,
      );
      assert.equal(error.cause.message, "Unable to read Git status (exit 1).\nstatus failed");
      return true;
    },
  );
  assert.equal(
    calls.filter(([command, operation]) => command === "gt" && operation === "restack").length,
    1,
  );
});

test("clean mutations fail closed when Graphite leaves repository changes", async () => {
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (mutatedWith(fixture.calls, "restack") && command === "git" && args[0] === "status") {
      return { ...result, stdout: " M src/unexpected.ts\n" };
    }
    return result;
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/child" }),
    verificationFailed("Graphite restack left the worktree dirty:\n M src/unexpected.ts"),
  );
});

test("rename fails closed when Graphite changes the worktree", async () => {
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (mutatedWith(fixture.calls, "rename") && command === "git" && args[0] === "status") {
      return { ...result, stdout: " M src/unexpected.ts\n" };
    }
    return result;
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "rename", name: "feature/renamed" }),
    verificationFailed("Graphite rename changed the worktree unexpectedly."),
  );
});

test("restack fails closed if Graphite changes the checkout", async () => {
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (mutatedWith(fixture.calls, "restack") && command === "git" && args[0] === "branch") {
      return { ...result, stdout: "unexpected-branch\n" };
    }
    return result;
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/child" }),
    verificationFailed("Graphite restack changed the current branch unexpectedly."),
  );
});

test("commit tree mismatch is reported as uncertain success", async () => {
  const { calls, runner } = createRunner({ treeAfter: "wrong-tree" });
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, {
      operation: "create",
      name: "feature/child",
      subject: "Add child",
      body: "Focused.",
    }),
    verificationFailed("Graphite committed a tree that differs from the staged snapshot."),
  );
  assert.equal(
    calls.filter(([command, operation]) => command === "gt" && operation === "create").length,
    1,
  );
});

test("post-operation verification names the check that failed", async () => {
  const create = {
    operation: "create",
    name: "feature/new",
    subject: "Add child",
    body: "Focused.",
  };
  const cases = [
    [
      create,
      { unstagedPatchAfter: "rewritten patch\n" },
      "Graphite changed unstaged tracked content unexpectedly.",
    ],
    [
      create,
      { untrackedAfter: "other.txt\0" },
      "Graphite changed the untracked path set unexpectedly.",
    ],
    [
      create,
      { stagedAfterMutation: true },
      "Graphite left staged changes after reporting commit success.",
    ],
    [create, { headAfter: "head-before" }, "Graphite reported success without changing HEAD."],
    [
      create,
      { parentAfter: "unexpected-parent" },
      "Graphite created a commit on an unexpected parent.",
    ],
    [create, { branchAfter: "current" }, "Graphite create did not switch to a new branch."],
    [
      { operation: "modify_commit", subject: "Add follow-up", body: "Focused." },
      { branchAfter: "unexpected-branch" },
      "Graphite modify switched branches unexpectedly.",
    ],
    [
      { operation: "modify_amend" },
      { parentAfter: "unexpected-parent" },
      "Graphite amend changed the branch or commit parent unexpectedly.",
    ],
    [
      { operation: "modify_amend" },
      { branchAfter: "unexpected-branch" },
      "Graphite amend changed the branch or commit parent unexpectedly.",
    ],
    [
      { operation: "checkout", branch: "feature/child" },
      { branchAfter: "unexpected-branch" },
      'Graphite checked out "unexpected-branch" instead of "feature/child".',
    ],
    [
      { operation: "squash", subject: "Squashed", body: "Focused." },
      { treeAfter: "rewritten-tree" },
      "Graphite squash changed the branch content.",
    ],
    [
      { operation: "fold" },
      { branchAfter: "unexpected-branch" },
      'Graphite fold left "unexpected-branch" checked out instead of "parent-branch".',
    ],
    [
      { operation: "fold" },
      { treeAfter: "rewritten-tree" },
      "Graphite fold changed the combined branch content.",
    ],
    [
      { operation: "rename", name: "feature/renamed" },
      { branchAfter: "unexpected-branch" },
      'Graphite renamed the branch to "unexpected-branch" instead of "feature/renamed".',
    ],
    [
      { operation: "rename", name: "feature/renamed" },
      { headAfter: "head-rewritten" },
      "Graphite rename changed the branch commit.",
    ],
    [
      { operation: "move", source: "feature/child", onto: "main" },
      { mergeBaseFailure: true },
      "Moved branch is not based on the requested parent (exit 1).\nmerge-base failed",
    ],
  ];

  for (const [parameters, runnerOptions, expectedCause] of cases) {
    const { runner } = createRunner(runnerOptions);
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, parameters), verificationFailed(expectedCause));
  }
});

test("conflict recovery keeps working when the stack cannot be drawn", async () => {
  const cases = [
    [
      { operation: "continue" },
      "exit",
      "[stack unavailable during conflict: gt log is unavailable during a rebase]",
    ],
    [{ operation: "abort" }, "throw", "[stack unavailable during conflict: gt log crashed]"],
  ];

  for (const [parameters, stackFailure, expectedStack] of cases) {
    const { runner } = createRunner({ rebase: true, stackFailure });
    const graphite = registerWith(runner).get("graphite");

    const result = await execute(graphite, parameters);

    assert.equal(result.details.before.stack, expectedStack, parameters.operation);
    assert.equal(result.details.after.stack, "stack output", parameters.operation);
  }
});

test("operations outside conflict recovery stop when the stack cannot be drawn", async () => {
  const cases = [
    ["exit", /Unable to inspect the Graphite stack/u],
    ["throw", /gt log crashed/u],
  ];

  for (const [stackFailure, expectedError] of cases) {
    const { calls, runner } = createRunner({ stackFailure });
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(
      execute(graphite, { operation: "restack", branch: "feature/child" }),
      expectedError,
    );
    assert.equal(mutated(calls), false, stackFailure);
  }
});

test("mutations that need a branch refuse to run on a detached HEAD", async () => {
  const { calls, runner } = createRunner({ rebase: true });
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/child" }),
    /restack requires an attached local branch/u,
  );
  assert.equal(mutatedWith(calls, "restack"), false);
});

test("restack fails closed when Graphite leaves the repository detached", async () => {
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    const result = await fixture.runner(command, args, options);
    if (mutatedWith(fixture.calls, "restack") && command === "git" && args[0] === "branch") {
      return { ...result, stdout: "" };
    }
    return result;
  };
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/child" }),
    verificationFailed("Graphite reported success but left the repository detached."),
  );
});

test("a gt executable that cannot start invalidates the cached capability", async () => {
  const forgotten = [];
  const fixture = createRunner();
  const runner = async (command, args, options) => {
    if (command === "gt" && args[0] === "restack") {
      throw new CommandInvocationError("gt", "Unable to execute gt: spawn gt ENOENT", "ENOENT");
    }
    return fixture.runner(command, args, options);
  };
  const graphite = registerWith(runner, (root) => forgotten.push(root)).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "restack", branch: "feature/child" }),
    /the `gt` executable could not be started/u,
  );
  assert.deepEqual(forgotten, [repositoryRoot]);
});

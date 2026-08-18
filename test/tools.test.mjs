import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandCancelledError } from "../dist/process.js";
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

function registerWith(runner) {
  const tools = new Map();
  const capabilities = {
    async ensure() {
      return capability;
    },
    forget() {},
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
  treeMismatch = false,
  branchPrefix = "",
  commitsAboveParent = "1",
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
            stdout = "unstaged patch\n";
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
          stdout = "untracked.txt\0";
          break;
        case "merge-base":
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
            stdout = `${treeMismatch ? "wrong-tree" : stagedTree}\n`;
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
      }
    }

    return { command, args, exitCode, stdout, stderr };
  };
  return { calls, runner };
}

const approvedContext = {
  cwd: repositoryRoot,
  ui: {
    async confirm() {
      return true;
    },
  },
};

const declinedContext = {
  cwd: repositoryRoot,
  ui: {
    async confirm() {
      return false;
    },
  },
};

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
  assert.deepEqual(
    graphite.parameters.anyOf.map((entry) => entry.properties.operation.const),
    [
      "inspect",
      "checkout",
      "create",
      "modify_commit",
      "modify_amend",
      "squash",
      "fold",
      "rename",
      "move",
      "restack",
      "delete",
      "continue",
      "abort",
    ],
  );
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
    ["main", approvedContext, /cannot remove the trunk branch "main"/u],
    ["current", approvedContext, /while it is checked out/u],
    ["feature/stale", declinedContext, /requires explicit user confirmation/u],
  ];

  for (const [branch, context, expectedError] of cases) {
    const { calls, runner } = createRunner();
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(
      execute(graphite, { operation: "delete", branch }, undefined, context),
      expectedError,
    );
    assert.equal(mutatedWith(calls, "delete"), false, branch);
  }
});

test("rename and fold verify that the previous branch is gone", async () => {
  for (const parameters of [
    { operation: "rename", name: "feature/renamed" },
    { operation: "fold" },
  ]) {
    const fixture = createRunner();
    const runner = async (command, args, options) => {
      const result = await fixture.runner(command, args, options);
      if (command === "git" && args[0] === "show-ref" && args.at(-1) === "refs/heads/current") {
        return { ...result, exitCode: 0, stderr: "" };
      }
      return result;
    };
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(
      execute(graphite, parameters),
      /completed, but post-operation verification failed/u,
      parameters.operation,
    );
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
    /completed, but post-operation verification failed/u,
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
  for (const options of [{ rebase: false }, { rebase: true, unresolved: "src/conflict.ts\n" }]) {
    const { calls, runner } = createRunner(options);
    const graphite = registerWith(runner).get("graphite");

    await assert.rejects(execute(graphite, { operation: "continue" }));
    assert.equal(mutatedWith(calls, "continue"), false);
  }
});

test("abort fails closed without explicit user confirmation", async () => {
  const { calls, runner } = createRunner({ rebase: true });
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, { operation: "abort" }, undefined, declinedContext),
    /requires explicit user confirmation/u,
  );
  assert.equal(mutatedWith(calls, "abort"), false);
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
    /completed, but post-operation verification failed[\s\S]*may already have changed[\s\S]*before retrying/u,
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
    /completed, but post-operation verification failed/u,
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
    /completed, but post-operation verification failed/u,
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
    /completed, but post-operation verification failed/u,
  );
});

test("commit tree mismatch is reported as uncertain success", async () => {
  const { calls, runner } = createRunner({ treeMismatch: true });
  const graphite = registerWith(runner).get("graphite");

  await assert.rejects(
    execute(graphite, {
      operation: "create",
      name: "feature/child",
      subject: "Add child",
      body: "Focused.",
    }),
    /completed, but post-operation verification failed/u,
  );
  assert.equal(
    calls.filter(([command, operation]) => command === "gt" && operation === "create").length,
    1,
  );
});

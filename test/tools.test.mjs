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

function createMutationRunner(status = "") {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    let stdout = "";
    if (command === "git" && args[0] === "branch") stdout = "current\n";
    if (command === "git" && args[0] === "status") stdout = status;
    if (command === "git" && args[0] === "diff") stdout = "diff summary\n";
    if (command === "git" && args[0] === "check-ref-format") stdout = `${args.at(-1)}\n`;
    if (command === "gt" && args[0] === "log") stdout = "stack output\n";
    if (command === "gt" && args[0] !== "log") stdout = `${args[0]} complete\n`;
    return { command, args, exitCode: 0, stdout, stderr: "" };
  };
  return { calls, runner };
}

test("registers the narrow Pi and OMP tool surface", () => {
  const tools = registerWith(async (command, args) => ({
    command,
    args,
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));

  assert.deepEqual(
    [...tools.keys()],
    ["graphite_inspect", "graphite_restack", "graphite_create", "graphite_move"],
  );
  assert.equal(tools.get("graphite_inspect").approval, "read");
  assert.equal(tools.get("graphite_inspect").executionMode, "parallel");
  for (const name of ["graphite_restack", "graphite_create", "graphite_move"]) {
    assert.equal(tools.get(name).approval, "exec");
    assert.equal(tools.get(name).executionMode, "sequential");
  }
  assert.deepEqual(
    tools.get("graphite_inspect").parameters.properties.operation.anyOf.map((entry) => entry.const),
    ["stack", "parent", "trunk"],
  );
});

test("graphite_inspect maps each operation to a fixed argument array", async () => {
  const calls = [];
  const tools = registerWith(async (command, args) => {
    calls.push([command, ...args]);
    return {
      command,
      args,
      exitCode: 0,
      stdout: "result\n",
      stderr: "",
    };
  });
  const inspect = tools.get("graphite_inspect");
  const cases = [
    ["stack", ["log", "--stack", "--no-interactive"]],
    ["parent", ["parent", "--no-interactive"]],
    ["trunk", ["trunk", "--no-interactive"]],
  ];

  for (const [operation, expectedArgs] of cases) {
    calls.length = 0;
    const result = await inspect.execute(
      `inspect-${operation}`,
      { operation },
      undefined,
      undefined,
      { cwd: repositoryRoot },
    );

    assert.deepEqual(calls, [["gt", ...expectedArgs]], operation);
    assert.equal(result.content[0].text, "result");
    assert.equal(result.details.operation, operation);
    assert.equal(result.details.capability.cache, "persistent");
  }
});

test("mutation tools map each operation to a fixed argument array", async () => {
  const cases = [
    {
      toolName: "graphite_restack",
      parameters: { branch: "feature/child" },
      expectedArgs: ["restack", "--branch", "feature/child", "--no-interactive"],
    },
    {
      toolName: "graphite_create",
      parameters: {
        name: "feature/new",
        subject: "Add child",
        body: "Keep the change focused.",
      },
      expectedArgs: [
        "create",
        "feature/new",
        "-m",
        "Add child",
        "-m",
        "Keep the change focused.",
        "--no-interactive",
      ],
    },
    {
      toolName: "graphite_move",
      parameters: { source: "feature/child", onto: "main" },
      expectedArgs: ["move", "--source", "feature/child", "--onto", "main", "--no-interactive"],
    },
  ];

  for (const { toolName, parameters, expectedArgs } of cases) {
    const { calls, runner } = createMutationRunner();
    const tool = registerWith(runner).get(toolName);
    const result = await tool.execute(`execute-${toolName}`, parameters, undefined, undefined, {
      cwd: repositoryRoot,
    });

    assert.deepEqual(
      calls.find(([command, operation]) => command === "gt" && operation === expectedArgs[0]),
      ["gt", ...expectedArgs],
      toolName,
    );
    assert.equal(result.details.operation, expectedArgs[0]);
    assert.equal(result.details.before.branch, "current");
    assert.equal(result.details.after.stack, "stack output");
    assert.equal(
      calls.filter(([command, operation]) => command === "gt" && operation === "log").length,
      2,
    );
  }
});

test("history rewrites stop on a dirty worktree", async () => {
  const { calls, runner } = createMutationRunner(" M src/file.ts\n");
  const tools = registerWith(runner);
  const move = tools.get("graphite_move");

  await assert.rejects(
    move.execute("call-3", { source: "feature/child", onto: "main" }, undefined, undefined, {
      cwd: repositoryRoot,
    }),
    /move requires a clean worktree[\s\S]*src\/file\.ts/u,
  );
  assert.equal(
    calls.some(([command, operation]) => command === "gt" && operation === "move"),
    false,
  );
});

test("branch-like values cannot become Graphite options", async () => {
  const calls = [];
  const tools = registerWith(async (command, args) => {
    calls.push([command, ...args]);
    return { command, args, exitCode: 0, stdout: "", stderr: "" };
  });
  const restack = tools.get("graphite_restack");

  await assert.rejects(
    restack.execute("call-4", { branch: "--force" }, undefined, undefined, { cwd: repositoryRoot }),
    /not a safe branch name/u,
  );
  assert.deepEqual(calls, []);
});

test("invalid Git refs are rejected before mutation commands run", async () => {
  const cases = [
    ["graphite_restack", { branch: "feature..child" }],
    [
      "graphite_create",
      { name: "feature.lock", subject: "Add child", body: "Keep the change focused." },
    ],
    ["graphite_move", { source: "feature/child", onto: "bad ref" }],
  ];

  for (const [toolName, parameters] of cases) {
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, ...args]);
      const invalidRef =
        command === "git" &&
        args[0] === "check-ref-format" &&
        ["feature..child", "feature.lock", "bad ref"].includes(args.at(-1));
      return {
        command,
        args,
        exitCode: invalidRef ? 1 : 0,
        stdout: "",
        stderr: invalidRef ? "invalid ref" : "",
      };
    };
    const tool = registerWith(runner).get(toolName);

    await assert.rejects(
      tool.execute("invalid-ref", parameters, undefined, undefined, { cwd: repositoryRoot }),
      /not a valid Git branch name/u,
      toolName,
    );
    assert.equal(
      calls.some(([command]) => command === "gt"),
      false,
      toolName,
    );
  }
});

test("whitespace and NUL commit messages are rejected before create runs", async () => {
  const cases = [
    [{ subject: " \t\n", body: "Valid body" }, /subject must contain non-whitespace/u],
    [{ subject: "Bad\0subject", body: "Valid body" }, /subject must contain non-whitespace/u],
    [{ subject: "Valid subject", body: " \t\n" }, /body must contain non-whitespace/u],
    [{ subject: "Valid subject", body: "Bad\0body" }, /body must contain non-whitespace/u],
  ];

  for (const [message, expectedError] of cases) {
    const { calls, runner } = createMutationRunner();
    const create = registerWith(runner).get("graphite_create");

    await assert.rejects(
      create.execute(
        "invalid-message",
        { name: "feature/child", ...message },
        undefined,
        undefined,
        { cwd: repositoryRoot },
      ),
      expectedError,
    );
    assert.equal(
      calls.some(([command, operation]) => command === "gt" && operation === "create"),
      false,
    );
  }
});

test("same-repository mutations execute serially", async () => {
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const secondValidated = Promise.withResolvers();
  const starts = [];
  const { runner: baseRunner } = createMutationRunner();
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "check-ref-format" && args.at(-1) === "feature/two") {
      secondValidated.resolve();
    }
    if (command === "gt" && args[0] === "create") {
      starts.push(args[1]);
      if (args[1] === "feature/one") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    }
    return baseRunner(command, args, options);
  };
  const create = registerWith(runner).get("graphite_create");
  const executeCreate = (name) =>
    create.execute(
      `create-${name}`,
      { name, subject: `Create ${name}`, body: "Create a serialized change." },
      undefined,
      undefined,
      { cwd: repositoryRoot },
    );

  const first = executeCreate("feature/one");
  await firstStarted.promise;
  const second = executeCreate("feature/two");
  await secondValidated.promise;
  await Promise.resolve();
  assert.deepEqual(starts, ["feature/one"]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ["feature/one", "feature/two"]);
});

test("cancellation prevents a queued mutation from starting", async () => {
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const secondValidated = Promise.withResolvers();
  const starts = [];
  const { runner: baseRunner } = createMutationRunner();
  const runner = async (command, args, options) => {
    if (command === "git" && args[0] === "check-ref-format" && args.at(-1) === "feature/two") {
      secondValidated.resolve();
    }
    if (command === "gt" && args[0] === "create") {
      starts.push(args[1]);
      if (args[1] === "feature/one") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    }
    return baseRunner(command, args, options);
  };
  const create = registerWith(runner).get("graphite_create");
  const executeCreate = (name, signal) =>
    create.execute(
      `create-${name}`,
      { name, subject: `Create ${name}`, body: "Create a serialized change." },
      signal,
      undefined,
      { cwd: repositoryRoot },
    );

  const first = executeCreate("feature/one");
  await firstStarted.promise;
  const controller = new AbortController();
  const second = executeCreate("feature/two", controller.signal);
  await secondValidated.promise;
  controller.abort();
  releaseFirst.resolve();

  await first;
  await assert.rejects(second, CommandCancelledError);
  assert.deepEqual(starts, ["feature/one"]);
});

test("repository lock releases after a mutation failure", async () => {
  const starts = [];
  const { runner: baseRunner } = createMutationRunner();
  const runner = async (command, args, options) => {
    if (command === "gt" && args[0] === "create") {
      starts.push(args[1]);
      if (args[1] === "feature/fail") {
        return { command, args, exitCode: 1, stdout: "", stderr: "create failed" };
      }
    }
    return baseRunner(command, args, options);
  };
  const create = registerWith(runner).get("graphite_create");
  const executeCreate = (name) =>
    create.execute(
      `create-${name}`,
      { name, subject: `Create ${name}`, body: "Exercise lock release." },
      undefined,
      undefined,
      { cwd: repositoryRoot },
    );

  await assert.rejects(executeCreate("feature/fail"), /Graphite create failed/u);
  await executeCreate("feature/succeeds");
  assert.deepEqual(starts, ["feature/fail", "feature/succeeds"]);
});

test("post-operation verification failure reports uncertain success", async () => {
  let mutationCompleted = false;
  const { calls, runner: baseRunner } = createMutationRunner();
  const runner = async (command, args, options) => {
    if (command === "gt" && args[0] === "create") {
      mutationCompleted = true;
    }
    if (mutationCompleted && command === "git" && args[0] === "status") {
      return { command, args, exitCode: 1, stdout: "", stderr: "status failed" };
    }
    return baseRunner(command, args, options);
  };
  const create = registerWith(runner).get("graphite_create");

  await assert.rejects(
    create.execute(
      "uncertain-create",
      { name: "feature/child", subject: "Add child", body: "Verify after mutation." },
      undefined,
      undefined,
      { cwd: repositoryRoot },
    ),
    /Graphite create completed, but post-operation stack verification failed[\s\S]*before retrying/u,
  );
  assert.equal(
    calls.filter(([command, operation]) => command === "gt" && operation === "create").length,
    1,
  );
});

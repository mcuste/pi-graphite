import assert from "node:assert/strict";
import { test } from "node:test";
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
      stdout: "main\n",
      stderr: "",
    };
  });
  const inspect = tools.get("graphite_inspect");

  const result = await inspect.execute("call-1", { operation: "parent" }, undefined, undefined, {
    cwd: repositoryRoot,
  });

  assert.deepEqual(calls, [["gt", "parent", "--no-interactive"]]);
  assert.equal(result.content[0].text, "main");
  assert.equal(result.details.operation, "parent");
  assert.equal(result.details.capability.cache, "persistent");
});

test("graphite_create validates input and commits only through fixed flags", async () => {
  const { calls, runner } = createMutationRunner();
  const tools = registerWith(runner);
  const create = tools.get("graphite_create");

  const result = await create.execute(
    "call-2",
    { name: "feature/child", subject: "Add child", body: "Keep the change focused." },
    undefined,
    undefined,
    { cwd: repositoryRoot },
  );

  assert.deepEqual(
    calls.find(([command, operation]) => command === "gt" && operation === "create"),
    [
      "gt",
      "create",
      "feature/child",
      "-m",
      "Add child",
      "-m",
      "Keep the change focused.",
      "--no-interactive",
    ],
  );
  assert.equal(result.details.operation, "create");
  assert.equal(result.details.before.branch, "current");
  assert.equal(result.details.after.stack, "stack output");
  assert.equal(
    calls.filter(([command, operation]) => command === "gt" && operation === "log").length,
    2,
  );
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { registerGraphiteTools } from "../dist/tools.js";

function execute(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("all tools preserve the expected stack in an isolated Graphite repository", {
  skip: process.env.PI_GRAPHITE_INTEGRATION !== "1",
}, async (t) => {
  const sandbox = await mkdtemp(join(process.cwd(), "test/.integration-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  execute("git", ["init", "--initial-branch=main"], sandbox);
  execute("git", ["config", "user.name", "Pi Graphite Test"], sandbox);
  execute("git", ["config", "user.email", "pi-graphite@example.invalid"], sandbox);
  await writeFile(join(sandbox, "base.txt"), "base\n");
  execute("git", ["add", "base.txt"], sandbox);
  execute("git", ["commit", "-m", "Initial commit"], sandbox);
  execute("gt", ["init", "--trunk", "main", "--no-interactive"], sandbox);

  const tools = new Map();
  registerGraphiteTools({
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  });
  const context = { cwd: sandbox };

  const trunk = await tools
    .get("graphite_inspect")
    .execute("inspect-trunk", { operation: "trunk" }, undefined, undefined, context);
  assert.equal(trunk.content[0].text, "main");

  const cache = JSON.parse(await readFile(join(sandbox, ".git", "pi-graphite.json"), "utf8"));
  assert.equal(cache.usesGraphite, true);
  assert.equal(cache.trunk, "main");

  await writeFile(join(sandbox, "one.txt"), "one\n");
  await writeFile(join(sandbox, "base.txt"), "base\nunstaged\n");
  await writeFile(join(sandbox, "untracked.txt"), "untracked\n");
  execute("git", ["add", "one.txt"], sandbox);
  const firstCreate = await tools
    .get("graphite_create")
    .execute(
      "create-one",
      { name: "feature/one", subject: "Add one", body: "Add the first stacked change." },
      undefined,
      undefined,
      context,
    );
  const firstBranch = firstCreate.details.after.branch;
  assert.equal(
    execute("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", firstBranch], sandbox),
    "one.txt",
  );
  assert.equal(execute("git", ["show", `${firstBranch}:one.txt`], sandbox), "one");
  assert.equal(execute("git", ["show", `${firstBranch}:base.txt`], sandbox), "base");
  assert.equal(await readFile(join(sandbox, "base.txt"), "utf8"), "base\nunstaged\n");
  assert.equal(await readFile(join(sandbox, "untracked.txt"), "utf8"), "untracked\n");
  assert.equal(execute("git", ["status", "--short"], sandbox), "M base.txt\n?? untracked.txt");

  await writeFile(join(sandbox, "base.txt"), "base\n");
  await rm(join(sandbox, "untracked.txt"));
  assert.equal(execute("git", ["status", "--short"], sandbox), "");

  await writeFile(join(sandbox, "two.txt"), "two\n");
  execute("git", ["add", "two.txt"], sandbox);
  const secondCreate = await tools
    .get("graphite_create")
    .execute(
      "create-two",
      { name: "feature/two", subject: "Add two", body: "Add the second stacked change." },
      undefined,
      undefined,
      context,
    );
  const secondBranch = secondCreate.details.after.branch;
  assert.equal(execute("gt", ["parent", "--no-interactive"], sandbox), firstBranch);

  const originalChild = execute("git", ["rev-parse", secondBranch], sandbox);
  const originalChildPatch = execute(
    "git",
    ["diff", `${originalChild}^`, originalChild, "--", "two.txt"],
    sandbox,
  );
  execute("git", ["checkout", firstBranch], sandbox);
  await writeFile(join(sandbox, "parent-later.txt"), "parent advanced\n");
  execute("git", ["add", "parent-later.txt"], sandbox);
  execute("git", ["commit", "-m", "Advance parent"], sandbox);
  const advancedParent = execute("git", ["rev-parse", firstBranch], sandbox);
  assert.notEqual(execute("git", ["rev-parse", `${secondBranch}^`], sandbox), advancedParent);
  execute("git", ["checkout", secondBranch], sandbox);

  await tools
    .get("graphite_restack")
    .execute("restack-two", { branch: secondBranch }, undefined, undefined, context);

  const restackedChild = execute("git", ["rev-parse", secondBranch], sandbox);
  assert.notEqual(restackedChild, originalChild);
  assert.equal(execute("git", ["rev-parse", `${secondBranch}^`], sandbox), advancedParent);
  assert.equal(
    execute("git", ["diff", `${restackedChild}^`, restackedChild, "--", "two.txt"], sandbox),
    originalChildPatch,
  );
  assert.equal(
    execute("git", ["show", `${secondBranch}:parent-later.txt`], sandbox),
    "parent advanced",
  );
  assert.equal(execute("git", ["show", `${secondBranch}:two.txt`], sandbox), "two");

  await tools
    .get("graphite_move")
    .execute("move-two", { source: secondBranch, onto: "main" }, undefined, undefined, context);
  assert.equal(execute("gt", ["parent", "--no-interactive"], sandbox), "main");

  const stack = execute("gt", ["log", "--stack", "--no-interactive"], sandbox);
  assert.ok(stack.includes(secondBranch));
  assert.match(stack, /main/u);
  assert.equal(execute("git", ["status", "--short"], sandbox), "");
});

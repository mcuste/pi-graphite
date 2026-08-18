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
  const graphite = tools.get("graphite");
  const context = {
    cwd: sandbox,
    ui: {
      async confirm() {
        return true;
      },
    },
  };
  let callId = 0;
  const invoke = (parameters) =>
    graphite.execute(`graphite-${++callId}`, parameters, undefined, undefined, context);

  const trunk = await invoke({ operation: "inspect", target: "trunk" });
  assert.equal(trunk.content[0].text, "main");

  const cache = JSON.parse(await readFile(join(sandbox, ".git", "pi-graphite.json"), "utf8"));
  assert.equal(cache.usesGraphite, true);
  assert.equal(cache.trunk, "main");

  await writeFile(join(sandbox, "one.txt"), "one\n");
  await writeFile(join(sandbox, "base.txt"), "base\nunstaged\n");
  await writeFile(join(sandbox, "untracked.txt"), "untracked\n");
  execute("git", ["add", "one.txt"], sandbox);
  const firstCreate = await invoke({
    operation: "create",
    name: "feature/one",
    subject: "Add one",
    body: "Add the first stacked change.",
  });
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
  const secondCreate = await invoke({
    operation: "create",
    name: "feature/two",
    subject: "Add two",
    body: "Add the second stacked change.",
  });
  const secondBranch = secondCreate.details.after.branch;
  assert.equal(execute("gt", ["parent", "--no-interactive"], sandbox), firstBranch);

  await invoke({ operation: "checkout", branch: firstBranch });
  assert.equal(execute("git", ["branch", "--show-current"], sandbox), firstBranch);
  await invoke({ operation: "checkout", branch: secondBranch });
  assert.equal(execute("git", ["branch", "--show-current"], sandbox), secondBranch);

  const beforeAmend = execute("git", ["rev-parse", secondBranch], sandbox);
  await writeFile(join(sandbox, "two.txt"), "two amended\n");
  execute("git", ["add", "two.txt"], sandbox);
  await invoke({ operation: "modify_amend" });
  assert.notEqual(execute("git", ["rev-parse", secondBranch], sandbox), beforeAmend);
  assert.equal(execute("git", ["show", `${secondBranch}:two.txt`], sandbox), "two amended");

  await writeFile(join(sandbox, "follow-up.txt"), "follow-up\n");
  execute("git", ["add", "follow-up.txt"], sandbox);
  await invoke({
    operation: "modify_commit",
    subject: "Add follow-up",
    body: "Exercise an additional commit on the branch.",
  });
  assert.equal(execute("git", ["show", `${secondBranch}:follow-up.txt`], sandbox), "follow-up");

  const originalParent = execute("git", ["rev-parse", firstBranch], sandbox);
  const originalChild = execute("git", ["rev-parse", secondBranch], sandbox);
  const originalChildPatch = execute("git", ["diff", originalParent, originalChild], sandbox);
  execute("git", ["checkout", firstBranch], sandbox);
  await writeFile(join(sandbox, "parent-later.txt"), "parent advanced\n");
  execute("git", ["add", "parent-later.txt"], sandbox);
  execute("git", ["commit", "-m", "Advance parent"], sandbox);
  const advancedParent = execute("git", ["rev-parse", firstBranch], sandbox);
  assert.notEqual(
    execute("git", ["merge-base", firstBranch, secondBranch], sandbox),
    advancedParent,
  );
  execute("git", ["checkout", secondBranch], sandbox);

  await invoke({ operation: "restack", branch: secondBranch });

  const restackedChild = execute("git", ["rev-parse", secondBranch], sandbox);
  assert.notEqual(restackedChild, originalChild);
  assert.equal(execute("git", ["merge-base", firstBranch, secondBranch], sandbox), advancedParent);
  assert.equal(
    execute("git", ["diff", advancedParent, restackedChild], sandbox),
    originalChildPatch,
  );
  assert.equal(
    execute("git", ["show", `${secondBranch}:parent-later.txt`], sandbox),
    "parent advanced",
  );
  assert.equal(execute("git", ["show", `${secondBranch}:two.txt`], sandbox), "two amended");

  await invoke({ operation: "move", source: secondBranch, onto: "main" });
  const parent = await invoke({ operation: "inspect", target: "parent" });
  assert.equal(parent.content[0].text, "main");

  const shortStack = await invoke({ operation: "inspect", target: "stack_short" });
  assert.ok(shortStack.content[0].text.includes(secondBranch));
  const state = await invoke({ operation: "inspect", target: "state" });
  const trackedBranches = JSON.parse(state.content[0].text);
  assert.equal(trackedBranches.main.trunk, true);
  assert.deepEqual(
    trackedBranches[secondBranch].parents.map((entry) => entry.ref),
    ["main"],
  );
  const info = await invoke({ operation: "inspect", target: "info" });
  assert.ok(info.content[0].text.includes(secondBranch));

  await invoke({ operation: "checkout", branch: "main" });
  const children = await invoke({ operation: "inspect", target: "children" });
  assert.ok(children.content[0].text.includes(firstBranch));
  assert.ok(children.content[0].text.includes(secondBranch));
  await invoke({ operation: "checkout", branch: secondBranch });

  assert.equal(execute("git", ["rev-list", "--count", `main..${secondBranch}`], sandbox), "2");
  const squashedTree = execute("git", ["rev-parse", "HEAD^{tree}"], sandbox);
  await invoke({
    operation: "squash",
    subject: "Add two with follow-up",
    body: "- combine the branch into one commit",
  });
  assert.equal(execute("git", ["rev-list", "--count", "main..HEAD"], sandbox), "1");
  assert.equal(execute("git", ["rev-parse", "HEAD^{tree}"], sandbox), squashedTree);
  assert.equal(execute("git", ["log", "-1", "--format=%s"], sandbox), "Add two with follow-up");
  assert.equal(
    execute("git", ["log", "-1", "--format=%b"], sandbox),
    "- combine the branch into one commit",
  );

  const renamed = await invoke({ operation: "rename", name: "feature/renamed" });
  const renamedBranch = renamed.details.after.branch;
  assert.ok(renamedBranch.endsWith("feature/renamed"));
  assert.equal(execute("git", ["branch", "--list", secondBranch], sandbox), "");
  assert.equal(execute("git", ["rev-parse", "HEAD^{tree}"], sandbox), squashedTree);

  await writeFile(join(sandbox, "foldable.txt"), "foldable\n");
  execute("git", ["add", "foldable.txt"], sandbox);
  const foldable = await invoke({
    operation: "create",
    name: "feature/foldable",
    subject: "Add foldable change",
    body: "Prepare fold coverage.",
  });
  const foldableBranch = foldable.details.after.branch;
  const foldedTree = execute("git", ["rev-parse", "HEAD^{tree}"], sandbox);
  const folded = await invoke({ operation: "fold" });
  assert.equal(folded.details.after.branch, renamedBranch);
  assert.equal(execute("git", ["rev-parse", "HEAD^{tree}"], sandbox), foldedTree);
  assert.equal(execute("git", ["branch", "--list", foldableBranch], sandbox), "");

  await invoke({ operation: "delete", branch: firstBranch });
  assert.equal(execute("git", ["branch", "--list", firstBranch], sandbox), "");
  assert.equal(execute("git", ["branch", "--show-current"], sandbox), renamedBranch);
  assert.equal(execute("git", ["status", "--short"], sandbox), "");

  execute("git", ["checkout", "main"], sandbox);
  await writeFile(join(sandbox, "conflict.txt"), "parent\n");
  execute("git", ["add", "conflict.txt"], sandbox);
  const conflictParentCreate = await invoke({
    operation: "create",
    name: "conflict/parent",
    subject: "Add conflict base",
    body: "Prepare conflict recovery coverage.",
  });
  const conflictParent = conflictParentCreate.details.after.branch;
  await writeFile(join(sandbox, "conflict.txt"), "child\n");
  execute("git", ["add", "conflict.txt"], sandbox);
  const conflictChildCreate = await invoke({
    operation: "create",
    name: "conflict/child",
    subject: "Change conflict child",
    body: "Prepare conflict recovery coverage.",
  });
  const conflictChild = conflictChildCreate.details.after.branch;

  execute("git", ["checkout", conflictParent], sandbox);
  await writeFile(join(sandbox, "conflict.txt"), "parent advanced\n");
  execute("git", ["add", "conflict.txt"], sandbox);
  execute("git", ["commit", "-m", "Advance conflicting parent"], sandbox);
  execute("git", ["checkout", conflictChild], sandbox);

  await assert.rejects(
    invoke({ operation: "restack", branch: conflictChild }),
    /Graphite restack failed/u,
  );
  await invoke({ operation: "abort" });
  assert.equal(execute("git", ["status", "--short"], sandbox), "");
  assert.equal(execute("git", ["branch", "--show-current"], sandbox), conflictChild);

  await assert.rejects(
    invoke({ operation: "restack", branch: conflictChild }),
    /Graphite restack failed/u,
  );
  await writeFile(join(sandbox, "conflict.txt"), "resolved\n");
  execute("git", ["add", "conflict.txt"], sandbox);
  await invoke({ operation: "continue" });
  assert.equal(execute("git", ["status", "--short"], sandbox), "");
  assert.equal(await readFile(join(sandbox, "conflict.txt"), "utf8"), "resolved\n");

  const stackResult = await invoke({ operation: "inspect", target: "stack" });
  assert.ok(stackResult.content[0].text.includes(conflictChild));
  assert.match(stackResult.content[0].text, /main/u);
});

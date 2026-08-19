import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerGraphiteTools } from "../dist/tools.js";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const SANDBOX_PREFIX = ".integration-";

/** Real Graphite work is slow, but a hang should fail here rather than time out the CI job. */
const SCENARIO_TIMEOUT_MS = 180_000;

// An interrupted run leaves a whole Git and Graphite repository behind, so clear stale
// sandboxes before starting instead of trusting the previous run's teardown.
for (const entry of await readdir(fixtureRoot)) {
  if (entry.startsWith(SANDBOX_PREFIX)) {
    await rm(join(fixtureRoot, entry), { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Porcelain status lines, keeping the two-column prefix that says staged from unstaged. */
function statusLines(cwd) {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function filesIn(cwd, branch) {
  const listing = run("git", ["ls-tree", "--name-only", "-r", branch], cwd);
  return listing ? listing.split("\n") : [];
}

/**
 * A fresh registration builds its own capability resolver, which is how a second process
 * reaching the same repository behaves.
 */
function registerInvoker(sandbox) {
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
  return (parameters) =>
    graphite.execute(`graphite-${++callId}`, parameters, undefined, undefined, context);
}

async function createGraphiteSandbox(t) {
  const sandbox = await mkdtemp(join(fixtureRoot, SANDBOX_PREFIX));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  run("git", ["init", "--initial-branch=main"], sandbox);
  run("git", ["config", "user.name", "Pi Graphite Test"], sandbox);
  run("git", ["config", "user.email", "pi-graphite@example.invalid"], sandbox);
  await writeFile(join(sandbox, "base.txt"), "base\n");
  run("git", ["add", "base.txt"], sandbox);
  run("git", ["commit", "-m", "Initial commit"], sandbox);
  run("gt", ["init", "--trunk", "main", "--no-interactive"], sandbox);

  return { sandbox, invoke: registerInvoker(sandbox) };
}

/** Graphite may prepend the user's configured prefix, so the created name is read back. */
async function createStackedBranch(sandbox, invoke, name, file) {
  await writeFile(join(sandbox, file), `${file}\n`);
  run("git", ["add", file], sandbox);
  const result = await invoke({
    operation: "create",
    name,
    subject: `Add ${file}`,
    body: `Add ${file} to the stack.`,
  });
  return result.details.after.branch;
}

async function trackedState(invoke) {
  const state = await invoke({ operation: "inspect", target: "state" });
  return JSON.parse(state.content[0].text);
}

function parentsOf(state, branch) {
  return state[branch].parents.map((entry) => entry.ref);
}

test("a stacked branch survives every local Graphite operation", {
  timeout: SCENARIO_TIMEOUT_MS,
}, async (t) => {
  const { sandbox, invoke } = await createGraphiteSandbox(t);

  const trunk = await invoke({ operation: "inspect", target: "trunk" });
  assert.equal(trunk.content[0].text, "main");

  // Only staged content may reach the commit; unstaged and untracked work stays put.
  await writeFile(join(sandbox, "one.txt"), "one\n");
  await writeFile(join(sandbox, "base.txt"), "base\nunstaged\n");
  await writeFile(join(sandbox, "untracked.txt"), "untracked\n");
  run("git", ["add", "one.txt"], sandbox);
  const firstCreate = await invoke({
    operation: "create",
    name: "feature/one",
    subject: "Add one",
    body: "Add the first stacked change.",
  });
  const firstBranch = firstCreate.details.after.branch;
  assert.deepEqual(filesIn(sandbox, firstBranch), ["base.txt", "one.txt"]);
  assert.equal(run("git", ["show", `${firstBranch}:one.txt`], sandbox), "one");
  assert.equal(run("git", ["show", `${firstBranch}:base.txt`], sandbox), "base");
  assert.equal(await readFile(join(sandbox, "base.txt"), "utf8"), "base\nunstaged\n");
  assert.equal(await readFile(join(sandbox, "untracked.txt"), "utf8"), "untracked\n");
  assert.deepEqual(statusLines(sandbox), [" M base.txt", "?? untracked.txt"]);

  await writeFile(join(sandbox, "base.txt"), "base\n");
  await rm(join(sandbox, "untracked.txt"));
  assert.deepEqual(statusLines(sandbox), []);

  const secondBranch = await createStackedBranch(sandbox, invoke, "feature/two", "two.txt");
  assert.equal(run("gt", ["parent", "--no-interactive"], sandbox), firstBranch);

  await invoke({ operation: "checkout", branch: firstBranch });
  assert.equal(run("git", ["branch", "--show-current"], sandbox), firstBranch);
  await invoke({ operation: "checkout", branch: secondBranch });
  assert.equal(run("git", ["branch", "--show-current"], sandbox), secondBranch);

  const beforeAmend = run("git", ["rev-parse", secondBranch], sandbox);
  await writeFile(join(sandbox, "two.txt"), "two amended\n");
  run("git", ["add", "two.txt"], sandbox);
  await invoke({ operation: "modify_amend" });
  assert.notEqual(run("git", ["rev-parse", secondBranch], sandbox), beforeAmend);
  assert.equal(run("git", ["show", `${secondBranch}:two.txt`], sandbox), "two amended");

  await writeFile(join(sandbox, "follow-up.txt"), "follow-up\n");
  run("git", ["add", "follow-up.txt"], sandbox);
  await invoke({
    operation: "modify_commit",
    subject: "Add follow-up",
    body: "Exercise an additional commit on the branch.",
  });
  assert.equal(run("git", ["show", `${secondBranch}:follow-up.txt`], sandbox), "follow-up");

  // Advance the parent behind Graphite's back so restack has real work to do.
  const originalParent = run("git", ["rev-parse", firstBranch], sandbox);
  const originalChild = run("git", ["rev-parse", secondBranch], sandbox);
  const originalChildPatch = run("git", ["diff", originalParent, originalChild], sandbox);
  run("git", ["checkout", firstBranch], sandbox);
  await writeFile(join(sandbox, "parent-later.txt"), "parent advanced\n");
  run("git", ["add", "parent-later.txt"], sandbox);
  run("git", ["commit", "-m", "Advance parent"], sandbox);
  const advancedParent = run("git", ["rev-parse", firstBranch], sandbox);
  assert.notEqual(run("git", ["merge-base", firstBranch, secondBranch], sandbox), advancedParent);
  run("git", ["checkout", secondBranch], sandbox);

  await invoke({ operation: "restack", branch: secondBranch });

  const restackedChild = run("git", ["rev-parse", secondBranch], sandbox);
  assert.notEqual(restackedChild, originalChild);
  assert.equal(run("git", ["merge-base", firstBranch, secondBranch], sandbox), advancedParent);
  assert.equal(run("git", ["diff", advancedParent, restackedChild], sandbox), originalChildPatch);
  assert.equal(
    run("git", ["show", `${secondBranch}:parent-later.txt`], sandbox),
    "parent advanced",
  );
  assert.equal(run("git", ["show", `${secondBranch}:two.txt`], sandbox), "two amended");

  await invoke({ operation: "move", source: secondBranch, onto: "main" });
  const parent = await invoke({ operation: "inspect", target: "parent" });
  assert.equal(parent.content[0].text, "main");

  const shortStack = await invoke({ operation: "inspect", target: "stack_short" });
  assert.ok(shortStack.content[0].text.includes(secondBranch));
  const state = await trackedState(invoke);
  assert.equal(state.main.trunk, true);
  assert.deepEqual(parentsOf(state, secondBranch), ["main"]);
  const info = await invoke({ operation: "inspect", target: "info" });
  assert.ok(info.content[0].text.includes(secondBranch));

  await invoke({ operation: "checkout", branch: "main" });
  const children = await invoke({ operation: "inspect", target: "children" });
  assert.ok(children.content[0].text.includes(firstBranch));
  assert.ok(children.content[0].text.includes(secondBranch));
  await invoke({ operation: "checkout", branch: secondBranch });

  assert.equal(run("git", ["rev-list", "--count", `main..${secondBranch}`], sandbox), "2");
  const squashedTree = run("git", ["rev-parse", "HEAD^{tree}"], sandbox);
  await invoke({
    operation: "squash",
    subject: "Add two with follow-up",
    // A body starting with `-` must stay message content instead of becoming an option.
    body: "- combine the branch into one commit",
  });
  assert.equal(run("git", ["rev-list", "--count", "main..HEAD"], sandbox), "1");
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"], sandbox), squashedTree);
  assert.equal(run("git", ["log", "-1", "--format=%s"], sandbox), "Add two with follow-up");
  assert.equal(
    run("git", ["log", "-1", "--format=%b"], sandbox),
    "- combine the branch into one commit",
  );

  const renamed = await invoke({ operation: "rename", name: "feature/renamed" });
  const renamedBranch = renamed.details.after.branch;
  assert.ok(renamedBranch.endsWith("feature/renamed"));
  assert.equal(run("git", ["branch", "--list", secondBranch], sandbox), "");
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"], sandbox), squashedTree);

  const foldableBranch = await createStackedBranch(
    sandbox,
    invoke,
    "feature/foldable",
    "foldable.txt",
  );
  const foldedTree = run("git", ["rev-parse", "HEAD^{tree}"], sandbox);
  const folded = await invoke({ operation: "fold" });
  assert.equal(folded.details.after.branch, renamedBranch);
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"], sandbox), foldedTree);
  assert.equal(run("git", ["branch", "--list", foldableBranch], sandbox), "");

  // firstBranch has no tracked children left, so this is the leaf delete case.
  await invoke({ operation: "delete", branch: firstBranch });
  assert.equal(run("git", ["branch", "--list", firstBranch], sandbox), "");
  assert.equal(run("git", ["branch", "--show-current"], sandbox), renamedBranch);
  assert.deepEqual(statusLines(sandbox), []);
});

test("moving and deleting a mid-stack branch carries its descendants", {
  timeout: SCENARIO_TIMEOUT_MS,
}, async (t) => {
  const { sandbox, invoke } = await createGraphiteSandbox(t);
  const lower = await createStackedBranch(sandbox, invoke, "feature/lower", "lower.txt");
  const middle = await createStackedBranch(sandbox, invoke, "feature/middle", "middle.txt");
  const upper = await createStackedBranch(sandbox, invoke, "feature/upper", "upper.txt");
  assert.deepEqual(parentsOf(await trackedState(invoke), upper), [middle]);

  // Moving the middle branch must drag the branch stacked on top of it.
  await invoke({ operation: "move", source: middle, onto: "main" });

  assert.equal(run("git", ["branch", "--show-current"], sandbox), upper);
  assert.deepEqual(statusLines(sandbox), []);
  const afterMove = await trackedState(invoke);
  assert.deepEqual(parentsOf(afterMove, middle), ["main"]);
  assert.deepEqual(parentsOf(afterMove, upper), [middle]);
  assert.deepEqual(filesIn(sandbox, upper), ["base.txt", "middle.txt", "upper.txt"]);
  assert.equal(
    run("git", ["merge-base", "--is-ancestor", "main", middle], sandbox),
    "",
    "middle must sit directly on the trunk",
  );

  // Deleting the middle branch re-parents the branch above it and drops its commits.
  await invoke({ operation: "delete", branch: middle });

  assert.equal(run("git", ["branch", "--list", middle], sandbox), "");
  assert.equal(run("git", ["branch", "--show-current"], sandbox), upper);
  assert.deepEqual(statusLines(sandbox), []);
  const afterDelete = await trackedState(invoke);
  assert.deepEqual(parentsOf(afterDelete, upper), ["main"]);
  assert.deepEqual(parentsOf(afterDelete, lower), ["main"]);
  assert.deepEqual(filesIn(sandbox, upper), ["base.txt", "upper.txt"]);
  assert.equal(run("git", ["show", `${upper}:upper.txt`], sandbox), "upper.txt");
});

test("preconditions reject unsafe requests without touching the repository", {
  timeout: SCENARIO_TIMEOUT_MS,
}, async (t) => {
  const { sandbox, invoke } = await createGraphiteSandbox(t);
  const branch = await createStackedBranch(sandbox, invoke, "feature/only", "only.txt");
  const head = run("git", ["rev-parse", "HEAD"], sandbox);

  const rejections = [
    [
      "an invalid Git ref name",
      {
        operation: "create",
        name: "feature.lock",
        subject: "Reject an invalid ref name",
        body: "Real git must refuse this name.",
      },
      /name is not a valid Git branch name/u,
    ],
    [
      "a branch that was never created",
      { operation: "checkout", branch: "feature/never-created" },
      /branch does not name an existing local branch/u,
    ],
    [
      "deleting the checked-out branch",
      { operation: "delete", branch },
      /delete cannot remove .* while it is checked out/u,
    ],
    [
      "deleting the trunk",
      { operation: "delete", branch: "main" },
      /delete cannot remove the trunk branch "main"/u,
    ],
    [
      "a move onto itself",
      { operation: "move", source: branch, onto: branch },
      /must name different local branches/u,
    ],
    [
      "a commit with nothing staged",
      { operation: "create", name: "feature/empty", subject: "Nothing", body: "Nothing staged." },
      /requires deliberately staged changes/u,
    ],
  ];

  for (const [label, parameters, expectedError] of rejections) {
    await assert.rejects(invoke(parameters), expectedError, label);
    assert.equal(run("git", ["branch", "--show-current"], sandbox), branch, label);
    assert.equal(run("git", ["rev-parse", "HEAD"], sandbox), head, label);
    assert.deepEqual(statusLines(sandbox), [], label);
  }

  await writeFile(join(sandbox, "dirty.txt"), "dirty\n");
  await assert.rejects(
    invoke({ operation: "checkout", branch: "main" }),
    /checkout requires a clean worktree/u,
  );
  assert.equal(run("git", ["branch", "--show-current"], sandbox), branch);
  await rm(join(sandbox, "dirty.txt"));
  assert.deepEqual(statusLines(sandbox), []);
});

test("a restack halted by a conflict can be aborted and resumed", {
  timeout: SCENARIO_TIMEOUT_MS,
}, async (t) => {
  const { sandbox, invoke } = await createGraphiteSandbox(t);

  await writeFile(join(sandbox, "conflict.txt"), "parent\n");
  run("git", ["add", "conflict.txt"], sandbox);
  const conflictParent = (
    await invoke({
      operation: "create",
      name: "conflict/parent",
      subject: "Add conflict base",
      body: "Prepare conflict recovery coverage.",
    })
  ).details.after.branch;

  await writeFile(join(sandbox, "conflict.txt"), "child\n");
  run("git", ["add", "conflict.txt"], sandbox);
  const conflictChild = (
    await invoke({
      operation: "create",
      name: "conflict/child",
      subject: "Change conflict child",
      body: "Prepare conflict recovery coverage.",
    })
  ).details.after.branch;

  run("git", ["checkout", conflictParent], sandbox);
  await writeFile(join(sandbox, "conflict.txt"), "parent advanced\n");
  run("git", ["add", "conflict.txt"], sandbox);
  run("git", ["commit", "-m", "Advance conflicting parent"], sandbox);
  run("git", ["checkout", conflictChild], sandbox);

  await assert.rejects(
    invoke({ operation: "restack", branch: conflictChild }),
    /Graphite restack failed/u,
  );
  await invoke({ operation: "abort" });
  assert.deepEqual(statusLines(sandbox), []);
  assert.equal(run("git", ["branch", "--show-current"], sandbox), conflictChild);

  await assert.rejects(
    invoke({ operation: "restack", branch: conflictChild }),
    /Graphite restack failed/u,
  );
  await writeFile(join(sandbox, "conflict.txt"), "resolved\n");
  run("git", ["add", "conflict.txt"], sandbox);
  await invoke({ operation: "continue" });
  assert.deepEqual(statusLines(sandbox), []);
  assert.equal(await readFile(join(sandbox, "conflict.txt"), "utf8"), "resolved\n");

  const stack = await invoke({ operation: "inspect", target: "stack" });
  assert.ok(stack.content[0].text.includes(conflictChild));
  assert.match(stack.content[0].text, /main/u);
});

test("the on-disk capability cache is reused and re-detected when its trunk goes stale", {
  timeout: SCENARIO_TIMEOUT_MS,
}, async (t) => {
  const { sandbox, invoke } = await createGraphiteSandbox(t);
  const cachePath = join(sandbox, ".git", "pi-graphite.json");
  const inspectTrunk = () => invoke({ operation: "inspect", target: "trunk" });

  const written = await inspectTrunk();
  assert.equal(written.details.capability.cache, "written");
  assert.equal(written.details.capability.trunk, "main");
  assert.equal(written.details.capability.gtVersion, "1.8.6");
  const stored = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.usesGraphite, true);
  assert.equal(stored.trunk, "main");
  assert.equal(stored.repositoryRoot, written.details.capability.repositoryRoot);

  const remembered = await inspectTrunk();
  assert.equal(remembered.details.capability.cache, "memory");

  // A separate registration has an empty memory cache, so it must read what was written
  // and re-verify the stored trunk against real Git.
  const reopened = await registerInvoker(sandbox)({ operation: "inspect", target: "trunk" });
  assert.equal(reopened.details.capability.cache, "persistent");
  assert.equal(reopened.details.capability.trunk, "main");

  // A trunk that no longer exists must fall back to detection instead of failing the call.
  await writeFile(cachePath, JSON.stringify({ ...stored, trunk: "renamed-away" }));
  const redetected = await registerInvoker(sandbox)({ operation: "inspect", target: "trunk" });
  assert.equal(redetected.details.capability.cache, "written");
  assert.equal(redetected.details.capability.trunk, "main");
  assert.equal(JSON.parse(await readFile(cachePath, "utf8")).trunk, "main");
});

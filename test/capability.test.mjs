import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GraphiteCapabilityResolver, GraphiteUnavailableError } from "../dist/capability.js";
import { CommandCancelledError } from "../dist/process.js";

async function createRepositoryFixture(t) {
  const sandbox = await mkdtemp(join(process.cwd(), "test/.capability-"));
  const root = join(sandbox, "repo");
  const gitDir = join(root, ".git");
  await mkdir(gitDir, { recursive: true });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return { root, gitDir };
}

test("a successful detection writes and reuses repository-local capability state", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      return {
        command,
        args,
        exitCode: 0,
        stdout: `${root}\n${gitDir}\n`,
        stderr: "",
      };
    }
    if (args[0] === "--version") {
      return { command, args, exitCode: 0, stdout: "1.8.6\n", stderr: "" };
    }
    return { command, args, exitCode: 0, stdout: "main\n", stderr: "" };
  };
  const resolver = new GraphiteCapabilityResolver(runner);

  const first = await resolver.ensure(root);
  assert.equal(first.cache, "written");
  assert.equal(first.trunk, "main");
  assert.equal(first.gtVersion, "1.8.6");
  assert.deepEqual(calls, [
    ["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"],
    ["gt", "--version"],
    ["gt", "trunk", "--no-interactive"],
  ]);

  const stored = JSON.parse(await readFile(join(gitDir, "pi-graphite.json"), "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.usesGraphite, true);
  assert.equal(stored.repositoryRoot, root);
  assert.equal(stored.trunk, "main");

  const remembered = await resolver.ensure(root);
  assert.equal(remembered.cache, "memory");
  assert.equal(calls.length, 3);

  resolver.clearMemory();
  const persisted = await resolver.ensure(root);
  assert.equal(persisted.cache, "persistent");
  assert.deepEqual(calls.at(-1), ["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  assert.equal(calls.filter(([command]) => command === "gt").length, 2);
});

test("detection rejects directories outside a Git worktree", async (t) => {
  const { root } = await createRepositoryFixture(t);
  const runner = async (command, args) => ({
    command,
    args,
    exitCode: 128,
    stdout: "",
    stderr: "fatal: not a git repository",
  });
  const resolver = new GraphiteCapabilityResolver(runner);

  await assert.rejects(
    resolver.ensure(root),
    (error) =>
      error instanceof GraphiteUnavailableError && error.message.includes("require a Git worktree"),
  );
});

test("detection explains how to initialize a plain Git repository", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const runner = async (command, args) => {
    if (command === "git") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    if (args[0] === "--version") {
      return { command, args, exitCode: 0, stdout: "1.8.6\n", stderr: "" };
    }
    return {
      command,
      args,
      exitCode: 1,
      stdout: "",
      stderr: "Graphite is not initialized",
    };
  };
  const resolver = new GraphiteCapabilityResolver(runner);

  await assert.rejects(
    resolver.ensure(root),
    (error) =>
      error instanceof GraphiteUnavailableError &&
      error.message.includes("Run `gt init`") &&
      error.message.includes("Graphite is not initialized"),
  );
});

test("detection preserves cancellation", async (t) => {
  const { root } = await createRepositoryFixture(t);
  const resolver = new GraphiteCapabilityResolver(async () => {
    throw new CommandCancelledError("git");
  });

  await assert.rejects(resolver.ensure(root), CommandCancelledError);
});

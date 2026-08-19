import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GraphiteCapabilityResolver, GraphiteUnavailableError } from "../dist/capability.js";
import { CommandCancelledError, CommandInvocationError } from "../dist/process.js";

async function createRepositoryFixture(t) {
  const sandbox = await mkdtemp(join(process.cwd(), "test/.capability-"));
  const root = join(sandbox, "repo");
  const gitDir = join(root, ".git");
  await mkdir(gitDir, { recursive: true });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return { root, gitDir };
}

function createDetectionRunner(root, gitDir, gt = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    if (args[0] === "--version") {
      return { command, args, exitCode: 0, stdout: "1.8.6\n", stderr: "", ...gt.version };
    }
    return { command, args, exitCode: 0, stdout: "main\n", stderr: "", ...gt.trunk };
  };
  return { calls, runner };
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
    ["git", "check-ref-format", "--branch", "main"],
    ["git", "show-ref", "--verify", "--quiet", "refs/heads/main"],
  ]);

  const stored = JSON.parse(await readFile(join(gitDir, "pi-graphite.json"), "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.usesGraphite, true);
  assert.equal(stored.repositoryRoot, root);
  assert.equal(stored.trunk, "main");

  const remembered = await resolver.ensure(root);
  assert.equal(remembered.cache, "memory");
  assert.equal(calls.length, 5);

  resolver.clearMemory();
  const persisted = await resolver.ensure(root);
  assert.equal(persisted.cache, "persistent");
  assert.deepEqual(calls.slice(5), [
    ["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"],
    ["git", "check-ref-format", "--branch", "main"],
    ["git", "show-ref", "--verify", "--quiet", "refs/heads/main"],
  ]);
  assert.equal(calls.filter(([command]) => command === "gt").length, 2);
});

test("a cached trunk that no longer exists triggers detection again", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const calls = [];
  let trunkExists = false;
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "show-ref" && !trunkExists) {
      return { command, args, exitCode: 1, stdout: "", stderr: "missing ref" };
    }
    if (command === "gt" && args[0] === "--version") {
      return { command, args, exitCode: 0, stdout: "1.8.6\n", stderr: "" };
    }
    return { command, args, exitCode: 0, stdout: "main\n", stderr: "" };
  };
  await writeFile(
    join(gitDir, "pi-graphite.json"),
    JSON.stringify({
      schemaVersion: 1,
      usesGraphite: true,
      repositoryRoot: root,
      gtVersion: "1.8.6",
      trunk: "main",
      verifiedAt: new Date().toISOString(),
    }),
  );

  const resolver = new GraphiteCapabilityResolver(runner);
  await assert.rejects(resolver.ensure(root), GraphiteUnavailableError);
  assert.deepEqual(
    calls.filter(([command]) => command === "gt"),
    [
      ["gt", "--version"],
      ["gt", "trunk", "--no-interactive"],
    ],
  );

  trunkExists = true;
  resolver.clearMemory();
  const detected = await resolver.ensure(root);
  assert.equal(detected.cache, "persistent");
  assert.equal(detected.trunk, "main");
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

test("detection rejects malformed absolute repository paths", async (t) => {
  const { root } = await createRepositoryFixture(t);
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    return {
      command,
      args,
      exitCode: 0,
      stdout: `${root}\nrelative-git-dir\n`,
      stderr: "",
    };
  };

  await assert.rejects(
    new GraphiteCapabilityResolver(runner).ensure(root),
    (error) =>
      error instanceof GraphiteUnavailableError &&
      error.message.includes("invalid repository location"),
  );
  assert.deepEqual(calls, [["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"]]);
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

test("detection rejects a configured trunk without a local branch", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const runner = async (command, args) => {
    if (command === "gt") {
      const stdout = args[0] === "--version" ? "1.8.6\n" : "missing-trunk\n";
      return { command, args, exitCode: 0, stdout, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    if (args[0] === "show-ref") {
      return { command, args, exitCode: 1, stdout: "", stderr: "missing ref" };
    }
    return { command, args, exitCode: 0, stdout: "missing-trunk\n", stderr: "" };
  };

  await assert.rejects(
    new GraphiteCapabilityResolver(runner).ensure(root),
    (error) =>
      error instanceof GraphiteUnavailableError &&
      error.message.includes("not an existing local branch"),
  );
});

test("detection preserves cancellation", async (t) => {
  const { root } = await createRepositoryFixture(t);
  const resolver = new GraphiteCapabilityResolver(async () => {
    throw new CommandCancelledError("git");
  });

  await assert.rejects(resolver.ensure(root), CommandCancelledError);
});

test("malformed, incompatible, and expired caches trigger detection and rewrite", async (t) => {
  const cases = [
    ["malformed", () => "{not-json\n"],
    [
      "wrong schema",
      (root) =>
        `${JSON.stringify({
          schemaVersion: 0,
          usesGraphite: true,
          repositoryRoot: root,
          gtVersion: "stale-version",
          trunk: "stale-trunk",
          verifiedAt: "2020-01-01T00:00:00.000Z",
        })}\n`,
    ],
    [
      "incompatible version",
      (root) =>
        `${JSON.stringify({
          schemaVersion: 1,
          usesGraphite: true,
          repositoryRoot: root,
          gtVersion: "2.0.0",
          trunk: "main",
          verifiedAt: new Date().toISOString(),
        })}\n`,
    ],
    [
      "future dated",
      (root) =>
        `${JSON.stringify({
          schemaVersion: 1,
          usesGraphite: true,
          repositoryRoot: root,
          gtVersion: "1.8.6",
          trunk: "main",
          verifiedAt: "2999-01-01T00:00:00.000Z",
        })}\n`,
    ],
    [
      "expired",
      (root) =>
        `${JSON.stringify({
          schemaVersion: 1,
          usesGraphite: true,
          repositoryRoot: root,
          gtVersion: "1.8.6",
          trunk: "main",
          verifiedAt: "2020-01-01T00:00:00.000Z",
        })}\n`,
    ],
  ];

  for (const [label, cacheContent] of cases) {
    const { root, gitDir } = await createRepositoryFixture(t);
    const cachePath = join(gitDir, "pi-graphite.json");
    await writeFile(cachePath, cacheContent(root));
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git") {
        return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
      }
      if (args[0] === "--version") {
        return { command, args, exitCode: 0, stdout: "1.8.6\n", stderr: "" };
      }
      return { command, args, exitCode: 0, stdout: "main\n", stderr: "" };
    };

    const capability = await new GraphiteCapabilityResolver(runner).ensure(root);
    assert.equal(capability.cache, "written", label);
    assert.deepEqual(
      calls.filter(([command]) => command === "gt"),
      [
        ["gt", "--version"],
        ["gt", "trunk", "--no-interactive"],
      ],
      label,
    );
    const rewritten = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(rewritten.schemaVersion, 1, label);
    assert.equal(rewritten.gtVersion, "1.8.6", label);
    assert.equal(rewritten.trunk, "main", label);
  }
});

test("cache write failure preserves successful capability detection", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  await mkdir(join(gitDir, "pi-graphite.json"));
  const runner = async (command, args) => {
    if (command === "git") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    if (args[0] === "--version") {
      return { command, args, exitCode: 0, stdout: "1.8.6\n", stderr: "" };
    }
    return { command, args, exitCode: 0, stdout: "main\n", stderr: "" };
  };

  const capability = await new GraphiteCapabilityResolver(runner).ensure(root);

  assert.equal(capability.gtVersion, "1.8.6");
  assert.equal(capability.trunk, "main");
  assert.equal(capability.cache, "unavailable");
  assert.match(capability.cacheWarning, /repository cache could not be written/u);
});

test("detection rejects unsupported Graphite CLI versions before repository access", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    return { command, args, exitCode: 0, stdout: "2.0.0\n", stderr: "" };
  };

  await assert.rejects(
    new GraphiteCapabilityResolver(runner).ensure(root),
    (error) =>
      error instanceof GraphiteUnavailableError &&
      error.message.includes("1.8.6 is required") &&
      error.message.includes("2.0.0"),
  );
  assert.deepEqual(calls, [
    ["git", "rev-parse", "--show-toplevel", "--absolute-git-dir"],
    ["gt", "--version"],
  ]);
});

test("a Graphite CLI that cannot be started is reported as missing from PATH", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const runner = async (command, args) => {
    if (command === "git") {
      return { command, args, exitCode: 0, stdout: `${root}\n${gitDir}\n`, stderr: "" };
    }
    throw new CommandInvocationError(
      command,
      `Unable to execute ${command}: spawn ${command} ENOENT`,
      "ENOENT",
    );
  };

  await assert.rejects(
    new GraphiteCapabilityResolver(runner).ensure(root),
    (error) => error instanceof GraphiteUnavailableError && /on PATH/u.test(error.message),
  );
});

test("detection accepts the version formats the Graphite CLI prints", async (t) => {
  const cases = [
    ["gt version prefix on stdout", { stdout: "gt version 1.8.6\n" }],
    ["bare version on stderr", { stdout: "", stderr: "1.8.6\n" }],
  ];

  for (const [label, version] of cases) {
    const { root, gitDir } = await createRepositoryFixture(t);
    const { runner } = createDetectionRunner(root, gitDir, { version });

    const capability = await new GraphiteCapabilityResolver(runner).ensure(root);

    assert.equal(capability.gtVersion, "1.8.6", label);
    assert.equal(capability.trunk, "main", label);
  }
});

test("detection rejects trunk output that is not a single bare branch name", async (t) => {
  const cases = [
    ["extra line", { stdout: "main\nextra\n" }],
    ["leading padding", { stdout: "  main\n" }],
  ];

  for (const [label, trunk] of cases) {
    const { root, gitDir } = await createRepositoryFixture(t);
    const { calls, runner } = createDetectionRunner(root, gitDir, { trunk });

    await assert.rejects(
      new GraphiteCapabilityResolver(runner).ensure(root),
      (error) =>
        error instanceof GraphiteUnavailableError &&
        /invalid repository trunk/u.test(error.message),
      label,
    );
    assert.deepEqual(
      calls.filter(([, arg]) => arg === "check-ref-format"),
      [],
      label,
    );
  }
});

test("forget from a subdirectory also clears the entry cached under the repository root", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const subdirectory = join(root, "packages/app");
  const { runner } = createDetectionRunner(root, gitDir);
  const resolver = new GraphiteCapabilityResolver(runner);
  await resolver.ensure(subdirectory);
  assert.equal((await resolver.ensure(root)).cache, "memory");

  resolver.forget(subdirectory);

  assert.equal((await resolver.ensure(root)).cache, "persistent");
});

test("forget from the repository root also clears the entry cached under a subdirectory", async (t) => {
  const { root, gitDir } = await createRepositoryFixture(t);
  const subdirectory = join(root, "packages/app");
  const { runner } = createDetectionRunner(root, gitDir);
  const resolver = new GraphiteCapabilityResolver(runner);
  await resolver.ensure(subdirectory);
  assert.equal((await resolver.ensure(subdirectory)).cache, "memory");

  resolver.forget(root);

  assert.equal((await resolver.ensure(subdirectory)).cache, "persistent");
});

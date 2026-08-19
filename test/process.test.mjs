import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandCancelledError,
  CommandInvocationError,
  CommandOutputLimitError,
  runChecked,
  runCommand,
} from "../dist/process.js";

const cwd = process.cwd();

test("runCommand captures stdout, stderr, and a nonzero exit", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;'],
    { cwd },
  );

  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  await assert.rejects(
    runChecked(async () => result, "gt", ["trunk"], { cwd }, "Graphite command failed"),
    /Graphite command failed \(exit 7\)\.\nerr\nout/u,
  );
});

test("runCommand terminates an aborted child", async () => {
  const controller = new AbortController();
  const result = runCommand(
    process.execPath,
    ["-e", "setTimeout(() => process.stdout.write('late'), 10_000)"],
    { cwd, signal: controller.signal },
  );

  setTimeout(() => controller.abort(), 25);
  await assert.rejects(result, CommandCancelledError);
});

test("runCommand rejects an already-aborted invocation", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runCommand(process.execPath, ["--version"], { cwd, signal: controller.signal }),
    CommandCancelledError,
  );
});

test("runCommand reports a missing executable as an invocation failure", async () => {
  await assert.rejects(
    runCommand("pi-graphite-missing-binary", [], { cwd }),
    (error) =>
      error instanceof CommandInvocationError &&
      error.code === "ENOENT" &&
      /^Unable to execute pi-graphite-missing-binary: /u.test(error.message),
  );
});

test("output larger than the limit is reported as a size failure, not a broken executable", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(200_000))"], {
      cwd,
      maxOutputBytes: 1024,
    }),
    (error) => {
      // A `git diff --binary` or a deep `gt log` can outgrow the limit; blaming PATH would
      // send the caller after the wrong problem.
      assert.ok(error instanceof CommandOutputLimitError);
      assert.ok(!(error instanceof CommandInvocationError));
      assert.equal(error.maxOutputBytes, 1024);
      assert.match(error.message, /produced more than 1024 bytes of output and was stopped/u);
      return true;
    },
  );
});

test("output within the limit is captured whole", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1000))"],
    { cwd, maxOutputBytes: 1024 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 1000);
});

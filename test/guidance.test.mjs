import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPHITE_PROMPT_NOTE } from "../dist/guidance.js";
import { registerGraphiteTools } from "../dist/tools.js";

const capability = { repository: { root: "/virtual/repository" }, trunk: "main", cache: "memory" };

function registerWith(tryEnsure) {
  const calls = [];
  let handler;
  const tools = [];
  registerGraphiteTools(
    {
      registerTool(definition) {
        tools.push(definition.name);
      },
      on(event, registered) {
        assert.equal(event, "before_agent_start");
        handler = registered;
      },
    },
    {
      runner: async () => {
        throw new Error("the guidance handler must not run commands itself");
      },
      capabilities: {
        async tryEnsure(cwd, signal) {
          calls.push([cwd, signal]);
          return tryEnsure(cwd);
        },
      },
    },
  );
  assert.deepEqual(tools, ["graphite"]);
  assert.equal(typeof handler, "function");
  return { calls, handler };
}

test("a Graphite repository appends the note once", async () => {
  const { calls, handler } = registerWith(() => capability);
  const signal = new AbortController().signal;

  const result = await handler({ systemPrompt: "Base prompt." }, { cwd: "/repo/sub", signal });
  assert.equal(result.systemPrompt, `Base prompt.\n\n${GRAPHITE_PROMPT_NOTE}`);
  assert.deepEqual(calls, [["/repo/sub", signal]]);

  assert.equal(
    await handler({ systemPrompt: result.systemPrompt }, { cwd: "/repo/sub", signal }),
    undefined,
  );
  assert.equal(calls.length, 1);
});

test("a repository without Graphite keeps the prompt unchanged", async () => {
  const { calls, handler } = registerWith(() => undefined);

  assert.equal(await handler({ systemPrompt: "Base prompt." }, { cwd: "/repo" }), undefined);
  assert.deepEqual(calls, [["/repo", undefined]]);
});

test("a missing context falls back to the process directory", async () => {
  const { calls, handler } = registerWith(() => undefined);

  assert.equal(await handler({ systemPrompt: "Base prompt." }), undefined);
  assert.deepEqual(calls, [[process.cwd(), undefined]]);
});

test("a prompt without text is left alone", async () => {
  const { calls, handler } = registerWith(() => capability);

  assert.equal(await handler({}, { cwd: "/repo" }), undefined);
  assert.equal(await handler(undefined, { cwd: "/repo" }), undefined);
  assert.deepEqual(calls, []);
});

test("a host without the event still registers the tool", () => {
  const tools = [];
  registerGraphiteTools(
    {
      registerTool(definition) {
        tools.push(definition.name);
      },
    },
    { capabilities: { async tryEnsure() {} } },
  );
  assert.deepEqual(tools, ["graphite"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientWaitError, waitUntilMail } from "./wait-loop.ts";
import type { WaitResult } from "../shared/types.ts";

function idle(): WaitResult {
  return { idle: true, you: {} as WaitResult["you"], control: [], mentions: [], messages: [] };
}

function mail(): WaitResult {
  return {
    idle: false,
    you: {} as WaitResult["you"],
    control: [],
    mentions: [],
    messages: [{ id: "m1" } as WaitResult["messages"][number]],
  };
}

test("waitUntilMail does not return idle to the model", async () => {
  let calls = 0;
  const result = await waitUntilMail(async () => {
    calls += 1;
    if (calls < 3) return idle();
    return mail();
  });
  assert.equal(calls, 3);
  assert.equal(result.idle, false);
  assert.equal(result.messages.length, 1);
});

test("waitUntilMail retries fetch failed without throwing", async () => {
  let calls = 0;
  const result = await waitUntilMail(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return mail();
    },
    { delay: async () => undefined },
  );
  assert.equal(calls, 2);
  assert.equal(result.idle, false);
});

test("auth errors are not swallowed", async () => {
  await assert.rejects(
    () => waitUntilMail(async () => {
      throw new Error("Join first with the join tool.");
    }),
    /Join first/,
  );
  assert.equal(isTransientWaitError(new Error("HTTP 401")), false);
  assert.equal(isTransientWaitError(new Error("fetch failed")), true);
});

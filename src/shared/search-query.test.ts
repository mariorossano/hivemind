import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiveSearchQuery, likeNeedle, parseSearchQuery, snippetAround } from "./search-query.ts";

test("search query keeps quoted phrases and caps tokens", () => {
  assert.deepEqual(parseSearchQuery("  oauth login  "), ["oauth", "login"]);
  assert.deepEqual(parseSearchQuery(`report "feat/login" Forge`), ["report", "feat/login", "Forge"]);
  assert.deepEqual(parseSearchQuery(`report "feat/login`), ["report", "feat/login"]);
  assert.deepEqual(parseSearchQuery(""), []);
  assert.equal(parseSearchQuery("a ".repeat(20)).length, 8);
});

test("live search waits for two ASCII chars but accepts a seq or a mark", () => {
  assert.equal(isLiveSearchQuery(""), false);
  assert.equal(isLiveSearchQuery("a"), false);
  assert.equal(isLiveSearchQuery("oa"), true);
  assert.equal(isLiveSearchQuery("3"), true);
  assert.equal(isLiveSearchQuery("✅"), true);
  assert.equal(isLiveSearchQuery("你"), true);
});

test("LIKE needles escape wildcards; snippets sit on the first hit", () => {
  assert.equal(likeNeedle("100%_"), "%100\\%\\_%");
  assert.equal(snippetAround("short", ["x"]), "short");
  const body = `${"pad ".repeat(40)}oauth token here ${"z".repeat(80)}`;
  const snip = snippetAround(body, ["oauth"]);
  assert.ok(snip.includes("oauth"));
  assert.ok(snip.startsWith("…"));
});

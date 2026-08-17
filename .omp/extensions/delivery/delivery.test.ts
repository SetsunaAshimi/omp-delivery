import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BudgetTracker,
  estimateTokens,
  truncateString,
  truncateToolResults,
} from "./budget.ts";
import { TodoCache } from "./todo-cache.ts";
import { parseJudgeJson } from "./judge.ts";
import { parseFlatYaml } from "./config.ts";
import type { ToolResultEntry } from "./types.ts";

const logger = { warn: (_: string) => {}, error: (_: string) => {} };

// ---- budget.ts ----
test("BudgetTracker accumulates usage across calls", () => {
  const b = new BudgetTracker();
  b.addUsage("s1", 100);
  b.addUsage("s1", 50);
  assert.equal(b.getUsage("s1"), 150);
  assert.equal(b.getUsage("s2"), 0);
});

test("BudgetTracker detects exhaustion against limit", () => {
  const b = new BudgetTracker();
  b.addUsage("s1", 200);
  assert.equal(b.isExhausted("s1", 200), true);
  assert.equal(b.isExhausted("s1", 201), false);
});

test("BudgetTracker clears per session", () => {
  const b = new BudgetTracker();
  b.addUsage("s1", 100);
  b.addUsage("s2", 50);
  b.clear("s1");
  assert.equal(b.getUsage("s1"), 0);
  assert.equal(b.getUsage("s2"), 50);
});

test("estimateTokens rounds up char/4", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("ab"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("truncateString returns short string unchanged", () => {
  assert.equal(truncateString("short", 100), "short");
});

test("truncateString truncates long string head+tail with marker", () => {
  const out = truncateString("a".repeat(1000), 100);
  assert.ok(out.includes("[...truncated...]"));
  assert.ok(out.length < 1000);
  assert.ok(out.startsWith("a"));
  assert.ok(out.endsWith("a"));
});

test("truncateToolResults drops oldest over budget", () => {
  const results: ToolResultEntry[] = [
    { toolName: "edit", content: "x".repeat(100), isError: false },
    { toolName: "bash", content: "y".repeat(100), isError: true },
  ];
  const out = truncateToolResults(results, 30, 200);
  assert.equal(out.length, 1);
  assert.equal(out[0].toolName, "bash");
});

// ---- todo-cache.ts ----
test("TodoCache.isAllDone returns false for null/empty phases", () => {
  assert.equal(TodoCache.isAllDone(null), false);
  assert.equal(TodoCache.isAllDone([]), false);
});

test("TodoCache.isAllDone returns false if any pending", () => {
  assert.equal(
    TodoCache.isAllDone([
      { name: "p", tasks: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ] },
    ]),
    false,
  );
});

test("TodoCache.isAllDone returns true when all completed or abandoned", () => {
  assert.equal(
    TodoCache.isAllDone([
      { name: "p", tasks: [
        { content: "a", status: "completed" },
        { content: "b", status: "abandoned" },
      ] },
    ]),
    true,
  );
});

test("TodoCache.getPendingItems returns pending/in_progress/blocked only", () => {
  const items = TodoCache.getPendingItems([
    { name: "p", tasks: [
      { content: "done", status: "completed" },
      { content: "pend", status: "pending" },
      { content: "ip", status: "in_progress" },
      { content: "blk", status: "blocked" },
      { content: "abn", status: "abandoned" },
    ] },
  ]);
  assert.deepEqual(items, ["pend", "ip", "blk"]);
});

test("TodoCache.getPendingItems returns empty for null", () => {
  assert.deepEqual(TodoCache.getPendingItems(null), []);
});

test("TodoCache ignores non-todo toolNames", () => {
  const c = new TodoCache();
  c.update("s", "read", { phases: [] });
  assert.equal(c.get("s").hasTodos, false);
});

test("TodoCache ignores details without phases array", () => {
  const c = new TodoCache();
  c.update("s", "todo", { op: "view" });
  assert.equal(c.get("s").hasTodos, false);
});

test("TodoCache caches phases", () => {
  const c = new TodoCache();
  c.update("s", "todo", { phases: [{ name: "p", tasks: [{ content: "t", status: "completed" }] }] });
  const snap = c.get("s");
  assert.equal(snap.hasTodos, true);
  assert.equal(snap.phases?.[0].tasks[0].content, "t");
});

test("TodoCache clears snapshot", () => {
  const c = new TodoCache();
  c.update("s", "todo", { phases: [{ name: "p", tasks: [] }] });
  c.clear("s");
  assert.equal(c.get("s").hasTodos, false);
});

// ---- judge.ts ----
test("parseJudgeJson parses clean JSON", () => {
  const r = parseJudgeJson('{"decision":"done","confidence":"high","reason":"ok","issues":[]}', logger);
  assert.equal(r?.decision, "done");
  assert.equal(r?.confidence, "high");
});

test("parseJudgeJson strips markdown fences", () => {
  const r = parseJudgeJson('```json\n{"decision":"continue","confidence":"medium","reason":"x","issues":[]}\n```', logger);
  assert.equal(r?.decision, "continue");
});

test("parseJudgeJson tolerates prose around JSON", () => {
  const r = parseJudgeJson('Here is my verdict: {"decision":"need_user","confidence":"low","reason":"y","issues":[]} done.', logger);
  assert.equal(r?.decision, "need_user");
});

test("parseJudgeJson forces need_user on low confidence", () => {
  const r = parseJudgeJson('{"decision":"done","confidence":"low","reason":"y","issues":[]}', logger);
  assert.equal(r?.decision, "need_user");
});

test("parseJudgeJson rejects invalid decision enum", () => {
  assert.equal(parseJudgeJson('{"decision":"maybe","confidence":"high","reason":"","issues":[]}', logger), null);
});

test("parseJudgeJson rejects invalid confidence enum", () => {
  assert.equal(parseJudgeJson('{"decision":"done","confidence":"maybe","reason":"","issues":[]}', logger), null);
});

test("parseJudgeJson returns null on garbage", () => {
  assert.equal(parseJudgeJson("no json here", logger), null);
});

test("parseJudgeJson defaults missing reason/issues", () => {
  const r = parseJudgeJson('{"decision":"done","confidence":"high"}', logger);
  assert.equal(r?.reason, "");
  assert.deepEqual(r?.issues, []);
});

// ---- config.ts ----
test("parseFlatYaml parses key: value lines", () => {
  const o = parseFlatYaml('a: 1\nb: "two"\nc: true');
  assert.equal(o.a, "1");
  assert.equal(o.b, '"two"'); // quotes preserved by parser; stripQuotes is coerce's job
  assert.equal(o.c, "true");
});

test("parseFlatYaml skips blank and comment lines", () => {
  const o = parseFlatYaml('# header\n\na: 1\n  # indented comment');
  assert.deepEqual(o, { a: "1" });
});

test("parseFlatYaml strips inline comments outside quotes", () => {
  const o = parseFlatYaml('a: 1 # comment');
  assert.equal(o.a, "1");
});

test("parseFlatYaml preserves # inside quotes (double)", () => {
  const o = parseFlatYaml('a: "val#ue" # comment');
  assert.equal(o.a, '"val#ue"'); // quote-stripping is coerce's job; parser keeps raw
});

test("parseFlatYaml preserves # inside quotes (single)", () => {
  const o = parseFlatYaml("a: 'val#ue' # comment");
  assert.equal(o.a, "'val#ue'");
});

test("parseFlatYaml preserves # inside quotes mid-line", () => {
  const o = parseFlatYaml('a: "x#y#z" # trailing');
  assert.equal(o.a, '"x#y#z"');
});

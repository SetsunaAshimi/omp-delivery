# Delivery Extension — Implementation Spec

## Purpose

An omp extension that judges whether the main agent session has truly completed the user's task. It hooks into `session_stop`, collects evidence (tool_results, todo state, test results, original userInput), sends a compressed bundle to an independent judge LLM, and returns a JSON verdict: `done`, `continue`, or `need_user`.

## 16 Locked Design Decisions

### Q1: Evidence window
- Take all `tool_result` messages from the current continue-interval (since last `session_stop` continue, or session start).
- Include original userInput (cached from `input` event).
- Include current todo snapshot (cached from `tool_result` where toolName="todo").
- Compression: truncate each tool_result content to 2000 chars (head 1000 + tail 500 + `[...truncated...]` marker). No secondary summarization LLM.

### Q2: Verdict priority (deterministic, computed by extension code — NOT the LLM)
1. If testCommand configured AND test exit != 0 → `continue` (test failed)
2. If todo was used AND any todo status != "completed" and != "abandoned" → `continue` (todos pending)
3. If test passes (or no test) AND todos all done (or no todos) → ask judge LLM: "does the work satisfy userInput?"
4. Judge returns done/continue/need_user + confidence + issues

### Q3: "deviation" = userInput explicit constraints + todo plan
- Judge detects: agent's actual work contradicts userInput constraints, or todos were silently deleted/modified.
- Low confidence → forced to `need_user` by extension code (LLM cannot override).
- Does NOT check architecture conventions (out of scope).

### Q4: Test execution
- Config: `testCommand` (string) + `testTimeout` (seconds, default 120) in `delivery-config.yml`.
- Run via `pi.exec()` or `Bun.spawn()`. exit 0 = pass, non-0 = fail, timeout = need_user.
- No testCommand → skip test criterion (degrade gracefully).

### Q5: Judge model configuration
- Config field `judgeModel` in `delivery-config.yml` (string, e.g. "anthropic/claude-sonnet-4-5" or "@slow").
- Resolve via `ctx.models.resolve(spec)`. If undefined → fallback to `ctx.models.current()` + log warning.
- No hardcoded model ID.

### Q6: Todo snapshot via tool_result interception
- Intercept `tool_result` events where `event.toolName === "todo"`.
- Cache `event.details.phases` (type: `TodoPhase[]`) as latest todo state, keyed by session_id.
- If session never triggered todo tool → no todo cache → skip todo criterion.
- TodoItem.status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked".
- "completed" and "abandoned" are considered done; everything else is pending.

### Q7: LLM call mechanism
- Top-level import: `import { completeSimple } from "@oh-my-pi/pi-ai"`.
- Bun resolves to omp host's in-process bundled copy (legacy-pi-compat.ts confirms pi-ai is bundled).
- Signature: `completeSimple(model: Model, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>`.
- Context = `{ systemPrompt?: string[], messages: Message[], tools?: Tool[] }`.
- Set `maxTokens` on the call (advisory: prevent runaway judge reply).
- Set `disableReasoning: true` (judge doesn't need extended thinking, saves tokens).
- Extract text from `AssistantMessage.content` (array of `{ type: "text", text: string }`).

### Q8: Budget
- Config: `maxInputTokensPerJudge` (default 30000) — truncate tool_result count to fit.
- Config: `maxJudgeTokensPerSession` (default 200000) — cumulative across all judge calls in one session.
- Track cumulative in extension state (keyed by session_id).
- Budget exhausted → deterministic degradation: test pass + todo all done → done; otherwise → need_user. No LLM call.

### Q9: need_user delivery
- Return `{ continue: true, additionalContext: "[DELIVERY:NEED_USER] reason: ..." }` from session_stop handler.
- Also call `ctx.ui.notify("需要用户决策: ...", "warning")` if `ctx.hasUI`.
- Do NOT use `ctx.ui.askDialog` (mode-limited).

### Q10: Original userInput
- Cache from `input` event: `event.text` (string), keyed by session_id.
- On `session_start` / `session_switch` (reason "resume"): rebuild from `ctx.sessionManager.getBranch()` — scan for first user message.
- If not found → judge prompt notes "original userInput unavailable", judge works with tool_results + todos only.

### Q11: stop_hook_active handling
- `event.stop_hook_active === true` → still judge, but include last verdict in context ("上次判定: continue, 原因: 测试未通过").
- Config `reJudgeOnContinue` (default true). If false → reuse last verdict on consecutive continues (save tokens).

### Q12: Judge prompt design — rule-priority
- Extension code computes deterministic evidence fields: `testPassed` (bool|null), `todosAllDone` (bool|null), `hasPendingTodos` (list).
- Judge LLM ONLY answers: "Based on evidence, is userInput satisfied? What confidence? What issues?"
- System prompt encodes the rule: "If testPassed=false or hasPendingTodos non-empty, you MUST return continue. Otherwise judge userInput satisfaction."
- Actually: extension code pre-computes the continue cases. Judge is only called when test+todo pass. Judge only decides done vs need_user (and can still return continue if it sees unfinished work the deterministic rules missed).

### Q13: JSON schema (judge output)
```json
{
  "decision": "done" | "continue" | "need_user",
  "confidence": "high" | "medium" | "low",
  "reason": "string (brief)",
  "issues": [{ "type": "unfulfilled" | "deviation", "detail": "string" }]
}
```
- Extension post-processes: `confidence === "low"` → force `decision = "need_user"`.
- Parse defensively: strip ```json fences, tolerate prose before/after, validate `decision` against three literals.
- Parse failure or out-of-enum decision → same fail-open+retry path as network error (Q15).

### Q14: delivery-config.yml
```yaml
enabled: true                          # default true
judgeModel: "anthropic/claude-sonnet-4-5"  # or "@slow"; undefined → fallback ctx.models.current()
testCommand: "npm test"                # no command → skip test
testTimeout: 120                      # seconds
maxInputTokensPerJudge: 30000
maxJudgeTokensPerSession: 200000
contentTruncateLength: 2000           # per tool_result content truncation
reJudgeOnContinue: true               # re-judge on consecutive stop_hook_active
```
- Path: `.omp/extensions/delivery-config.yml`.
- Loaded via YAML parse. Missing file → all defaults. Invalid → log error, use defaults.

### Q15: Error handling — fail-open + retry
- Judge LLM call fails (network, 401, 429, JSON parse, timeout): retry once after 2s.
- Still fails → fail-open: return `undefined` from session_stop handler (let agent settle normally) + `ctx.ui.notify("判定服务不可用，已放行", "warning")`.
- Never crash the session. Never block on judge unavailability.

### Q16: File layout
```
.omp/extensions/delivery/
  index.ts          # factory + session_stop handler + event registration
  config.ts         # delivery-config.yml load + validate + defaults
  types.ts          # shared types (DeliveryConfig, JudgeResult, TodoSnapshot, etc.)
  todo-cache.ts     # tool_result interceptor → cache todo phases
  judge.ts          # build prompt + completeSimple call + parse JSON + retry
  test-runner.ts    # exec testCommand + timeout + exit code
  budget.ts         # cumulative token tracking + truncation logic
  delivery-config.yml  # example config
```

## Key API facts (verified from source)

### session_stop event (shared-events.ts)
```ts
interface SessionStopEvent {
  type: "session_stop";
  messages: AgentMessage[];
  turn_id: number;
  last_assistant_message?: AgentMessage;
  session_id: string;
  session_file?: string;
  stop_hook_active: boolean;
  signal: AbortSignal;
}

interface SessionStopEventResult {
  continue?: boolean;
  additionalContext?: string;
  decision?: "block";
  reason?: string;
}
```

### tool_result event (types.ts)
```ts
interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;  // "todo" for todo tool
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  details: unknown;  // for todo: { phases: TodoPhase[], ... }
}
```

### TodoItem (todo.ts)
```ts
type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
interface TodoItem { content: string; status: TodoStatus; blocker?: string; }
interface TodoPhase { name: string; tasks: TodoItem[]; }
interface TodoToolDetails { op?: string; phases: TodoPhase[]; storage: "session" | "memory"; }
```

### completeSimple (packages/ai/src/stream.ts:1639)
```ts
async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage>
```

### SimpleStreamOptions (types.ts:594)
```ts
interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
  apiKey?: ApiKey;
  reasoning?: Effort;
  disableReasoning?: boolean;
  hideThinkingSummary?: boolean;
  maxTokens?: number;    // from StreamOptions
  signal?: AbortSignal;  // from StreamOptions
}
```

### AssistantMessage (types.ts:892)
```ts
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ... | ToolCall)[];
  usage: Usage;  // token counts
  errorMessage?: string;
  errorStatus?: number;
  // ...
}
```
TextContent = `{ type: "text", text: string }`

### Context (types.ts:1238)
```ts
interface Context {
  systemPrompt?: string[];
  messages: Message[];
  tools?: Tool[];
}
```

### ExtensionAPI key methods
- `pi.on(event, handler)` — register event handler
- `pi.sendUserMessage(content, { deliverAs })` — send user prompt
- `pi.exec(command, args, options)` — execute shell command
- `pi.logger` — file logger
- `pi.zod` — schema builder
- `ctx.models.resolve(spec)` — resolve model string → Model
- `ctx.models.current()` — current session model
- `ctx.ui.notify(message, type)` — show notification
- `ctx.hasUI` — boolean
- `ctx.sessionManager.getBranch()` — get session entries
- `ctx.isIdle()`, `ctx.hasPendingMessages()`

### Message type (for LLM context)
Message = `{ role: "user" | "assistant" | "system", content: string | TextContent[] }`

## Implementation constraints

1. Extension runs in-process, no isolation. Use try/catch everywhere. Never throw uncaught.
2. `completeSimple` may resolve against host bundle. Import as `import { completeSimple } from "@oh-my-pi/pi-ai"`.
3. JSON parse must be defensive: strip fences, tolerate prose, validate enum.
4. Set `maxTokens` on judge call (e.g. 1024 — verdict JSON is short).
5. Set `disableReasoning: true` on judge call.
6. Budget tracking keyed by session_id. Reset on `session_start`.
7. Todo cache keyed by session_id. Reset on `session_start`.
8. UserInput cache keyed by session_id. Reset on `session_start`.
9. `session_stop` never fires for task/subagent sessions (documented) — no need to filter.
10. Max 8 consecutive continuations (runtime enforced). Budget is economic backstop.
11. Use `pi.logger` for all diagnostics, not console.
12. All session_stop handler returns must be `SessionStopEventResult` shape.

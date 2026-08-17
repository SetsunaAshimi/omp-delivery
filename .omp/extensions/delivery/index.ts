/**
 * index.ts — Delivery 扩展的主入口
 *
 * ============================================================================
 * 【Agent 知识：omp 扩展机制】
 * omp（Oh My Pi）是一个 AI agent harness（运行框架）。它把"用户指令 → LLM 思考
 * → 调工具 → 再思考 → ..."的循环封装成一个 session。
 *
 * "扩展"(extension) 是插在 session 生命周期上的钩子(hook)。omp 在关键节点发事件：
 *   input          — 用户输入了一句话
 *   tool_result    — 某个工具调用结束，返回了结果
 *   session_start  — 会话开始（新建或 resume）
 *   session_stop   — agent 这一轮 settle 了（认为做完或等用户）
 *   session_shutdown — 会话彻底关闭
 *
 * 扩展用 pi.on(event, handler) 注册回调。Delivery 的核心在 session_stop：
 *   "agent 说做完了 → 我独立验算是否真做完了 → 返回 done/continue/need_user"。
 *
 * 返回 continue 会强制 agent 再干一轮；返回 undefined 则放行（agent 正常 settle）。
 * ============================================================================
 *
 * 【TS 语法速查 / 对比 C++】
 * - `export default function` → 默认导出。一个文件只能有一个 default。
 *        omp 加载扩展时调这个默认导出函数。类间 C++ 唯一入口函数。
 * - `pi.on(event, handler)`  → 注册事件回调，类间信号/槽连接或 observer 模式。
 * - `async (e) => { ... }`   → 异步箭头函数。this 绑定到外层（这里是 deliveryExtension 作用域）。
 * - `Map<K, V>`              → 哈希表，存按 session_id 索引的状态。
 * - `try/catch`             → 类间 C++ try/catch。这里"永不抛出"是硬约束：
 *        扩展异常绝不能崩掉 agent 会话，所有入口都包 try/catch。
 * - `new AbortController()` → Web 标准的取消控制器。controller.signal 是只读信号，
 *        controller.abort() 触发信号，传给异步操作使其取消。类间 cancellation token。
 * - `Promise.withResolvers()` → 创建 { promise, resolve } 对。await promise 可阻塞到 resolve 被调。
 *        这里用于"等待 2 秒"的简易 sleep（setTimeout 2 秒后调 resolve）。
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SessionStopEvent, SessionStopEventResult } from "@oh-my-pi/pi-coding-agent";
import type { Model, Context } from "@oh-my-pi/pi-ai";
import { loadConfig, resolveConfigPath } from "./config";
import { TodoCache } from "./todo-cache";
import { BudgetTracker, truncateToolResults } from "./budget";
import { runTest } from "./test-runner";
import { buildJudgeContext, callJudge } from "./judge";
import type { JudgeOutcome } from "./judge";
import { createInitialSessionState } from "./types";
import type { SessionState, JudgeResult, ToolResultEntry } from "./types";

/**
 * Delivery 只关心主会话（main session）。
 * 子 agent（task/scout）的 session_stop 不会触发本扩展（宿主约定），
 * 所以这里固定用 "main" 作为状态 Map 的 key。
 */
const MAIN = "main";

/**
 * session_stop 回调的 ctx 参数形状。
 * 这是宿主在触发事件时传入的"上下文"对象，提供模型解析、UI、API key 等能力。
 * 用 interface 声明而非导入宿主类型，是为了解耦（扩展不依赖宿主内部类型细节）。
 */
interface StopCtx {
  hasUI: boolean;         // 是否有 TUI（终端界面）可交互
  cwd: string;           // 当前工作目录（跑测试用）
  ui: { notify: (m: string, t?: string) => void };  // 弹通知的方法
  models: {
    resolve: (spec: string) => unknown | undefined;  // 模型 ID → Model 对象
    current: () => unknown | undefined;               // 取当前会话模型
  };
  modelRegistry: {
    // 按模型+会话解析 API key（自定义 provider 如 Bailian 需此步）。
    getApiKey: (
      model: Model,
      sessionId?: string,
      options?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
}

/**
 * 扩展工厂函数。omp 启动时读 .omp/extensions/delivery/index.ts，调用此默认导出。
 * 整个扩展的生命周期在此函数内：加载配置 → 注册事件回调 → 回调里做判定。
 */
export default function deliveryExtension(pi: ExtensionAPI): void {
  // 1. 加载配置。配置缺失/解析失败都返回默认值，不会抛。
  const config = loadConfig(resolveConfigPath(), pi.logger);
  if (!config.enabled) {
    pi.logger.info("delivery: disabled by config");
    return;  // 配置禁用 → 直接不注册任何回调，扩展静默。
  }

  // 2. 创建扩展级单例：todo 缓存、预算追踪、会话状态表。
  const todoCache = new TodoCache();
  const budget = new BudgetTracker();
  // Map<sessionId, SessionState>：按会话存运行时状态。key 实际固定为 "main"。
  const sessions = new Map<string, SessionState>();

  /** 取指定会话的状态；不存在则创建初始状态并存入。 */
  function getState(sid: string): SessionState {
    if (!sessions.has(sid)) sessions.set(sid, createInitialSessionState());
    return sessions.get(sid)!;  // ! = 非空断言：告诉编译器"我刚 set 过，一定有值"
  }

  // ---------------------------------------------------------------------------
  // 事件 1：input —— 缓存用户原始指令。
  // 用户每输入一句话都触发。我们只关心第一句（任务的原始需求），但因为无法
  // 区分"第一句"和"后续补充"，采取"后输入覆盖"策略：最后一句 input 即视为最新需求。
  // session_start 分支会用更可靠的方式（session branch 重建）覆盖。
  // ---------------------------------------------------------------------------
  pi.on("input", (event: { text: string; source?: string }) => {
    try {
      getState(MAIN).userInput = event.text;
    } catch (e) {
      pi.logger.warn(`delivery input: ${String(e)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 事件 2：tool_result —— 拦截 todo 工具的结果，更新缓存。
  // Agent 每次调用 todo 工具，宿主发此事件，event.details.phases 是最新清单。
  // ---------------------------------------------------------------------------
  pi.on("tool_result", (event: { toolName: string; details: unknown }) => {
    try {
      todoCache.update(MAIN, event.toolName, event.details);
    } catch (e) {
      pi.logger.warn(`delivery todo: ${String(e)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 事件 3：session_start —— 会话开始/恢复时重置所有状态。
  // resume 一个旧会话时，从会话分支(branch)里找第一条用户消息重建 userInput。
  // ---------------------------------------------------------------------------
  pi.on("session_start", (_event: unknown, ctx: { sessionManager: { getBranch: () => unknown[] } }) => {
    try {
      // 清空三大缓存，保证 resume 不继承旧会话的脏状态。
      todoCache.clear(MAIN);
      budget.clear(MAIN);
      sessions.delete(MAIN);
      const st = getState(MAIN);
      // 从 session 分支重建 userInput：遍历历史消息找第一条 role=user 的。
      try {
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
          if (msg && msg.role === "user") {
            // content 可能是 string 或 TextContent[]，用 extractTextContent 统一提取。
            st.userInput = extractTextContent(msg.content);
            break;
          }
        }
      } catch {
        // 新会话 branch 为空，正常；后续 input 事件会填充 userInput。
      }
    } catch (e) {
      pi.logger.warn(`delivery session_start: ${String(e)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 事件 4：session_stop —— 核心判定逻辑。
  // Agent 每轮 settle 都触发。判定优先级（SPEC Q2）：
  //   1. 无 mutating 工具调用 → 跳过（纯 Q&A 不需要验交付）
  //   2. budget 耗尽 → 确定性降级
  //   3. 测试失败 → continue
  //   4. 测试超时 → need_user
  //   5. todo 有 pending → continue
  //   6. 都过 → 调 judge LLM
  //   7. 任何异常 → fail-open（返回 undefined，放行）
  // ---------------------------------------------------------------------------
  pi.on("session_stop", async (event: SessionStopEvent, ctx: StopCtx) => {
    try {
      if (!config.enabled) return;
      const sid = MAIN;
      const st = getState(sid);

      // 连续 continue 时，若配置 reJudgeOnContinue=false，直接复用上次判定省 token。
      // stop_hook_active=true 表示这是"被强制继续"的一轮（上次判定 continue 了）。
      if (event.stop_hook_active && !config.reJudgeOnContinue && st.lastVerdict) {
        return mapVerdict(st.lastVerdict, ctx, pi);
      }

      // 提取本轮所有工具调用结果。
      const toolResults = extractToolResults(event.messages);
      // 只在有"修改性"工具调用时才判定：纯读/搜索的 Q&A 轮不该触发测试。
      const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, bash: true };
      const hasMutation = toolResults.some((r) => r.toolName in MUTATING_TOOLS);
      if (!hasMutation) return;  // 放行

      // —— 预算耗尽：走确定性降级，不调 LLM ——
      if (budget.isExhausted(sid, config.maxJudgeTokensPerSession)) {
        pi.logger.info("delivery: budget exhausted, deterministic degradation");
        const testRes = await runTest(pi.exec, config, ctx.cwd);
        const todos = todoCache.get(sid);
        // Q2 语义："todos all done (or no todos)"。
        // isAllDone 对空列表返回 false，所以这里显式处理"没用 todo"的情况。
        const allDone = !todos.hasTodos || TodoCache.isAllDone(todos.phases);
        if (testRes.passed && allDone) return undefined;  // 测试过+无待办 → 放行
        if (ctx.hasUI) ctx.ui.notify("delivery: 预算耗尽，需要用户决策", "warning");
        pi.sendMessage(
          { type: "text", text: formatVerdict("need_user", "预算耗尽，需要用户决策") },
          { deliverAs: "nextTurn" },
        );
        return undefined;
      }

      // —— 跑测试 ——
      const testRes = await runTest(pi.exec, config, ctx.cwd);

      // 测试失败（非超时）→ continue：让 agent 看到"测试没过"继续修。
      if (testRes.ran && !testRes.passed && !testRes.timedOut) {
        st.lastVerdict = {
          decision: "continue",
          confidence: "high",
          reason: `测试未通过 (exit ${testRes.exitCode})`,
          issues: [{ type: "unfulfilled", detail: "test failed" }],
        };
        return {
          continue: true,
          additionalContext: formatVerdict("continue", `测试未通过 (exit ${testRes.exitCode})`),
        };
      }

      // 测试超时 → need_user：超时原因不明，交给人类。
      if (testRes.timedOut) {
        st.lastVerdict = {
          decision: "need_user",
          confidence: "high",
          reason: "测试执行超时",
          issues: [{ type: "unfulfilled", detail: "test timeout" }],
        };
        if (ctx.hasUI) ctx.ui.notify("⚠ delivery: 测试执行超时，需要用户决策", "warning");
        pi.sendMessage(
          { type: "text", text: formatVerdict("need_user", "测试执行超时，需要用户决策") },
          { deliverAs: "nextTurn" },
        );
        return undefined;
      }

      // —— 检查 todo ——
      const todos = todoCache.get(sid);
      const pending = TodoCache.getPendingItems(todos.phases);
      if (todos.hasTodos && pending.length > 0) {
        // 有未完成待办 → continue，附上未完成项让 agent 知道还差啥。
        st.lastVerdict = {
          decision: "continue",
          confidence: "high",
          reason: `待办事项未完成: ${pending.join(", ")}`,
          issues: pending.map((p) => ({ type: "unfulfilled" as const, detail: p })),
        };
        return {
          continue: true,
          additionalContext: formatVerdict("continue", `待办事项未完成: ${pending.join("; ")}`),
        };
      }

      // —— 确定性检查全过 → 调 judge LLM ——
      // 先截断证据，控制喂给 LLM 的体积。
      const truncated = truncateToolResults(
        toolResults,
        config.maxInputTokensPerJudge,
        config.contentTruncateLength,
      );

      // 拼装 judge 请求上下文。
      const judgeCtx = buildJudgeContext({
        userInput: st.userInput,
        todoSnapshot: todos,
        testResult: testRes,
        toolResults: truncated,
        lastVerdict: st.lastVerdict,
      });

      // 解析 judge 模型：config.judgeModel 有值则按它解析，否则 fallback 当前会话模型。
      let model = config.judgeModel ? ctx.models.resolve(config.judgeModel) : undefined;
      if (!model) {
        model = ctx.models.current();
        pi.logger.warn("delivery: judgeModel not resolved, using session model");
      }
      if (!model) {
        pi.logger.error("delivery: no model available, fail-open");
        return undefined;  // 无可用模型 → 放行
      }

      // 解析 API key：自定义 provider（如 Bailian）不在内置表里，需经 modelRegistry 取。
      let apiKey: string | undefined;
      try {
        apiKey = await ctx.modelRegistry.getApiKey(
          model as Model,
          event.session_id,
          { signal: event.signal },
        );
      } catch (e) {
        pi.logger.warn(`delivery: getApiKey failed: ${String(e)}`);
      }
      if (!apiKey) {
        pi.logger.error("delivery: no apiKey resolved, fail-open");
        if (ctx.hasUI) ctx.ui.notify("delivery 判定服务不可用，已放行", "warning");
        return undefined;
      }

      // 调 judge（带重试+超时）。传入 event.signal 让会话中断能取消请求。
      const outcome = await callJudgeWithRetry(
        model as Model, judgeCtx, event.signal, pi.logger, apiKey,
      );

      if (!outcome.result) {
        // 两次都失败 → fail-open：放行，只通知。
        if (ctx.hasUI) ctx.ui.notify("delivery 判定服务不可用，已放行", "warning");
        return undefined;
      }

      // 记录真实 token 消耗到预算追踪器。
      budget.addUsage(sid, outcome.totalTokens);
      st.lastVerdict = outcome.result;
      return mapVerdict(outcome.result, ctx, pi);
    } catch (e) {
      // 最后一道防线：任何未预期异常 → fail-open，绝不崩会话。
      pi.logger.error(`delivery session_stop: ${String(e)}`);
      return undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // 事件 5：session_shutdown —— 会话关闭，清空所有状态。
  // ---------------------------------------------------------------------------
  pi.on("session_shutdown", () => {
    sessions.clear();
  });
}

/**
 * 带 30 秒超时 + 1 次重试的 judge 调用包装。
 * 把会话的 abort 信号链接到本地 AbortController：会话中断或本地超时任一发生即取消请求。
 * 第一次失败 → 等 2 秒 → 重试一次 → 仍失败则返回 null（由上层 fail-open）。
 */
async function callJudgeWithRetry(
  model: Model,
  context: Context,
  sessionSignal: AbortSignal,
  logger: { warn: (m: string) => void; error: (m: string) => void },
  apiKey: string,
): Promise<JudgeOutcome> {
  // 内部函数：单次尝试。新建 AbortController，30 秒后 abort。
  const tryOnce = async (): Promise<JudgeOutcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);  // 30 秒超时
    // 链接会话信号：若会话已 abort 或中途 abort，同步取消本次请求。
    if (sessionSignal.aborted) controller.abort();
    else sessionSignal.addEventListener("abort", () => controller.abort(), { once: true });
    const outcome = await callJudge({
      model,
      context,
      apiKey,
      signal: controller.signal,  // 传入合并后的取消信号
      maxTokens: 1024,             // verdict JSON 很短，1024 足够
      logger,
    });
    clearTimeout(timer);  // 成功或失败都要清定时器
    return outcome;
  };

  // 第一次尝试。
  let outcome = await tryOnce();
  if (!outcome.result) {
    // 失败 → 等 2 秒再重试一次。用 Promise.withResolvers 造一个简易 sleep。
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 2_000);
    await promise;  // 阻塞 2 秒
    outcome = await tryOnce();
  }
  return outcome;
}

/**
 * 把判定结果格式化成纯文本标签串。
 * 注意：此串会进入 additionalContext 回灌给 agent 下一轮上下文，所以用纯文本
 * 不含 ANSI 色码（色码对 agent 是噪音）。UI 通知另走 ctx.ui.notify。
 */
function formatVerdict(decision: string, reason: string): string {
  const tag =
    decision === "done"
      ? "DELIVERY:DONE"
      : decision === "continue"
        ? "DELIVERY:CONTINUE"
        : "DELIVERY:NEED_USER";
  return `[${tag}] ${reason}`;
}

/**
 * 把 JudgeResult 映射成 session_stop 的返回值。
 * - done       → 不带 continue（放行 settle），additionalContext 带结果让 agent 知道判定结论。
 * - continue   → continue:true，强制 agent 再干一轮。
 * - need_user  → continue:true（仍是强制继续，但 additionalContext 标明需用户介入）+ UI 通知。
 */
function mapVerdict(
  result: JudgeResult,
  ctx: { hasUI: boolean; ui: { notify: (m: string, t?: string) => void } },
  pi: ExtensionAPI,
): SessionStopEventResult | undefined {
  const verdict = formatVerdict(result.decision, result.reason);
  const issues =
    result.issues.length > 0
      ? "\nIssues:\n" +
        result.issues.map((i) => `  - [${i.type}] ${i.detail}`).join("\n")
      : "";
  const context = issues ? `${verdict}\n${issues}` : verdict;
  if (result.decision === "done") {
    if (ctx.hasUI) ctx.ui.notify("delivery: ✓ 任务判定完成", "info");
    return { additionalContext: context };
  }
  if (result.decision === "continue") {
    return { continue: true, additionalContext: context };
  }
  // need_user: 注入信息到下一轮，但让会话停下等用户。
  if (ctx.hasUI)
    ctx.ui.notify(`⚠ delivery 需要用户决策: ${result.reason}`, "warning");
  pi.sendMessage(
    { type: "text", text: context },
    { deliverAs: "nextTurn" },
  );
  return undefined;
}

/**
 * 从 session 消息流里提取所有 toolResult 类消息，转成 ToolResultEntry 数组。
 * messages 的元素形状是 { role, toolName?, content?, isError? }。
 * role==="toolResult" 且有 toolName 的才取。content 可能是 text 块数组或裸字符串。
 */
function extractToolResults(messages: unknown[]): ToolResultEntry[] {
  const results: ToolResultEntry[] = [];
  for (const msg of messages) {
    // 用 as 断言成可索引形状，才能安全访问字段。
    const m = msg as {
      role?: string;
      toolName?: string;
      content?: unknown;
      isError?: boolean;
    };
    if (m.role === "toolResult" && m.toolName) {
      // content 是数组：取所有 type==text 的块拼接；否则转字符串。
      const content =
        Array.isArray(m.content)
          ? m.content
              .filter((c: { type?: string }) => c.type === "text")
              .map((c: { text?: string }) => c.text ?? "")
              .join("")
          : String(m.content ?? "");
      results.push({
        toolName: m.toolName,
        content,
        isError: m.isError ?? false,
      });
    }
  }
  return results;
}

/**
 * 从 Message.content 提取纯文本。
 * omp 的 Message.content 类型是 string | TextContent[]：
 *   - string → 直接返回
 *   - 数组   → 取所有 { type: "text", text: string } 块的 text 拼接
 *   - 其他   → 空串
 * 用于 session_start 时从会话历史重建用户原始指令。
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c !== "object" || c === null) return "";
        const obj = c as { type?: string; text?: string };
        return obj.type === "text" ? (obj.text ?? "") : "";
      })
      .join("");
  }
  return "";
}

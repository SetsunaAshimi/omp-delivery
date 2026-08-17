/**
 * judge.ts — 构建 judge LLM 的请求并解析其 JSON 回复
 *
 * 【Agent 知识】
 * 当确定性检查（测试通过 + todo 全完成）都过了，还不够：agent 可能"测试过了但功能没做"
 * （比如只写了通过测试的空壳）。这时请一个独立的 LLM（judge）看证据，判断是否真满足用户需求。
 *
 * 流程：buildJudgeContext(拼请求) → callJudge(发请求) → parseJudgeJson(解析回复)。
 *
 * Judge 只回答 done/continue/need_user + 置信度 + 问题列表。
 * 置信度 low 时，代码强制升级为 need_user（不信任低把握判定）。
 *
 * 【TS 语法速查 / 对比 C++】
 * - `import { x } from "@oh-my-pi/pi-ai"` → 从 omp 宿主打包的 AI 库导入 completeSimple。
 *        这是一个真实运行时的 import（不像 type import 会被擦除）。
 * - `.flatMap(f)`   → 先 map 再展平一层，类间遍历后串接子数组。
 * - `.join("\n")`   → 用分隔符把数组拼成字符串，类间 std::join。
 * - `Set<T>`        → 集合，这里用于枚举校验。.has(x) 判断 x 是否合法。
 * - `JSON.parse(s)` → 解析 JSON 字符串为对象，类间 nlohmann::json::parse。
 * - `as`            → 类型断言，类间 static_cast/reinterpret_cast。
 * - `import type`   → 只导入类型（编译期擦除，运行时不存在），用于类型标注。
 */

import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Model, Context } from "@oh-my-pi/pi-ai";
import { estimateTokens } from "./budget";
import type {
  JudgeResult,
  JudgeDecision,
  JudgeConfidence,
  TodoSnapshot,
  TestResult,
  ToolResultEntry,
} from "./types";

/** 日志接口：只要 warn 和 error 两个方法。 */
type Logger = { warn: (m: string) => void; error: (m: string) => void };

/** 构建 judge 上下文所需的全部输入参数。 */
interface BuildContextParams {
  userInput: string | null;       // 用户原始指令
  todoSnapshot: TodoSnapshot;     // todo 快照
  testResult: TestResult;         // 测试结果
  toolResults: ToolResultEntry[]; // 工具调用证据
  lastVerdict: JudgeResult | null; // 上次判定（供 judge 参考）
}

/** 合法的 decision 枚举集合，用于校验 LLM 回复。 */
const VALID_DECISIONS = new Set<JudgeDecision>(["done", "continue", "need_user"]);
/** 合法的 confidence 枚举集合。 */
const VALID_CONFIDENCE = new Set<JudgeConfidence>(["high", "medium", "low"]);

/**
 * 把所有证据拼成 judge LLM 的请求上下文。
 * 返回 { systemPrompt, messages }，符合 completeSimple 的 Context 形状。
 *
 * SystemPrompt 编码判定规则：告诉 LLM 确定性检查已过，只需判断是否满足用户需求，
 * 并严格只返回 JSON。这是 prompt engineering 的关键——约束输出格式以利程序解析。
 */
export function buildJudgeContext(params: BuildContextParams): Context {
  // systemPrompt：系统提示词，定义 judge 的角色和输出格式。
  // 用模板字符串（反引号）保留多行，${} 内嵌 schema。
  const systemPrompt = [
    `You are a delivery judge. Analyze whether the agent has completed the user's task.
Return ONLY valid JSON. No prose, no markdown fences, no explanation outside JSON.
JSON schema:
{"decision":"done"|"continue"|"need_user","confidence":"high"|"medium"|"low","reason":"brief string","issues":[{"type":"unfulfilled"|"deviation","detail":"string"}]}
Deterministic checks (test pass + todo completion) have ALREADY passed. Your job: assess if the actual work satisfies the original user request.
If you see unfinished work the automated checks missed, return "continue".
If the agent's work deviates from the user's explicit constraints, return "need_user".
If everything is satisfied, return "done".`,
  ];

  // 拼装 todo 状态段：每个任务一行 "- [status] content"。
  let todoSection = "no todos used";
  if (params.todoSnapshot.hasTodos && params.todoSnapshot.phases) {
    // flatMap：每个 phase 映射出多条任务行，再展平成一维数组。
    const lines = params.todoSnapshot.phases.flatMap((p) =>
      p.tasks.map((t) => `  - [${t.status}] ${t.content}`),
    );
    todoSection = lines.join("\n");
  }

  // 拼装工具结果段：每条一行 "- [toolName] ERROR?: content"。
  const toolLines = params.toolResults
    .map((r) => `- [${r.toolName}]${r.isError ? " ERROR" : ""}: ${r.content}`)
    .join("\n");

  // 用户消息：把所有证据组装成一段 markdown。
  const userContent = `## Original User Request
${params.userInput ?? "[unavailable]"}

## Test Result
${params.testResult.ran ? `exit=${params.testResult.exitCode}, passed=${params.testResult.passed}` : "no test configured"}

## Todo State
${todoSection}

## Recent Tool Results
${toolLines || "(none)"}

## Previous Verdict
${params.lastVerdict ? `${params.lastVerdict.decision}: ${params.lastVerdict.reason}` : "none"}`;

  // 返回符合 Context 类型的对象：系统提示 + 单条用户消息。
  return {
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
  };
}

/** callJudge 的参数集合。 */
interface CallJudgeParams {
  model: Model;          // 要调的模型
  context: Context;      // 请求上下文（由 buildJudgeContext 构造）
  apiKey: string;        // 模型 API key
  signal: AbortSignal;   // 取消信号（超时/会话中断时 abort）
  maxTokens: number;     // 回复最大 token 数
  logger: Logger;
}

/** callJudge 的返回：判定结果 + 本次实际消耗 token。 */
export interface JudgeOutcome {
  result: JudgeResult | null;  // null = 调用失败或解析失败
  totalTokens: number;
}

/**
 * 调用 judge LLM 一次。
 * 用 completeSimple 发请求（非流式，一次拿完整回复）。
 * 任何异常都捕获，返回 { result: null } ——绝不抛出，让上层（callJudgeWithRetry）决定重试。
 */
export async function callJudge(params: CallJudgeParams): Promise<JudgeOutcome> {
  try {
    // completeSimple 是 omp 打包的 AI 库函数：发请求，等回复。
    const response = await completeSimple(params.model, params.context, {
      maxTokens: params.maxTokens,
      disableReasoning: true,  // judge 不需要 extended thinking，省 token
      apiKey: params.apiKey,
      signal: params.signal,  // 传入取消信号，abort 时请求被取消
    });

    // 模型层报错（如 401/429）：记录并返回失败。
    if (response.errorMessage) {
      params.logger.warn(`delivery judge error: ${response.errorMessage}`);
      return { result: null, totalTokens: 0 };
    }

    // 从回复的 content 数组里提取所有 text 块拼接成完整字符串。
    const text = response.content
      .filter((c: { type: string; text?: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");

    // 解析 JSON 回复。
    const result = parseJudgeJson(text, params.logger);
    // 取真实 token 用量；不可得则用 estimateTokens 估算。
    const usage = response.usage;
    const totalTokens =
      usage && typeof usage === "object" && "totalTokens" in usage
        ? (usage.totalTokens as number)
        : estimateTokens(text);
    return { result, totalTokens };
  } catch (e) {
    // 网络异常等：记录并返回失败，不抛出。
    params.logger.warn(`delivery judge call failed: ${String(e)}`);
    return { result: null, totalTokens: 0 };
  }
}

/**
 * 防御式解析 judge 的 JSON 回复。
 * LLM 可能不严格遵守"只返回 JSON"，会带 ```json``` 围栏或前后解说，这里都要容错。
 *
 * 步骤：去围栏 → 截取首个 { 到末尾 } → JSON.parse → 校验枚举 → 强制 low→need_user。
 * 任何一步失败返回 null（让上层重试或 fail-open）。
 */
export function parseJudgeJson(text: string, logger: Logger): JudgeResult | null {
  try {
    let jsonStr = text.trim();
    // 去掉 markdown 代码围栏（```json ... ``` 或 ``` ... ```）。
    // 正则：^```开头可选 json + 空白；末尾 ``` + 空白。i = 大小写不敏感。
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    // 从首个 { 到末尾 } 截取，丢弃 JSON 前后的散文。
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first >= 0 && last > first) {
      jsonStr = jsonStr.slice(first, last + 1);
    }
    // 解析为对象。
    const parsed = JSON.parse(jsonStr);

    // 校验枚举字段。
    const decision = parsed.decision as string;
    const confidence = parsed.confidence as string;
    if (!VALID_DECISIONS.has(decision as JudgeDecision)) {
      logger.warn(`delivery judge: invalid decision "${decision}"`);
      return null;
    }
    if (!VALID_CONFIDENCE.has(confidence as JudgeConfidence)) {
      logger.warn(`delivery judge: invalid confidence "${confidence}"`);
      return null;
    }

    // 组装结果，给 reason/issues 提供默认值（LLM 可能漏字段）。
    let result: JudgeResult = {
      decision: decision as JudgeDecision,
      confidence: confidence as JudgeConfidence,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };

    // Q3 规则：低置信度强制升级为 need_user。
    // 不信任 LLM 的低把握判定，交给人类。
    if (result.confidence === "low") {
      result.decision = "need_user";
    }
    return result;
  } catch (e) {
    // JSON.parse 失败或其他异常：记录前 200 字符便于排查，返回 null。
    logger.warn(`delivery judge JSON parse failed: ${text.slice(0, 200)}`);
    return null;
  }
}

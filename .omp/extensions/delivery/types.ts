/**
 * types.ts — 全扩展共享的类型定义
 *
 * 【TS 语法速查 / 对比 C++】
 * - `type X = "a" | "b"`        → 类似 C++ 的 enum class，但更轻量，叫"联合类型"(union type)，
 *                                 表示一个值只能是这几个字符串字面量之一。编译期检查，运行时就是普通 string。
 * - `interface Foo { ... }`    → 类似 C++ 的 struct 声明，只有形状(字段名+类型)，无实现。
 *                                 TS 的 interface 在运行时被完全擦除（不做任何事），仅用于编译期类型检查。
 * - `field?: Type`             → 字段名后加 ? 表示"可选"(optional)，类间 C++ 的 std::optional<Type>。
 *                                 未提供时为 undefined（TS 的"无值"标记，类间 nullptr）。
 * - `Type | null`              → 联合类型，表示值要么是 Type，要么是 null。类间 Type*（可能为空指针）。
 * - `export`                   → 声明可被其他文件 import。类间 C++ 头文件里暴露的符号。
 * - `const`                    → 不可变绑定。类间 C++ 的 const。这里用于常量对象 DEFAULT_CONFIG。
 */

/**
 * 【Agent 知识】
 * "Agent"（智能体）= LLM + 工具调用循环。用户给一句话指令，agent 自主决定调哪些工具
 * （读文件、改代码、跑命令）、调几次、按什么顺序，直到认为任务完成。
 *
 * Delivery 扩展的职责：在 agent 说"我做完了"的那一刻（session_stop 事件），
 * 独立判断它是否真的做完了。判断有三层：
 *   1. 确定性规则：测试跑没过？todo 列表有没有未完成项？
 *   2. LLM 判断：上面都过了，把工作证据喂给一个独立的 judge LLM，问"满足用户需求了吗？"
 *   3. 容错：LLM 不可用就放行（fail-open），绝不阻塞 agent。
 *
 * 判定结果三种：
 *   done       → 真完成了，结束
 *   continue   → 没完成，让 agent 接着干
 *   need_user  → 有歧义/超能力/预算耗尽，需要人来拍板
 */

/** 待办项的状态机。对应 C++ enum class TodoStatus。 */
export type TodoStatus =
  | "pending"      // 待处理：还没开始
  | "in_progress"   // 进行中：正在做
  | "completed"     // 已完成
  | "abandoned"     // 已放弃：主动放弃（算"了结"，不再阻塞）
  | "blocked";      // 被阻塞：等待外部输入（人来处理）

/** Judge 的三态判定。决定 agent 停还是继续。 */
export type JudgeDecision = "done" | "continue" | "need_user";

/** Judge 对自己判定的置信度。low 会被代码强制升级为 need_user（不信任 LLM 的低把握）。 */
export type JudgeConfidence = "high" | "medium" | "low";

/**
 * delivery-config.yml 加载后的配置对象。
 * 对应 C++ struct DeliveryConfig。所有字段在运行期只读。
 */
export interface DeliveryConfig {
  enabled: boolean;                    // 总开关，false 则整个扩展不工作
  judgeModel: string | undefined;      // judge 用的模型 ID，undefined → fallback 到当前会话模型
  testCommand: string | undefined;     // 验证用测试命令，undefined → 跳过测试检查
  testTimeout: number;                 // 测试超时秒数
  maxInputTokensPerJudge: number;      // 单次 judge 输入 token 上限（截断证据以适配）
  maxJudgeTokensPerSession: number;    // 单次会话累计 judge token 上限（预算）
  contentTruncateLength: number;       // 每个 tool_result 内容截断到多少字符
  reJudgeOnContinue: boolean;           // 连续 continue 时是否重新判定（false=复用上次结果省 token）
}

/**
 * 配置默认值。对应 C++ 的 constexpr 默认实例。
 * config.ts 读不到配置文件或解析失败时用这份。
 */
export const DEFAULT_CONFIG: DeliveryConfig = {
  enabled: true,
  judgeModel: undefined,
  testCommand: undefined,
  testTimeout: 120,
  maxInputTokensPerJudge: 30000,
  maxJudgeTokensPerSession: 200000,
  contentTruncateLength: 2000,
  reJudgeOnContinue: true,
};

/**
 * Judge 发现的某个具体问题。
 * 对应 C++ struct JudgeIssue。
 */
export interface JudgeIssue {
  /** unfulfilled=用户要求的没做完；deviation=agent 偏离了用户的显式约束 */
  type: "unfulfilled" | "deviation";
  /** 人可读的问题描述 */
  detail: string;
}

/**
 * Judge LLM 返回的完整判定。对应 C++ struct JudgeResult。
 * 这是从 LLM 回复的 JSON 解析出来的。
 */
export interface JudgeResult {
  decision: JudgeDecision;
  confidence: JudgeConfidence;
  reason: string;            // 简短理由
  issues: JudgeIssue[];      // 发现的问题列表。TS 的 Type[] = C++ 的 std::vector<Type>
}

/**
 * 单条待办项。对应 todo 工具管理的任务。
 * 对应 C++ struct TodoItem。
 */
export interface TodoItem {
  content: string;        // 任务描述
  status: TodoStatus;     // 当前状态
  blocker?: string;       // 可选：被阻塞时的原因说明
}

/**
 * 待办的一个阶段。Agent 的 todo 可分阶段（phase），每阶段含若干任务。
 * 对应 C++ struct TodoPhase。
 */
export interface TodoPhase {
  name: string;          // 阶段名
  tasks: TodoItem[];     // 该阶段的任务列表
}

/**
 * 待办快照：缓存的当前 todo 状态。
 * phases=null 表示从未见过 todo 工具被调用；hasTodos=false 同理。
 * 对应 C++ struct TodoSnapshot。
 */
export interface TodoSnapshot {
  phases: TodoPhase[] | null;
  hasTodos: boolean;
}

/**
 * 测试执行结果。对应 C++ struct TestResult。
 * 由 test-runner.ts 跑完 testCommand 后填充。
 */
export interface TestResult {
  ran: boolean;          // 是否真的跑了测试（没配 testCommand 则 ran=false）
  passed: boolean;       // 是否通过（exit 0）
  timedOut: boolean;     // 是否超时
  output: string;        // stdout+stderr 合并
  exitCode: number | null;  // 退出码；超时或没跑则为 null
}

/**
 * 从 session 消息流里提取的单条工具调用结果。
 * 对应 C++ struct ToolResultEntry。
 * 用途：作为证据喂给 judge LLM。
 */
export interface ToolResultEntry {
  toolName: string;      // 工具名，如 "edit" / "bash" / "read"
  content: string;       // 工具返回的文本内容
  isError: boolean;      // 该工具调用是否报错
}

/**
 * 每个会话的运行时状态。对应 C++ struct SessionState。
 * 存在内存 Map 里，key 是 session_id（字符串）。
 * session_start 时清空重建。
 */
export interface SessionState {
  userInput: string | null;           // 用户最初的那句指令（从 input 事件或 session 分支重建）
  todoSnapshot: TodoSnapshot;         // 最新的 todo 快照
  cumulativeJudgeTokens: number;      // 本会话累计 judge 消耗 token（预算追踪用）
  lastVerdict: JudgeResult | null;    // 上一次判定结果（连续 continue 时可复用）
}

/**
 * 工厂函数：创建初始 SessionState。
 * 对应 C++ SessionState makeInitialState() { return {...}; }
 * 语义上等价于构造函数，用函数封装保证每次返回独立的新对象。
 */
export function createInitialSessionState(): SessionState {
  return {
    userInput: null,
    todoSnapshot: { phases: null, hasTodos: false },
    cumulativeJudgeTokens: 0,
    lastVerdict: null,
  };
}

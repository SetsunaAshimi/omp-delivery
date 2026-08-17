/**
 * budget.ts — Token 预算追踪与证据截断
 *
 * 【为什么需要预算】
 * Agent 会话可能持续很久、调用很多工具。每次 session_stop 都把所有工具结果
 * 喂给 judge LLM 会很贵（token = 钱）。这里做两件事：
 *   1. BudgetTracker：追踪单会话累计 judge token，超限就不再调 LLM，走确定性降级。
 *   2. truncateToolResults：把每个工具结果截短、丢弃最老的，让喂给 LLM 的证据体积可控。
 *
 * 【TS 语法速查 / 对比 C++】
 * - `class`            → TS 的 class 类间 C++，但运行时真实存在（不像 interface 被擦除）。
 *                        字段可直接在类体赋初值，等价于 C++ 构造函数初始化列表。
 * - `private`          → 私有成员，类间 C++ private。TS 编译期检查（运行时可被绕过，非安全边界）。
 * - `Map<K, V>`        → 标准库哈希表，类间 std::unordered_map<K,V>。this.usage = new Map() 创建空表。
 * - `??`               → 空值合并运算符。a ?? b = (a 不是 null 且不是 undefined) ? a : b。
 *                        用于给 Map 查不到的 key 提供 0 默认值。
 * - `Math.ceil/floor`  → 类间 std::ceil/std::floor。
 * - `s.slice(0, n)`    → 取前 n 字符，类间 s.substr(0, n)。
 * - `s.slice(-n)`      → 负数从末尾算，取末尾 n 字符。C++ 无等价，需 s.substr(s.size()-n)。
 * - `...r`             → 展开运算符(spread)：把对象 r 的所有字段复制到新对象里。类间拷贝 struct。
 *                        `{...r, content: x}` = 复制 r 所有字段，但把 content 改成 x。类间拷贝构造后改字段。
 * - `.map(f)`          → 对数组每个元素应用 f，返回新数组。类间 std::transform。
 * - `=>` 箭头函数      → (args) => expr 等价于 C++ 的 lambda: [](args){ return expr; }。
 */

import type { ToolResultEntry } from "./types";

/**
 * 预算追踪器：按 session_id 记录累计 judge token 消耗。
 * 对应 C++ class BudgetTracker { std::unordered_map<std::string, long> usage; ... }。
 */
export class BudgetTracker {
  // 按会话 ID 累计的 token 数。key=sessionId, value=已用 token。
  private usage = new Map<string, number>();

  /**
   * 累加一次 judge 调用的 token 消耗。
   * @param sessionId  会话 ID
   * @param tokens     本次 judge 实际消耗的 token 数
   */
  addUsage(sessionId: string, tokens: number): void {
    // this.usage.get(sid) ?? 0：查不到返回 0，再 +tokens，再 set 回去。
    this.usage.set(sessionId, (this.usage.get(sessionId) ?? 0) + tokens);
  }

  /** 读指定会话当前已用 token。查不到返回 0。 */
  getUsage(sessionId: string): number {
    return this.usage.get(sessionId) ?? 0;
  }

  /** 是否已超预算上限。>= 即视为耗尽。 */
  isExhausted(sessionId: string, limit: number): boolean {
    return this.getUsage(sessionId) >= limit;
  }

  /** 清除指定会话的记录（session_start 时调用，重置状态）。 */
  clear(sessionId: string): void {
    this.usage.delete(sessionId);
  }
}

/**
 * 粗略估算字符串的 token 数。
 * 经验法则：英文约 1 token ≈ 4 字符。中文约 1 字 ≈ 1-2 token，这里仍按字符/4 估，
 * 偏保守（高估），确保不会超 LLM 实际限制。
 * 用于 LLM 真实 usage 不可得时的回退估算。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 把字符串截断到 maxLen 字符。
 * 策略：保留头 67% + 尾 33%，中间插 [...truncated...] 标记。
 * 头尾都留是因为：头通常是工具调用上下文，尾是最终结果/错误，两端信息密度最高。
 */
export function truncateString(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const head = Math.floor(maxLen * 0.67);
  const tail = Math.floor(maxLen * 0.33);
  // slice(0, head) 取前 head 字符；slice(-tail) 取末尾 tail 字符。
  return s.slice(0, head) + "\n[...truncated...]\n" + s.slice(-tail);
}

/**
 * 截断工具结果列表，使其总 token 量不超过 maxTokens。
 * 两步：
 *   1. 先把每条结果的 content 用 truncateString 截到 truncateLength 字符。
 *   2. 再从最新到最老逐条尝试加入，超预算就跳过（丢弃最老的）。
 *      原因：最近的工具调用对"是否完成"判断最相关，老的优先丢。
 *
 * @param results         原始工具结果列表
 * @param maxTokens       总 token 预算（按 estimateTokens 估算）
 * @param truncateLength  单条 content 截断长度（字符）
 * @returns               截断后的列表，顺序保持时间顺序（旧的在前）
 */
export function truncateToolResults(
  results: ToolResultEntry[],
  maxTokens: number,
  truncateLength: number,
): ToolResultEntry[] {
  // 第一步：逐条截断 content。用 {...r, content: ...} 复制原对象，只改 content 字段。
  const truncated = results.map((r) => ({
    ...r,
    content: truncateString(r.content, truncateLength),
  }));

  // 第二步：从末尾（最新）向开头（最老）遍历，贪心地塞进预算。
  const kept: ToolResultEntry[] = [];
  let budget = 0;
  for (let i = truncated.length - 1; i >= 0; i--) {
    const entry = truncated[i];
    // 估算这条占多少 token（content + toolName 合计）。
    const cost = estimateTokens(entry.content + entry.toolName);
    if (budget + cost > maxTokens) continue;  // 放不下就跳过（丢弃这条老结果）
    budget += cost;
    kept.unshift(entry);  // unshift = 插到数组头部，保持原时间顺序
  }
  return kept;
}

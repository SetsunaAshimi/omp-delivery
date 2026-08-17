/**
 * todo-cache.ts — 拦截并缓存 agent 的待办列表状态
 *
 * 【Agent 知识】
 * Agent 在执行复杂任务时，会用一个叫 "todo" 的工具维护待办清单（分阶段/分任务）。
 * 每次调用 todo 工具，宿主会发一个 tool_result 事件，其 details.phases 就是最新清单。
 * 本模块拦截这些事件，按会话 ID 缓存最新快照，供 session_stop 时做"是否全做完"判定。
 *
 * 判定规则（在 isAllDone / getPendingItems 里）：
 *   - completed / abandoned 算"了结"（abandoned 是主动放弃，也算不再阻塞）
 *   - pending / in_progress / blocked 算"未完成"，需要继续
 *
 * 【TS 语法速查 / 对比 C++】
 * - `Set<T>`           → 标准库哈希集合，类间 std::unordered_set<T>。.has(x) 判断元素在不在。
 * - `static` 方法      → 类的静态方法，不依赖实例，类间 C++ static 方法。
 *                        用 TodoCache.getPendingItems(...) 调用，无需 new TodoCache()。
 * - `Record<string, unknown>` → 简单对象类型，键 string 值 unknown。类间 std::map<string, anything>。
 * - `as`              → 类型断言(type assertion)：告诉编译器"我知道这是某个类型"。
 *                        det as Record<string,unknown> = 把 unknown 当成对象用。类间 static_cast。
 * - `Array.isArray(x)` → 判断 x 是否真为数组（运行期检查）。TS 的类型不够，需此函数确认。
 * - `for...of`        → 遍历可迭代对象的元素，类间 range-for。
 */

import type { TodoPhase, TodoSnapshot } from "./types";

/**
 * "未完成"状态集合。用 Set 是为了 O(1) 的 .has() 查询。
 * 对应 C++ const std::unordered_set<std::string> PENDING_STATUSES = {...};
 */
const PENDING_STATUSES = new Set(["pending", "in_progress", "blocked"]);

/**
 * 待办缓存：按会话 ID 存最新 todo 快照。
 * 对应 C++ class TodoCache { std::unordered_map<string, TodoSnapshot> snapshots; ... }
 */
export class TodoCache {
  private snapshots = new Map<string, TodoSnapshot>();

  /**
   * 用一次 tool_result 事件更新缓存。
   * 只处理 toolName==="todo" 的事件；其他工具的结果忽略。
   * details 的形状不确定（unknown），需层层校验后才安全使用。
   *
   * @param sessionId 会话 ID
   * @param toolName  产生该结果的工具名
   * @param details   工具返回的附加数据（todo 工具会在里面放 phases）
   */
  update(sessionId: string, toolName: string, details: unknown): void {
    // 只关心 todo 工具。
    if (toolName !== "todo") return;
    // details 得是个对象（不是 null/数字等）。
    if (!details || typeof details !== "object") return;
    // 把 unknown 断言成可索引的对象类型，才能安全访问 .phases 字段。
    const det = details as Record<string, unknown>;
    // phases 必须是真数组（todo 工具约定放阶段数组在此）。
    if (!Array.isArray(det.phases)) return;
    // 校验通过，存最新快照。
    this.snapshots.set(sessionId, {
      phases: det.phases as TodoPhase[],  // 断言成强类型数组
      hasTodos: true,
    });
  }

  /** 取指定会话的快照。没缓存过返回空快照（hasTodos=false）。 */
  get(sessionId: string): TodoSnapshot {
    return this.snapshots.get(sessionId) ?? { phases: null, hasTodos: false };
  }

  /** 清除指定会话的缓存（session_start 时重置用）。 */
  clear(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  /**
   * 静态工具：从阶段列表里提取所有"未完成"任务的内容描述。
   * 用于展示给 agent："这几件事还没做"。
   */
  static getPendingItems(phases: TodoPhase[] | null): string[] {
    if (!phases) return [];
    const pending: string[] = [];
    for (const phase of phases) {
      // 防御：tasks 可能不是数组（数据异常），跳过。
      if (!Array.isArray(phase.tasks)) continue;
      for (const task of phase.tasks) {
        if (PENDING_STATUSES.has(task.status)) {
          pending.push(task.content);
        }
      }
    }
    return pending;
  }

  /**
   * 静态工具：判断阶段列表是否"全部了结"。
   * 注意：空列表/null 返回 false（语义是"没 todo 数据"，不等于"全做完"）。
   * 至少要有一条 completed/abandoned 才返回 true。
   *
   * 这个语义在 index.ts 的 budget 降级分支里被特别处理：
   *   !todos.hasTodos || TodoCache.isAllDone(...)
   * 即"没用 todo"也算满足（避免没 todo 的项目永远 need_user）。
   */
  static isAllDone(phases: TodoPhase[] | null): boolean {
    if (!phases || phases.length === 0) return false;
    let hasAny = false;
    for (const phase of phases) {
      if (!Array.isArray(phase.tasks)) continue;
      for (const task of phase.tasks) {
        hasAny = true;  // 至少见到一条任务
        // 只要有一条不是 completed/abandoned，就没全做完。
        if (task.status !== "completed" && task.status !== "abandoned") {
          return false;
        }
      }
    }
    return hasAny;  // 有任务且全了结 → true；一条任务都没有 → false
  }
}

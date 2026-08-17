/**
 * test-runner.ts — 执行验证用测试命令
 *
 * 【Agent 知识】
 * Agent 改完代码后，怎么知道改对了？最客观的信号是跑测试。
 * 用户在 delivery-config.yml 里配 testCommand（如 "npm test" / "cargo test"）。
 * 本模块在每次 session_stop 时跑一次，用退出码判断成败：
 *   exit 0 = 通过；非 0 = 失败；超时 = 需要人介入。
 *
 * 【为什么注入 exec 函数而不是直接调 system()】
 * 依赖注入(dependency injection)：把执行函数作为参数传进来，而不是在模块里直接调用。
 * 好处：单元测试可以传一个假的 exec（mock），不真的跑 bash，测试就快速且隔离。
 * 对应 C++ 的做法：函数签名是 std::function<int(string)> 而非直接 system()。
 *
 * 【TS 语法速查 / 对比 C++】
 * - `export type ExecFn = (a: string) => Promise<X>` → 定义函数类型别名。
 *        类间 C++ using ExecFn = std::function<std::future<X>(std::string)>;
 * - `Promise<X>`        → 异步结果，类间 std::future<X>。必须用 await 等待。
 * - `async function`    → 标记函数为异步，内部可用 await。类间 返回 future 的函数。
 * - `await expr`        → 阻塞等异步操作完成，拿到结果值。不阻塞线程（事件循环继续）。
 * - `{ signal?: AbortSignal }` → 对象类型参数，字段带 ? 表示可选。
 *        AbortSignal 是 Web 标准，用于"取消"异步操作（类间一个 cancellation token）。
 * - `String(e)`         → 把任意异常对象转成字符串。类间把 exception 转成 message。
 */

import type { DeliveryConfig, TestResult } from "./types";

/**
 * exec 函数的类型签名：与宿主 pi.exec 的形状一致。
 * - command: 要执行的程序（如 "bash"）
 * - args:    参数数组（如 ["-c", "npm test"]）
 * - options: 可选，含 signal（取消信号）、timeout（毫秒）、cwd（工作目录）
 * 返回 stdout/stderr/code/killed 的异步结果。
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/**
 * 运行配置好的测试命令。
 *
 * @param exec   注入的执行函数（通常传 pi.exec）
 * @param config 配置对象（取 testCommand / testTimeout）
 * @param cwd    工作目录（传给 exec，让测试在项目根跑）
 * @returns      TestResult，描述跑没跑、过没过、超没超时
 */
export async function runTest(
  exec: ExecFn,
  config: DeliveryConfig,
  cwd: string,
): Promise<TestResult> {
  // 没配 testCommand → 跳过测试检查。返回 ran=false, passed=true（不阻塞）。
  // passed=true 是"优雅降级"：没测试不算失败。
  if (!config.testCommand) {
    return { ran: false, passed: true, timedOut: false, output: "", exitCode: null };
  }

  try {
    // 用 bash -c 跑用户配的命令串。
    // ["-c", config.testCommand] 让 bash 把整串当一条命令执行（支持管道、&& 等）。
    // timeout 转毫秒（config 是秒）。
    const result = await exec("bash", ["-c", config.testCommand], {
      timeout: config.testTimeout * 1000,
      cwd,
    });
    return {
      ran: true,
      // code===0 且没被 kill（超时宿主会 kill 进程）才算通过。
      passed: result.code === 0 && !result.killed,
      timedOut: result.killed,  // killed=true 通常是超时强杀
      output: result.stdout + result.stderr,
      // 超时被杀时没有有意义的退出码，置 null。
      exitCode: result.killed ? null : result.code,
    };
  } catch (e) {
    // exec 自身抛异常（如 spawn 失败、signal 中断）：算"跑了但失败"，不算超时。
    return {
      ran: true,
      passed: false,
      timedOut: false,
      output: String(e),
      exitCode: null,
    };
  }
}

/**
 * config.ts — 加载并解析 delivery-config.yml
 *
 * 【Agent 知识】
 * omp 扩展的配置约定：项目级放在 .omp/extensions/delivery/delivery-config.yml，
 * 用户级放在 ~/.omp/agent/extensions/delivery-config.yml。项目级优先。
 * 没有配置文件 → 用默认值（DEFAULT_CONFIG）。
 *
 * 【为什么自己写 YAML 解析器】
 * 完整 YAML 规范复杂（嵌套、锚点、多行字符串），但 delivery 的配置是扁平的
 * key: value，无需引入 js-yaml 依赖。这里实现一个极简的行级解析器。
 *
 * 【TS 语法速查 / 对比 C++】
 * - `import { x } from "node:fs"` → 从 Node 标准库导入。node: 前缀表示 Node 内置模块。
 *        类间 #include <fstream> 等。
 * - `process.cwd()`   → 进程当前工作目录，类间 getcwd()。
 * - `resolve(...)`    → path 模块的路径拼接，把多段拼成绝对路径。类间 std::filesystem::path / operator/。
 * - `homedir()`       → 用户主目录，类间 getenv("HOME")。
 * - `readFileSync(p, "utf-8")` → 同步读文件为字符串。类间 std::ifstream + stringstream。
 * - `existsSync(p)`  → 检查路径是否存在。类间 std::filesystem::exists。
 * - `keyof Type`      → 取类型的所有键的联合。keyof DeliveryConfig = "enabled"|"judgeModel"|...
 *        用于运行期"这个键属于配置吗"的检查。
 * - `Object.entries(obj)` → 把对象的键值对变成 [string, string][] 数组，便于遍历。
 * - `{ ...DEFAULT_CONFIG }` → 浅拷贝默认配置，得到独立副本可改。类间拷贝构造。
 * - 模板字符串 `...${expr}...` → 反引号包裹，${} 内嵌表达式。类间 std::format / printf。
 */

import type { DeliveryConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

/**
 * 找行内注释 '#' 的起始位置，但忽略被引号包裹的 '#'。
 * 例：a: "x#y" # comment → 应返回 " # comment" 的 '#' 位置，跳过 "x#y" 里的 '#'。
 *
 * 用状态机遍历：inSingle/inDouble 标记当前是否在单/双引号内。
 * 只有在引号外遇到 '#' 才是注释起点。
 * 返回 -1 表示无注释。
 */
function findCommentStart(s: string): number {
  let inSingle = false;  // 当前是否在单引号串内
  let inDouble = false;  // 当前是否在双引号串内
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;       // 单引号翻转（不在双引号内）
    else if (ch === '"' && !inSingle) inDouble = !inDouble;  // 双引号翻转（不在单引号内）
    else if (ch === "#" && !inSingle && !inDouble) return i; // 引号外的 # → 注释起点
  }
  return -1;  // 全行无注释
}

/**
 * 极简扁平 YAML 解析器：把 "key: value" 行解析成 { key: value } 对象。
 * 不支持嵌套、列表、多行字符串——只处理 delivery 配置这种扁平结构。
 * 值都先存为原始 string（含引号），后续由 coerce 转类型。
 */
export function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    let trimmed = line.trim();  // 去首尾空白
    if (!trimmed || trimmed.startsWith("#")) continue;  // 空行或整行注释 → 跳过
    // 去行内注释（保护引号内的 '#'）。
    const hash = findCommentStart(trimmed);
    if (hash >= 0) trimmed = trimmed.slice(0, hash).trim();
    // 找第一个冒号分隔 key 和 value。
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;  // 无冒号 → 不是配置行，跳过
    const key = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();
    out[key] = val;  // 值先存原始串（可能带引号）
  }
  return out;
}

/**
 * 去掉值首尾的配对引号（单或双）。
 * 不匹配（只一端有引号）则原样返回。
 */
function stripQuotes(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);  // 去首尾各 1 字符
  }
  return val;
}

/**
 * 把字符串值按目标字段类型"强制转换"(coerce)。
 * 依据：看 DEFAULT_CONFIG 里同名字段的类型是什么，照着转。
 * - 布尔：val === "true"
 * - 数字：Number(val)，非法则回退默认值
 * - 其他：去引号的字符串
 * 空串返回 undefined（表示"未提供"，调用方据此跳过赋值）。
 */
function coerce(key: string, val: string, defaults: DeliveryConfig): unknown {
  if (val === "") return undefined;
  // 查默认值，用 typeof 判断目标类型。
  const defaultVal = defaults[key as keyof DeliveryConfig];
  if (typeof defaultVal === "boolean") return val === "true";       // 字符串 → 布尔
  if (typeof defaultVal === "number") {
    const n = Number(val);                                           // 字符串 → 数字
    return Number.isFinite(n) ? n : defaultVal;                     // 非法 → 默认值
  }
  return stripQuotes(val);  // 字符串字段：去引号
}

/**
 * 计算项目级配置文件的绝对路径。
 * process.cwd() 是 omp 运行时的工作目录（通常就是项目根）。
 */
export function resolveConfigPath(): string {
  return resolve(process.cwd(), ".omp", "extensions", "delivery", "delivery-config.yml");
}

/**
 * 加载配置：按"项目级 → 用户级 → 默认"优先级查找。
 * 解析失败也不抛异常，回退默认值——配置错误绝不能让扩展崩溃。
 *
 * @param configPath 项目级路径（通常由 resolveConfigPath 得到）
 * @param logger     日志对象，用于记录加载过程
 * @returns          完整的 DeliveryConfig（含所有字段）
 */
export function loadConfig(
  configPath: string,
  logger: { warn: (m: string) => void; info: (m: string) => void },
): DeliveryConfig {
  // 用户级配置路径：~/.omp/agent/extensions/delivery-config.yml
  const userPath = resolve(
    homedir(),
    ".omp",
    "agent",
    "extensions",
    "delivery-config.yml",
  );

  // 三级 fallback：项目级 → 用户级 → 无（用默认）。
  // 注意这是三元条件表达式 a ? b : c ? d : e，类间嵌套 if-else。
  const path = existsSync(configPath)
    ? configPath
    : existsSync(userPath)
      ? userPath
      : null;

  if (!path) {
    logger.info("delivery: no config file found, using defaults");
    return { ...DEFAULT_CONFIG };  // 拷贝一份默认配置返回
  }

  try {
    const text = readFileSync(path, "utf-8");
    const parsed = parseFlatYaml(text);
    // 从默认配置开始，逐字段用解析到的值覆盖。
    const config = { ...DEFAULT_CONFIG };
    for (const [key, val] of Object.entries(parsed)) {
      // 只认 DEFAULT_CONFIG 里已知的键，忽略陌生键。
      if (key in DEFAULT_CONFIG) {
        const coerced = coerce(key, val, DEFAULT_CONFIG);
        if (coerced !== undefined) {
          // 把 config 当成可索引对象，按字符串键赋值。
          (config as Record<string, unknown>)[key] = coerced;
        }
      }
    }
    logger.info("delivery: config loaded");
    return config;
  } catch (e) {
    // 解析失败：记录警告，回退默认。绝不抛异常。
    logger.warn(`delivery: config parse failed: ${String(e)}`);
    return { ...DEFAULT_CONFIG };
  }
}

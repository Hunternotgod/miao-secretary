/**
 * 统一错误信息提取
 *
 * Tauri invoke 失败时 reject 的通常是一段字符串（后端 Rust 返回的 error），
 * 而不是带 .message 的 Error 对象。这个函数把各种形态的错误都转成可读字符串。
 */
export function toErrorMessage(e: unknown): string {
  if (e == null) return "未知错误";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 错误严重等级
 * - warn: 黄色，可自动重试（瞬时故障：网络超时、后端重启、5xx）
 * - error: 红色，不可自动重试（用户操作错：4xx、配置错、venv 缺依赖）
 */
export type ErrorSeverity = "warn" | "error";

export interface ClassifiedError {
  retryable: boolean;
  severity: ErrorSeverity;
  userMessage: string;
}

/**
 * 把异常分类：决定前端要不要自动重试 + 用什么颜色展示
 *
 * 规则（按顺序匹配，先命中先返回）：
 *   1. 后端启动超时 / venv 提示  → 不可重试，红色（用户必须手动装依赖）
 *   2. HTTP 4xx                  → 不可重试，红色（用户输入错，AI Key / 路径）
 *   3. HTTP 5xx / 超时 / 拒连    → 可重试，黄色（瞬时故障，等会儿就好）
 *   4. 其它                      → 不可重试，黄色（保守兜底，避免误重试敏感操作）
 */
export function classifyError(e: unknown): ClassifiedError {
  const msg = toErrorMessage(e);
  const lower = msg.toLowerCase();

  if (msg.includes("启动超时") || lower.includes("venv")) {
    return { retryable: false, severity: "error", userMessage: msg };
  }
  if (/HTTP 4\d\d/.test(msg)) {
    return { retryable: false, severity: "error", userMessage: msg };
  }
  if (
    /HTTP 5\d\d/.test(msg) ||
    msg.includes("超时") ||
    lower.includes("timeout") ||
    lower.includes("econnrefused") ||
    lower.includes("failed to fetch")
  ) {
    return { retryable: true, severity: "warn", userMessage: msg };
  }
  return { retryable: false, severity: "warn", userMessage: msg };
}

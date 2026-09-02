/**
 * Tauri 命令封装
 */
import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  version: string;
  platform: string;
  data_dir: string;
}

export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export async function startSidecar(sidecarName: string): Promise<number> {
  return invoke<number>("start_sidecar", { sidecarName });
}

/**
 * 测试 AI API 连接（通过 Rust 端 HTTP，绕过 WebView CORS）
 * @returns 成功返回 "✅ ...", 失败抛 Error 带详细原因
 */
export async function testAIConnection(params: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  chatPath?: string;
  maxTokensField?: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  return invoke<string>("test_ai_connection", {
    apiBaseUrl: params.apiBaseUrl,
    apiKey: params.apiKey,
    model: params.model,
    chatPath: params.chatPath,
    maxTokensField: params.maxTokensField,
    extraHeaders: params.extraHeaders,
  });
}

/**
 * 通用 HTTP POST 请求（通过 Rust 端）
 */
export async function httpPost(params: {
  url: string;
  headers: Record<string, string>;
  body: any;
  timeoutSecs?: number;
}): Promise<any> {
  return invoke<any>("http_post", {
    url: params.url,
    headers: params.headers,
    body: params.body,
    timeoutSecs: params.timeoutSecs,
  });
}

/** 开发模式启动 Python 后端（uvicorn :8765），返回进程 pid */
export async function devStartSidecar(): Promise<number> {
  return invoke<number>("dev_start_sidecar");
}

/**
 * 通用请求本机 Python 后端。
 * 失败时 Error.message 已拼好后端返回的 error + hint（人话）。
 */
export async function sidecarRequest<T = any>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  // Tauri invoke 把 Rust 返的 String 原样回给前端（不会自动 JSON.parse）。
  // 没有 JSON.parse 的话 setStatus(s) 把整个 JSON 文本存进 state，
  // 后续 status.supported 是 undefined → 永远显示「暂不支持」。
  const raw = await invoke<string>("sidecar_request", {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  });
  return JSON.parse(raw) as T;
}

/**
 * 拉取 OpenAI 兼容 API 的可用模型列表
 * （走 Rust 端 HTTP，避开 WebView CORS）
 * @returns 模型 id 数组（按字母排序）
 */
export async function listModels(params: {
  apiBaseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const models = await invoke<string[]>("list_models", {
    apiBaseUrl: params.apiBaseUrl,
    apiKey: params.apiKey,
  });
  return models.sort();
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Manager;

// ============================================================
//  Tauri Commands
// ============================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub data_dir: String,
}

/// 获取应用信息
#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        data_dir,
    })
}

/// 启动 Python sidecar
#[tauri::command]
async fn start_sidecar(
    app: tauri::AppHandle,
    sidecar_name: String,
) -> Result<u32, String> {
    use tauri_plugin_shell::ShellExt;

    let sidecar_command = app
        .shell()
        .sidecar(&sidecar_name)
        .map_err(|e| format!("创建 sidecar 失败: {}", e))?
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败: {}", e))?;

    Ok(sidecar_command.1.pid())
}

/// 测试 AI API 连接（绕过 WebView CORS 限制）
///
/// 由 Rust 端直接做 HTTP 请求，不受 Tauri WebView 的同源策略限制。
/// 返回 Ok("✅ ...") 表示成功，Err("❌ ...") 表示失败（带详细原因）。
#[tauri::command]
async fn test_ai_connection(
    api_base_url: String,
    api_key: String,
    model: String,
    chat_path: Option<String>,
    max_tokens_field: Option<String>,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let path = chat_path.unwrap_or_else(|| "/chat/completions".to_string());
    let url = format!("{}{}", api_base_url.trim_end_matches('/'), path);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| format!("创建 HTTP client 失败: {}", e))?;

    // 构建请求体
    let tokens_field = max_tokens_field.unwrap_or_else(|| "max_tokens".to_string());
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "temperature": 0.3,
    });
    body[tokens_field] = serde_json::json!(10);

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body);

    if let Some(extra) = extra_headers {
        for (k, v) in extra {
            req = req.header(&k, &v);
        }
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {}（检查 URL 和 Key）", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .unwrap_or_else(|_| "(无法读取响应体)".to_string());

    if status.is_success() {
        Ok(format!("✅ 连接成功（HTTP {}）", status.as_u16()))
    } else {
        // 尝试从响应体里提取 MiniMax 风格的错误信息
        let detail = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            // MiniMax 错误格式: { "error": { "message": "...", "type": "..." } }
            // 标准 OpenAI 错误: { "error": { "message": "...", "type": "..." } }
            json.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or(&text)
                .to_string()
        } else {
            text
        };

        Err(format!(
            "HTTP {} {}\n{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            detail
        ))
    }
}

/// 通用 HTTP POST 请求（用于通知分析等其他场景）
#[tauri::command]
async fn http_post(
    url: String,
    headers: HashMap<String, String>,
    body: serde_json::Value,
    timeout_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs.unwrap_or(30)))
        .build()
        .map_err(|e| format!("创建 HTTP client 失败: {}", e))?;

    let mut req = client.post(&url).json(&body);
    for (k, v) in &headers {
        req = req.header(k, v);
    }

    let response = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {}", e))
    } else {
        Err(format!("HTTP {}: {}", status.as_u16(), text))
    }
}


/// 拉取 OpenAI 兼容 API 的可用模型列表
///
/// 调用 `${apiBaseUrl}/models`，返回 `{"data": [{"id": "model-name", ...}, ...]}` 中的 id 列表。
/// 用于 AI 配置页"填 Key 后自动拉模型"流程，避开 WebView CORS。
#[tauri::command]
async fn list_models(
    api_base_url: String,
    api_key: String,
    timeout_secs: Option<u64>,
) -> Result<Vec<String>, String> {
    // 去掉结尾的 /，拼 /models
    let base = api_base_url.trim_end_matches('/');
    let url = format!("{}/models", base);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs.unwrap_or(15)))
        .build()
        .map_err(|e| format!("创建 HTTP client 失败: {}", e))?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }

    // 解析 {"data": [{"id": "..."}]}
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("JSON 解析失败: {}", e))?;

    let models: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if models.is_empty() {
        return Err("返回的模型列表为空".to_string());
    }

    Ok(models)
}

// ==================== 本地数据通道 ====================

const SIDECAR_BASE_URL: &str = "http://127.0.0.1:8765";

/// 开发模式启动本地数据通道。
///
/// PC 微信本地数据通道为闭源组件，不在本开源仓库中提供；官方发布版已内置。
#[tauri::command]
async fn dev_start_sidecar() -> Result<u32, String> {
    Err("微信数据通道为闭源组件，仅随官方发布版提供".to_string())
}

/// 通用转发：前端 → Rust → 本地数据通道(127.0.0.1:8765)
///
/// 非 2xx 时把通道返回的 detail{error,hint} 拼成可读错误信息返回。
#[tauri::command]
async fn sidecar_request(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    let url = format!(
        "{}{}",
        SIDECAR_BASE_URL,
        if path.starts_with('/') { path } else { format!("/{}", path) }
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120)) // 数据通道初始化可能耗时
        .build()
        .map_err(|e| format!("创建 HTTP client 失败: {}", e))?;

    let req_builder = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => {
            let mut r = client.post(&url);
            if let Some(b) = body {
                r = r.header("Content-Type", "application/json").body(b);
            }
            r
        }
        other => return Err(format!("sidecar_request 不支持的方法: {}", other)),
    };

    let response = req_builder
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                "无法连接本地数据通道(127.0.0.1:8765)。请确认通道可用，或改用官方发布版。".to_string()
            } else {
                format!("请求本地数据通道失败: {}", e)
            }
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status.is_success() {
        Ok(text)
    } else {
        // 通道错误体格式：{"detail": {"error": ..., "hint": ...}} 或 {"detail": "..."}
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let detail = v.get("detail").cloned().unwrap_or_default();
        let (err, hint) = match detail {
            serde_json::Value::Object(obj) => (
                obj.get("error").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                obj.get("hint").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            ),
            serde_json::Value::String(s) => (s, String::new()),
            _ => (text.clone(), String::new()),
        };
        let msg = if hint.is_empty() { err } else { format!("{}\n💡 {}", err, hint) };
        if msg.is_empty() {
            Err(format!("HTTP {}: {}", status.as_u16(), text))
        } else {
            Err(msg)
        }
    }
}



/// 生产模式启动 bundled sidecar（自动尝试多个命名约定）
#[tauri::command]
async fn start_bundled_sidecar(app: tauri::AppHandle) -> Result<u32, String> {
    use tauri_plugin_shell::ShellExt;
    let candidates = ["binaries/miao-backend", "miao-backend", "miao-backend.exe"];
    let mut last_err = String::from("no candidate tried");
    for name in &candidates {
        match app.shell().sidecar(name) {
            Ok(cmd) => match cmd.spawn() {
                Ok((_rx, child)) => {
                    eprintln!("sidecar spawned via name={name}, pid={}", child.pid());
                    return Ok(child.pid());
                }
                Err(e) => { last_err = format!("spawn {name}: {e}"); continue; }
            },
            Err(e) => { last_err = format!("sidecar({name}): {e}"); continue; }
        }
    }
    Err(last_err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // 默认全局 Info:屏蔽 hyper/reqwest 的 DEBUG/TRACE 噪音
                // 模块级单独压到 warn:reqwest / hyper / hyper_util / h2 / tower / rustls / tao / wry
                // 用户反馈:控制台一直在跳超长 trace 日志,看着误以为是 bug
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .level_for("reqwest", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("hyper", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("hyper_util", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("h2", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("tower", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("rustls", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("tao", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for("wry", tauri_plugin_log::log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            start_sidecar,
            start_bundled_sidecar,
            dev_start_sidecar,
            sidecar_request,
            test_ai_connection,
            http_post,
            list_models
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

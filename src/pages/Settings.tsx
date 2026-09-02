/**
 * 设置页(v0-4 重构)
 * Tab 列表:AI 配置 / AI 规则 / 通用 / 数据 / 关于
 * AI 规则独立成 tab(v0-4 之前塞在 AI 配置末尾,被淹没)
 */
import { useEffect, useState } from "react";
import {
  Settings as SettingsIcon,
  Key, Info, RotateCcw, Trash2, Check, RefreshCw, Sparkles,
  Bot, Database, HardDrive, LifeBuoy,
} from "lucide-react";
import appIcon from "../assets/app-icon.png";
import { useApp } from "../lib/store/AppContext";
import { getAppInfo, listModels, testAIConnection } from "../lib/tauri/commands";
import { AI_PRESETS, BUILTIN_RULES, BUILTIN_TEMPLATES, clearConfig } from "../lib/store/config";
import type { AIProvider, AIConfig } from "../lib/ai/types";
import type { AppConfig } from "../lib/store/config";
import type { AIAdvancedConfig } from "../lib/ai/types";
import {
  db,
  clearAllNotifications,
  clearAICache,
} from "../lib/store/db";
import { toast } from "../components/ui/Toast";

export default function Settings() {
  const { config, update } = useApp();
  const [activeTab, setActiveTab] = useState<"ai" | "rules" | "general" | "data" | "about">("ai");
  return (
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-3">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <SettingsIcon className="w-5 h-5" />
          设置
        </h1>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* 侧边标签 */}
        <aside className="w-48 bg-gray-50 border-r border-gray-200 p-2">
          {([
            { id: "ai", icon: Key, label: "AI 配置" },
            { id: "rules", icon: Bot, label: "AI 规则" },
            { id: "general", icon: RotateCcw, label: "通用" },
            { id: "data", icon: Database, label: "数据" },
            { id: "about", icon: Info, label: "关于" },
          ] as const).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full text-left px-3 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${
                  activeTab === tab.id
                    ? "bg-white text-brand-700 font-medium shadow-sm"
                    : "text-gray-700 hover:bg-white"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </aside>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl">
            <SettingsHelpBanner config={config} />
            {activeTab === "ai" && <AISettings config={config.ai} onSave={(ai) => update({ ai })} />}
            {activeTab === "rules" && config.ai && (
              <RulesSettings config={config.ai} onSave={(ai) => update({ ai })} />
            )}
            {activeTab === "general" && <GeneralSettings />}
            {activeTab === "data" && <DataSettings />}
            {activeTab === "about" && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings 顶部固定帮助条
 * - 重新进行新手引导(把 onboarded 改回 false,AppShell 立刻重渲染 Onboarding)
 * - 测试当前 AI 连接(任何 tab 都能跑)
 * - 显示最近一次连接结果
 */
function SettingsHelpBanner({ config }: { config: AppConfig }) {
  const { update } = useApp();
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const handleRerun = () => {
    if (confirm("重新进行新手引导?\n\n当前 AI 配置会保留,但会重新走一遍 4 步选择。")) {
      update({ onboarded: false });
    }
  };

  const handleTest = async () => {
    const ai = config.ai;
    if (!ai?.apiKey) {
      setTestMsg({ ok: false, message: "请先在「AI 配置」填入 API 密钥" });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const msg = await testAIConnection({
        apiBaseUrl: ai.apiBaseUrl,
        apiKey: ai.apiKey,
        model: ai.model,
      });
      setTestMsg({ ok: true, message: msg });
      toast.success("✅ AI 连接正常");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setTestMsg({ ok: false, message: m });
      toast.error("❌ 连接失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-3 mb-4">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <LifeBuoy className="w-5 h-5 text-amber-600" />
          <span className="font-medium text-amber-900">需要帮助?</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleRerun}
            className="text-sm px-3 py-1.5 rounded-md bg-white border border-amber-300 text-amber-800 hover:bg-amber-50"
          >
            🆘 重新进行新手引导
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="text-sm px-3 py-1.5 rounded-md bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {testing && <RefreshCw className="w-3 h-3 animate-spin" />}
            {testing ? "测试中…" : "🩺 测试当前 AI 连接"}
          </button>
        </div>
        {testMsg && (
          <div className={`text-xs flex-1 min-w-full mt-1 ${testMsg.ok ? "text-green-700" : "text-red-700"}`}>
            {testMsg.ok ? "✅" : "❌"} {testMsg.message}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 「AI 规则」独立 tab(v0-4 搬到顶层)
 * 把用户的「想让 AI 怎么对待群消息」集中配置:内置规则勾选 + 模板一键套用 + 自由补充
 *
 * 保存策略:每次勾选 / 输入 / 套用模板都立刻 onSave(实时写回 config),
 * 离开 tab 不会丢失修改。
 */
function RulesSettings({ config, onSave }: {
  config: AIConfig | null;
  onSave: (ai: AIConfig) => void;
}) {
  const [customRules, setCustomRules] = useState<string[]>(config?.customRules ?? []);
  const [customText, setCustomText] = useState<string>(config?.customText ?? "");

  // 任何修改 → 实时写回 ai(合并保留其它字段)
  const persist = (nextRules: string[], nextText: string) => {
    if (!config) return;
    onSave({
      ...config,
      customRules: nextRules.length > 0 ? nextRules : undefined,
      customText: nextText.trim() ? nextText.trim() : undefined,
    });
  };

  const toggleRule = (id: string) => {
    const next = customRules.includes(id)
      ? customRules.filter((x) => x !== id)
      : [...customRules, id];
    setCustomRules(next);
    persist(next, customText);
  };

  const applyTemplate = (templateId: string) => {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    setCustomText(tpl.customText);
    setCustomRules(tpl.ruleIds);
    persist(tpl.ruleIds, tpl.customText);
  };

  const resetUserRules = () => {
    if (!confirm("清空所有自定义规则,恢复默认?")) return;
    setCustomRules([]);
    setCustomText("");
    persist([], "");
  };

  const hasAny = customRules.length > 0 || customText.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
          🤖 AI 规则
        </h2>
        <p className="text-sm text-gray-500">
          在默认规则后面追加你自己的指令,让 AI 按你的偏好处理群消息
          <br />
          <span className="text-xs text-gray-400">
            例:「@我的消息算 urgent」「我是家长,班主任的通知至少 important」「实习招聘一律关注」
          </span>
        </p>
      </div>

      {/* 模板画廊 */}
      <div className="card">
        <h3 className="font-medium mb-2 flex items-center gap-2 text-sm">
          <Sparkles className="w-4 h-4 text-amber-500" />
          一键套用模板
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {BUILTIN_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => applyTemplate(tpl.id)}
              className="text-left p-3 bg-white border border-gray-200 rounded-md hover:border-brand-400 hover:bg-brand-50 transition"
              title={tpl.description}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-lg">{tpl.emoji}</span>
                <span className="font-medium text-sm">{tpl.name}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{tpl.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 预设规则 */}
      <div className="card">
        <h3 className="font-medium mb-3 text-sm">常见规则(可多选)</h3>
        <div className="space-y-1.5">
          {BUILTIN_RULES.map((rule) => (
            <label
              key={rule.id}
              className="flex items-start gap-2 text-sm cursor-pointer hover:bg-gray-50 -mx-2 px-2 py-2 rounded"
            >
              <input
                type="checkbox"
                checked={customRules.includes(rule.id)}
                onChange={() => toggleRule(rule.id)}
                className="mt-0.5 rounded"
              />
              <div className="flex-1 min-w-0">
                <div className="text-gray-800">{rule.label}</div>
                <div className="text-xs text-gray-500">{rule.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* 自由补充 */}
      <div className="card">
        <h3 className="font-medium mb-2 text-sm">
          自由补充
          <span className="ml-2 text-xs text-gray-400 font-normal">可选</span>
        </h3>
        <textarea
          className="input text-sm w-full"
          rows={5}
          value={customText}
          onChange={(e) => {
            setCustomText(e.target.value);
            persist(customRules, e.target.value);
          }}
          placeholder={'例: 我特别关注实习招聘信息,看到「JD」「招聘」「内推」字样一律标 important。或: 我是家长,班主任发的消息至少 important。'}
        />
        <div className="text-xs text-gray-400 mt-1">
          {customText.trim()
            ? `已写 ${customText.length} 字,会和勾选规则一起追加到默认 prompt 后`
            : "不填则只使用勾选的预设规则"}
        </div>
      </div>

      {/* 操作 + 当前预览 */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={resetUserRules}
          disabled={!hasAny}
          className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-40 flex items-center gap-1"
        >
          <RotateCcw className="w-3 h-3" />
          恢复默认
        </button>
        {hasAny && (
          <span className="text-xs text-green-600">✓ 已自动保存</span>
        )}
      </div>

      {hasAny && (
        <details className="text-xs">
          <summary className="cursor-pointer text-brand-700 hover:underline">
            🔍 查看本次会追加到 AI 的完整提示
          </summary>
          <pre className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded text-xs whitespace-pre-wrap text-gray-700 max-h-48 overflow-y-auto">
{[
  "【用户自定义规则 - 优先级高于默认规则】",
  ...customRules
    .map((id) => BUILTIN_RULES.find((r) => r.id === id)?.promptText ?? "")
    .filter(Boolean),
  ...(customText.trim() ? ["", customText.trim()] : []),
].join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

function AISettings({ config, onSave }: { config: AIConfig | null; onSave: (ai: AIConfig) => void }) {
  const [provider, setProvider] = useState<AIProvider>(config?.provider || "deepseek");
  const [apiBaseUrl, setApiBaseUrl] = useState(config?.apiBaseUrl || AI_PRESETS.deepseek.defaultBaseUrl);
  const [apiKey, setApiKey] = useState(config?.apiKey || "");
  const [model, setModel] = useState(config?.model || AI_PRESETS.deepseek.defaultModel);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 模型列表（从 provider 拉的）
  const [availableModels, setAvailableModels] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // 高级选项
  const [chatPath, setChatPath] = useState(config?.advanced?.chatPath || "/chat/completions");
  const [authHeaderName, setAuthHeaderName] = useState(config?.advanced?.authHeaderName || "Authorization");
  const [authScheme, setAuthScheme] = useState(config?.advanced?.authScheme || "Bearer");
  const [responseContentPath, setResponseContentPath] = useState(config?.advanced?.responseContentPath || "choices.0.message.content");
  const [useMaxCompletionTokens, setUseMaxCompletionTokens] = useState(config?.advanced?.useMaxCompletionTokens || false);
  const [extraHeadersText, setExtraHeadersText] = useState(
    config?.advanced?.extraHeaders ? JSON.stringify(config.advanced.extraHeaders, null, 2) : ""
  );

  // 用户自定义规则已搬到顶层「AI 规则」tab(RulesSettings);这里只读 config
  const customRules = config?.customRules ?? [];
  const customText = config?.customText ?? "";
  // 不需要 setCustomRules/setCustomText —— AISettings 不再修改规则

  const handleProviderChange = (p: AIProvider) => {
    setProvider(p);
    setApiBaseUrl(AI_PRESETS[p].defaultBaseUrl);
    // 不再强制重置 model:用户上次选的可能还能用(provider 切换后同名 model 概率高)
    // 如果用户主动点「加载模型列表」,fetchModels() 会处理不存在的 model
    // 重置高级选项为预设默认值
    setChatPath("/chat/completions");
    setAuthHeaderName("Authorization");
    setAuthScheme("Bearer");
    setResponseContentPath("choices.0.message.content");
    setUseMaxCompletionTokens(false);
    setExtraHeadersText("");
    setTestResult(null);
    setAvailableModels(null);
    setModelsError(null);
    // provider 切换不清空用户的规则(规则跟 provider 无关)
  };



  const handleFetchModels = async () => {
    if (!apiKey) return;
    setFetchingModels(true);
    setModelsError(null);
    try {
      const models = await listModels({ apiBaseUrl, apiKey });
      setAvailableModels(models);
      // 如果当前 model 不在拉到的列表里,默认选第一个
      if (models.length > 0 && !models.includes(model)) {
        setModel(models[0]);
      }
    } catch (e: any) {
      console.error("获取模型列表失败:", e);
      setAvailableModels(null);
      setModelsError(e?.message || String(e) || "获取失败，请检查 API 地址或 Key");
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);

    // 处理额外 headers
    let extraHeaders: Record<string, string> | undefined;
    if (extraHeadersText.trim()) {
      try {
        extraHeaders = JSON.parse(extraHeadersText);
      } catch {
        setTestResult({ ok: false, message: "❌ 连接失败，详情查看 Console" });
        setTesting(false);
        return;
      }
    }

    try {
      // ✅ 通过 Rust 端 HTTP 发送，绕过 WebView CORS 限制
      const msg = await testAIConnection({
        apiBaseUrl,
        apiKey,
        model,
        chatPath: chatPath || "/chat/completions",
        maxTokensField: useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens",
        extraHeaders,
      });
      console.log(msg);
      setTestResult({ ok: true, message: "✅ 连接成功" });
    } catch (e: any) {
      console.error("测试失败:", e);
      setTestResult({ ok: false, message: "❌ 连接失败，详情查看 Console" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    let extraHeaders: Record<string, string> | undefined;
    if (extraHeadersText.trim()) {
      try {
        extraHeaders = JSON.parse(extraHeadersText);
      } catch (e) {
        alert("额外请求头的 JSON 格式错误");
        return;
      }
    }

    const advanced: AIAdvancedConfig = {
      chatPath: chatPath !== "/chat/completions" ? chatPath : undefined,
      authHeaderName: authHeaderName !== "Authorization" ? authHeaderName : undefined,
      authScheme: authScheme !== "Bearer" ? authScheme : undefined,
      responseContentPath: responseContentPath !== "choices.0.message.content" ? responseContentPath : undefined,
      useMaxCompletionTokens: useMaxCompletionTokens || undefined,
      extraHeaders,
    };
    // 清空所有 undefined 字段
    Object.keys(advanced).forEach((k) => {
      if ((advanced as any)[k] === undefined) delete (advanced as any)[k];
    });

    onSave({
      provider,
      apiBaseUrl,
      apiKey,
      model,
      temperature: 0.3,
      advanced: Object.keys(advanced).length > 0 ? advanced : undefined,
      customRules: customRules.length > 0 ? customRules : undefined,
      customText: customText.trim() ? customText.trim() : undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">AI 服务配置</h2>
        <p className="text-sm text-gray-500">配置你使用的 AI 服务 · 密钥仅本地存储</p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">AI 服务</label>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(AI_PRESETS) as AIProvider[]).map((p) => (
            <button
              key={p}
              onClick={() => handleProviderChange(p)}
              className={`p-3 rounded-md border-2 text-left text-sm ${
                provider === p
                  ? "border-brand-500 bg-brand-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div className="font-medium">{AI_PRESETS[p].name}</div>
              <div className="text-xs text-gray-500 mt-0.5">{AI_PRESETS[p].description}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">服务器地址（高级 · 默认即可）</label>
        <input
          type="text"
          className="input"
          value={apiBaseUrl}
          onChange={(e) => setApiBaseUrl(e.target.value)}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">密钥（API Key · 相当于账号密码）</label>
        <input
          type="password"
          className="input font-mono"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-xxx"
          autoComplete="off"
        />
        <div className="text-xs text-gray-500 mt-1">
          🔒 仅存储在本地浏览器，不上传任何服务器
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">AI 模型（默认即可）</label>
        <div className="flex gap-2">
          {availableModels && availableModels.length > 0 ? (
            <select
              className="input flex-1"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {!availableModels.includes(model) && model && (
                <option value={model}>{model}（自定义）</option>
              )}
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="input flex-1"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={AI_PRESETS[provider].defaultModel}
            />
          )}
          <button
            type="button"
            onClick={handleFetchModels}
            disabled={!apiKey || fetchingModels}
            className="btn-secondary shrink-0"
            title="从 provider 拉取可用模型"
          >
            {fetchingModels ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin mr-1" />
                拉取中
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-1 inline" />
                获取模型列表
              </>
            )}
          </button>
        </div>
        {modelsError && (
          <div className="text-xs text-amber-600 mt-1">
            ⚠️ {modelsError}（可手动输入模型名）
          </div>
        )}
        {availableModels && availableModels.length > 0 && (
          <div className="text-xs text-gray-500 mt-1">
            ✓ 已从 {AI_PRESETS[provider].name} 拉到 {availableModels.length} 个模型
          </div>
        )}
      </div>

      {testResult && (
        <div
          className={`p-3 rounded-md text-sm whitespace-pre-wrap ${
            testResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          {testResult.message}
        </div>
      )}

      {/* AI 规则 JSX 已搬到独立 RulesSettings tab(下一行起) */}

      <div className="flex gap-2 pt-4 border-t">
        <details className="mt-4 border border-gray-200 rounded-md">
              <summary className="px-3 py-2 cursor-pointer text-sm text-gray-600 hover:bg-gray-50 select-none">
                ⚙️ 高级选项（一般不用改）
              </summary>
              <div className="p-3 space-y-3 border-t border-gray-200">
                <div>
                  <label className="block text-xs font-medium mb-1 text-gray-700">
                    端点路径
                  </label>
                  <input
                    type="text"
                    className="input text-sm"
                    value={chatPath}
                    onChange={(e) => setChatPath(e.target.value)}
                    placeholder="/chat/completions"
                  />
                  <div className="text-xs text-gray-500 mt-1">
                    Anthropic 兼容：/v1/messages，标准 OpenAI：/chat/completions
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1 text-gray-700">
                      认证 Header
                    </label>
                    <input
                      type="text"
                      className="input text-sm"
                      value={authHeaderName}
                      onChange={(e) => setAuthHeaderName(e.target.value)}
                      placeholder="Authorization"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-gray-700">
                      认证 Scheme
                    </label>
                    <input
                      type="text"
                      className="input text-sm"
                      value={authScheme}
                      onChange={(e) => setAuthScheme(e.target.value)}
                      placeholder="Bearer"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 text-gray-700">
                    响应字段路径
                  </label>
                  <input
                    type="text"
                    className="input text-sm font-mono"
                    value={responseContentPath}
                    onChange={(e) => setResponseContentPath(e.target.value)}
                    placeholder="choices.0.message.content"
                  />
                  <div className="text-xs text-gray-500 mt-1">
                    默认 OpenAI 标准。Anthropic 用 "content.0.text"
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={useMaxCompletionTokens}
                      onChange={(e) => setUseMaxCompletionTokens(e.target.checked)}
                    />
                    <span>使用 max_completion_tokens（新版 OpenAI 风格）</span>
                  </label>
                </div>
                <details>
                  <summary className="text-xs text-gray-500 cursor-pointer">
                    额外请求头（JSON）
                  </summary>
                  <textarea
                    className="input text-xs font-mono mt-2"
                    rows={3}
                    value={extraHeadersText}
                    onChange={(e) => setExtraHeadersText(e.target.value)}
                    placeholder='{"anthropic-version": "2023-06-01"}'
                  />
                </details>
              </div>
            </details>

            <button onClick={handleTest} disabled={testing || !apiKey} className="btn-secondary">
          {testing ? "测试中..." : "测试连接"}
        </button>
        <button onClick={handleSave} disabled={!apiKey} className="btn-primary">
          <Check className="w-4 h-4 mr-1 inline" />
          保存配置
        </button>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { refresh, update } = useApp();

  const handleReonboard = () => {
    if (confirm("回到三步引导重新配置 AI？当前 API 配置会保留但 onboarded 标记会清空。")) {
      // 不用 navigate：AppShell 会根据 onboarded=false 自动渲染 Onboarding
      update({ onboarded: false });
    }
  };

  const handleResetAI = () => {
    if (confirm("清空 AI 配置并重新走引导流程？")) {
      update({ ai: null, onboarded: false });
    }
  };

  const handleReset = () => {
    if (confirm("确定要重置所有数据吗？这会清除配置和监控列表。")) {
      clearConfig();
      refresh();
      // refresh() 后 config.onboarded 变 false，AppShell 自动渲染 Onboarding
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">通用</h2>
        <p className="text-sm text-gray-500">全局设置和数据管理</p>
      </div>

      <div className="card border-blue-200 bg-blue-50">
        <h3 className="font-medium text-blue-900 mb-2">🔄 重新配置 AI</h3>
        <p className="text-sm text-blue-700 mb-3">
          如果想换个 AI 服务、或者当前配置有问题，可以回到引导页重新选择。
        </p>
        <div className="flex gap-2">
          <button onClick={handleReonboard} className="btn-secondary text-blue-700 border-blue-300">
            重新走引导（保留配置）
          </button>
          <button onClick={handleResetAI} className="btn-secondary text-blue-700 border-blue-300">
            清空 AI 重新填
          </button>
        </div>
      </div>

      <div className="card border-amber-200 bg-amber-50/60">
        <h3 className="font-medium text-amber-900 mb-1">🧹 重置与清理</h3>
        <p className="text-sm text-amber-800 mb-3 leading-relaxed">
          把喵秘书恢复到刚装好的状态。一次操作,清单如下:
        </p>
        <ul className="text-xs text-amber-900 space-y-1 mb-3 pl-1">
          <li>🔑 AI 服务配置(API Key / 模型)</li>
          <li>📋 监控列表(已配置的群)</li>
          <li>📝 已生成的日报、待办、话题(IndexedDB)</li>
          <li>📌 置顶的会话</li>
        </ul>
        <button onClick={handleReset} className="btn-secondary text-amber-800 border-amber-300 hover:bg-amber-100">
          <Trash2 className="w-4 h-4 mr-1 inline" />
          重置全部,回到引导
        </button>
      </div>
    </div>
  );
}

/**
 * 数据 Tab:统计 + 存储占用 + 清空
 *
 * - 通知/缓存数量:直接从 IndexedDB count()
 * - 存储占用:navigator.storage.estimate() → {usage, quota}
 *   Tauri WebView 支持这个 API
 */
function DataSettings() {
  const { config, update } = useApp();
  const [stats, setStats] = useState<{
    notifications: number;
    aiCache: number;
    pinned: number;
  } | null>(null);
  const [storage, setStorage] = useState<{
    usage: number;
    quota: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [n, c, p, est] = await Promise.all([
        db.notifications.count(),
        db.aiCache.count(),
        db.pinnedConversations.count(),
        typeof navigator !== "undefined" && navigator.storage?.estimate
          ? navigator.storage.estimate()
          : Promise.resolve({ usage: 0, quota: 0 }),
      ]);
      setStats({ notifications: n, aiCache: c, pinned: p });
      setStorage({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [config]);

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function handleClearCache() {
    if (!confirm("清空 AI 缓存?下次拉取消息会重新调用 AI(可能更慢)。")) return;
    setBusy("cache");
    try {
      await clearAICache();
      await refresh();
      alert("AI 缓存已清空");
    } finally {
      setBusy(null);
    }
  }

  async function handleClearNotifications() {
    if (
      !confirm(
        "清空所有通知?\n\n这会删除所有已生成的摘要、日报、待办。无法恢复!",
      )
    )
      return;
    setBusy("notifications");
    try {
      await clearAllNotifications();
      await refresh();
      alert("所有通知已清空");
    } finally {
      setBusy(null);
    }
  }

  async function handleClearAll() {
    if (
      !confirm(
        "⚠️ 危险操作!\n\n清空所有 IndexedDB 数据(notifications + aiCache + pinned)。\n配置和监控列表不受影响(空监控仍会保留,可在「Monitors」页单独删除)。\n\n无法恢复!",
      )
    )
      return;
    setBusy("all");
    try {
      await db.delete();
      // 删除后需要重新初始化 db 实例,刷新页面让 hooks 重新挂载
      alert("已清空所有数据,即将刷新");
      window.location.reload();
    } catch (e) {
      setBusy(null);
      alert(`清空失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 用户反馈:清空数据后空监控仍残留 → 提供「只清监控列表(不动 IndexedDB)」入口
  async function handleClearMonitors() {
    if (!confirm("确定清空监控列表?\n\n只清 cfg.monitors(配置层面),不影响 IndexedDB 数据。\n清空后所有监控会停止轮询,但已生成的摘要/待办仍会保留在时间线。"))
      return;
    setBusy("monitors");
    try {
      await update({ monitors: [] });
      toast.success("已清空监控列表");
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">数据</h2>
        <p className="text-sm text-gray-500">查看本地存储的聊天分析结果,管理占用空间</p>
      </div>

      {/* 统计 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium flex items-center gap-2">
            <Database className="w-4 h-4" />
            数据统计
          </h3>
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs text-gray-500 hover:text-brand-600 flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
        {loading && !stats ? (
          <div className="text-sm text-gray-400">加载中...</div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-blue-50 rounded-md p-3">
              <div className="text-2xl font-semibold text-blue-700">
                {stats?.notifications ?? 0}
              </div>
              <div className="text-xs text-blue-600 mt-0.5">通知数</div>
            </div>
            <div className="bg-violet-50 rounded-md p-3">
              <div className="text-2xl font-semibold text-violet-700">
                {stats?.aiCache ?? 0}
              </div>
              <div className="text-xs text-violet-600 mt-0.5">AI 缓存</div>
            </div>
            <div className="bg-green-50 rounded-md p-3">
              <div className="text-2xl font-semibold text-green-700">
                {stats?.pinned ?? 0}
              </div>
              <div className="text-xs text-green-600 mt-0.5">置顶会话</div>
            </div>
          </div>
        )}
        {stats && stats.notifications > 0 && (
          <div className="mt-3 text-xs text-gray-500">
            覆盖约 {new Set(
              config.monitors.map((m) => m.chatroomId),
            ).size} 个监控会话
          </div>
        )}
      </div>

      {/* 存储占用 */}
      <div className="card">
        <h3 className="font-medium mb-3 flex items-center gap-2">
          <HardDrive className="w-4 h-4" />
          存储占用
        </h3>
        {storage ? (
          <>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-2xl font-semibold text-gray-700">
                {formatBytes(storage.usage)}
              </span>
              <span className="text-xs text-gray-400">
                / 配额 {formatBytes(storage.quota)}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div
                className="h-2 rounded-full bg-blue-500 transition-all"
                style={{
                  width: `${Math.min(100, (storage.usage / Math.max(1, storage.quota)) * 100).toFixed(2)}%`,
                }}
              />
            </div>
            <div className="text-[10px] text-gray-400 mt-1.5">
              使用率 {((storage.usage / Math.max(1, storage.quota)) * 100).toFixed(4)}%
              · 离爆仓还有 {formatBytes(storage.quota - storage.usage)}
            </div>
            <div className="mt-3 text-xs text-gray-500 bg-gray-50 rounded p-2">
              💡 这只是 IndexedDB 的占用。我们的数据(摘要 + 缓存)远小于微信原始消息,
              即使重度使用一年也不会超过 50 MB。
            </div>
          </>
        ) : (
          <div className="text-sm text-gray-400">无法获取存储信息</div>
        )}
      </div>

      {/* 清理 */}
      <div className="card">
        <h3 className="font-medium mb-3">清理数据</h3>
        <div className="space-y-2">
          <button
            onClick={handleClearCache}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 rounded-md border border-gray-200 hover:border-brand-400 hover:bg-brand-50 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm flex items-center gap-2">
              <Trash2 className="w-3.5 h-3.5" />
              清空 AI 缓存
              {busy === "cache" && <RefreshCw className="w-3 h-3 animate-spin ml-auto" />}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              不影响已生成的摘要。下次拉取会重新调 AI(更慢但结果一样)。
            </div>
          </button>

          <button
            onClick={handleClearNotifications}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 rounded-md border border-orange-200 hover:border-orange-400 hover:bg-orange-50 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm text-orange-700 flex items-center gap-2">
              <Trash2 className="w-3.5 h-3.5" />
              清空所有通知
              {busy === "notifications" && (
                <RefreshCw className="w-3 h-3 animate-spin ml-auto" />
              )}
            </div>
            <div className="text-xs text-orange-600 mt-0.5">
              删除所有摘要/待办/日报。配置不受影响。
            </div>
          </button>

          <button
            onClick={handleClearMonitors}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 rounded-md border border-amber-200 hover:border-amber-400 hover:bg-amber-50 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm text-amber-700 flex items-center gap-2">
              <Trash2 className="w-3.5 h-3.5" />
              清空监控列表
              {busy === "monitors" && (
                <RefreshCw className="w-3 h-3 animate-spin ml-auto" />
              )}
            </div>
            <div className="text-xs text-amber-600 mt-0.5">
              只清 cfg.monitors(配置层面)。已生成的摘要/待办仍保留在时间线。
              <br />
              适用:清空 IndexedDB 后,空监控槽位需要手动移除时。
            </div>
          </button>

          <button
            onClick={handleClearAll}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 rounded-md border border-red-200 hover:border-red-400 hover:bg-red-50 transition disabled:opacity-50"
          >
            <div className="font-medium text-sm text-red-700 flex items-center gap-2">
              <Trash2 className="w-3.5 h-3.5" />
              清空所有 IndexedDB 数据
              {busy === "all" && (
                <RefreshCw className="w-3 h-3 animate-spin ml-auto" />
              )}
            </div>
            <div className="text-xs text-red-600 mt-0.5">
              ⚠️ 危险:全部通知 + 缓存 + 置顶都删除。配置和监控列表不受影响。刷新页面生效。
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function About() {
  const [appInfo, setAppInfo] = useState<{ version: string } | null>(null);

  useEffect(() => {
    getAppInfo()
      .then((info) => setAppInfo({ version: info.version }))
      .catch(() => setAppInfo({ version: "1.0.0" }));
  }, []);

  return (
    <div className="space-y-6">
      <div className="text-center py-8">
        <img src={appIcon} alt="喵秘书" className="w-24 h-24 mx-auto mb-4 rounded-2xl" />
        <h2 className="text-2xl font-bold">喵秘书</h2>
        <p className="text-gray-500 mt-1">你的微信群消息小管家</p>
      </div>

      <div className="card">
        <h3 className="font-medium mb-3">项目信息</h3>
        <div className="text-sm space-y-2 text-gray-600">
          <div className="flex">
            <span className="w-16 text-gray-400 shrink-0">作者</span>
            <span>肥猫叉烧 (@Hunternotgod)</span>
          </div>
          <div className="flex">
            <span className="w-16 text-gray-400 shrink-0">版本</span>
            <span className="font-mono">v{appInfo?.version ?? "..."}</span>
          </div>
          <div className="flex">
            <span className="w-16 text-gray-400 shrink-0">仓库</span>
            <a
              href="https://gitee.com/fat-cat-barbecue/miao-secretary"
              className="text-brand-600 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              gitee.com/fat-cat-barbecue/miao-secretary
            </a>
          </div>
        </div>
      </div>

      {/* v1.0 新功能清单 —— 给老用户看的 changelog 入口 */}
      <details className="card cursor-pointer group">
        <summary className="flex items-center justify-between font-medium list-none">
          <span className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-brand-500" />
            📖 v1.0 新功能(给老用户)
          </span>
          <span className="text-xs text-gray-400 group-open:hidden">点击展开</span>
          <span className="text-xs text-gray-400 hidden group-open:inline">收起</span>
        </summary>
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-3 text-sm text-gray-700 leading-relaxed">
          <div>
            <div className="font-medium text-gray-900 mb-1">🆕 全新新手引导</div>
            <p className="text-xs text-gray-600">
              重写 4 步引导(欢迎 / 选服务 / 填密钥 / 完成),4 个主推 AI 平铺,
              步骤卡片化,默认推荐智谱 GLM(国内手机号即注册)。
            </p>
          </div>
          <div>
            <div className="font-medium text-gray-900 mb-1">🤖 AI 规则独立 tab</div>
            <p className="text-xs text-gray-600">
              「AI 规则」从 AI 配置末位提到 Settings 顶层第二栏,
              模板画廊 + 预设规则 + 自由补充 + 实时预览,所有改动自动保存。
            </p>
          </div>
          <div>
            <div className="font-medium text-gray-900 mb-1">🔍 术语清理</div>
            <p className="text-xs text-gray-600">
              "API Base URL" → 服务器地址;"引擎" → AI 服务;"回补窗口" → 拉多久的消息。
              每个术语都有悬浮解释。
            </p>
          </div>
          <div>
            <div className="font-medium text-gray-900 mb-1">📦 数据源简化</div>
            <p className="text-xs text-gray-600">
              删除了几乎没人用的"粘贴消息"和"图片识别"通道。
              现在只剩「PC 微信」一个核心入口,整张卡片可点击展开。
            </p>
          </div>
          <div>
            <div className="font-medium text-gray-900 mb-1">🩺 全局帮助条</div>
            <p className="text-xs text-gray-600">
              Settings 顶部多了「重新进行新手引导」和「测试 AI 连接」两个按钮,
              在哪个 tab 都能用。
            </p>
          </div>
          <div>
            <div className="font-medium text-gray-900 mb-1">🎨 UI 友好化</div>
            <p className="text-xs text-gray-600">
              所有折叠区域整行可点(以前只能点小箭头);空监控有占位卡;监控行
              显示"上次同步/未同步/命中缓存"。
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}

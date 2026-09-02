/**
 * 三步引导流程(v0-4 重做,适配「纯新手」)
 * Step 1: 欢迎
 * Step 2: 选 AI 服务 —— 4 张主推卡(GLM / DS / MiniMax / Gemini)+ 高级折叠
 * Step 3: 配置 API
 *
 * 文档性文案不写「每天 200 次免费」这种会过期的具体数字,
 * 价格/额度等参考 AI_PRESETS[i].note 和 name 旁边的 tag("免费 / 海外 / 本地")
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check, ChevronRight, Sparkles, Key, Settings as SettingsIcon, ArrowLeft, AlertCircle,
  Eye, EyeOff, ExternalLink, HelpCircle,
} from "lucide-react";
import { AI_PRESETS } from "../lib/store/config";
import appIcon from "../assets/app-icon.png";
import { listModels, testAIConnection } from "../lib/tauri/commands";
import { useApp } from "../lib/store/AppContext";
import type { AIProvider, AIConfig } from "../lib/ai/types";

type Step = 1 | 2 | 3;

// Onboarding 主页可见的 4 张卡片(用户拍板顺序:GLM / DS / MiniMax / Gemini)
const MAIN_PROVIDERS: AIProvider[] = ["zhipu", "deepseek", "MiniMax", "google"];
// 折叠在「高级用户」里:OpenAI / Kimi / 硅基流动 / Ollama / 自定义
const ADVANCED_PROVIDERS: AIProvider[] = ["openai", "moonshot", "siliconflow", "ollama", "custom"];

export default function Onboarding() {
  const navigate = useNavigate();
  const { update } = useApp();  // ✅ 关键修复：用 update 而不是 setAIConfig

  const [step, setStep] = useState<Step>(1);
  // 默认推荐:智谱 GLM(国内手机号注册,新用户免费)
  const [provider, setProvider] = useState<AIProvider>("zhipu");
  const [apiBaseUrl, setApiBaseUrl] = useState(AI_PRESETS.zhipu.defaultBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(AI_PRESETS.zhipu.defaultModel);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  // 模型列表（从 provider 拉的）
  const [availableModels, setAvailableModels] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const handleSelectProvider = (p: AIProvider) => {
    setProvider(p);
    setApiBaseUrl(AI_PRESETS[p].defaultBaseUrl);
    setModel(AI_PRESETS[p].defaultModel);
    setTestResult(null);
    setAvailableModels(null);
    setModelsError(null);
  };

  const handleFetchModels = async () => {
    if (!apiKey) return;
    setFetchingModels(true);
    setModelsError(null);
    try {
      const models = await listModels({ apiBaseUrl, apiKey });
      setAvailableModels(models);
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

  /**
   * 用户主动跳过引导
   * - 设置 onboarded=true(下次启动不再卡 Onboarding)
   * - 导航到主页(AppShell 会因为 onboarded=true 渲染主应用,不再回 Onboarding)
   *
   * v1.0 修复:之前只是 navigate("/"),但 onboarded 仍为 false,
   * AppShell 会立刻再次渲染 <Onboarding />,造成"点了跳过没用"的体验 bug
   */
  const handleSkip = () => {
    if (
      confirm(
        "跳过引导?\n\nAI 功能需要先配置服务,否则时间线看不到摘要。\n\n你随时可以在 Settings → AI 规则 重新配置。"
      )
    ) {
      update({ onboarded: true });
      navigate("/");
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      // ✅ 通过 Rust 端 HTTP 发送，绕过 WebView CORS 限制
      const msg = await testAIConnection({
        apiBaseUrl,
        apiKey,
        model,
        chatPath: "/chat/completions",
      });
      setTestResult({ ok: true, message: msg });
    } catch (e: any) {
      console.error("测试失败:", e);

      // Rust 端返回的 Error 包含详细原因
      let message = e.message || String(e);
      const providerName = AI_PRESETS[provider]?.name || provider;

      // 把 MiniMax/OpenAI 风格的错误提取出来
      if (message.includes("HTTP 401")) {
        message = "❌ HTTP 401: API Key 无效或已过期";
      } else if (message.includes("HTTP 404")) {
        message = "❌ HTTP 404: 模型不存在或路径错误。请检查模型名是否正确";
      } else if (message.includes("HTTP 403")) {
        message = "❌ HTTP 403: 无权访问。可能 Key 没权限用这个模型";
      } else if (message.includes("HTTP 429")) {
        message = "❌ HTTP 429: 请求太频繁，稍后再试";
      } else if (message.includes("HTTP 402")) {
        message = "💰 HTTP 402: 账户余额不足。请到 " + providerName + " 控制台充值\n\n💡 或者换有免费额度的服务（智谱 GLM-4 / 硅基流动）";
      } else if (message.includes("HTTP 500")) {
        message = "❌ HTTP 500: 服务器内部错误";
      } else if (message.includes("请求失败")) {
        message = "🌐 " + message + "\\n可能是：URL 错 / DNS 不通 / 离线";
      }

      setTestResult({ ok: false, message: message.slice(0, 400) });
    } finally {
      setTesting(false);
    }
  };

  const handleFinish = () => {
    if (!apiKey) {
      setTestResult({ ok: false, message: "请先填写 API Key" });
      return;
    }
    const aiConfig: AIConfig = {
      provider,
      apiBaseUrl,
      apiKey,
      model,
      temperature: 0.3,
    };
    // ✅ 关键修复：同时更新 AppContext state 和 localStorage
    update({ ai: aiConfig, onboarded: true });
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 via-orange-50 to-yellow-50 flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        {/* 头部 Logo + 步骤指示器 */}
        <div className="text-center mb-8">
          <img src={appIcon} alt="喵秘书" className="w-24 h-24 mx-auto mb-3 rounded-2xl" />
          <h1 className="text-3xl font-bold text-gray-900 mb-2">欢迎使用喵秘书</h1>
          <p className="text-gray-600">你的微信群消息小管家</p>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                  s < step
                    ? "bg-brand-500 text-white"
                    : s === step
                    ? "bg-brand-500 text-white ring-4 ring-brand-100"
                    : "bg-gray-200 text-gray-500"
                }`}
              >
                {s < step ? <Check className="w-5 h-5" /> : s}
              </div>
              {s < 3 && (
                <div
                  className={`w-12 h-1 mx-1 transition-colors ${
                    s < step ? "bg-brand-500" : "bg-gray-200"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* 步骤内容 */}
        <div className="bg-white rounded-2xl shadow-xl p-8 animate-slide-up">
          {step === 1 && (
            <div className="space-y-6">
              <div className="text-center">
                <Sparkles className="w-12 h-12 text-brand-500 mx-auto mb-3" />
                <h2 className="text-2xl font-semibold mb-2">三步开始使用</h2>
                <p className="text-gray-600">我们将引导你完成初始配置</p>
              </div>

              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-medium flex-shrink-0">
                    1
                  </div>
                  <div>
                    <div className="font-medium">选一个 AI 服务</div>
                      <div className="text-gray-500">下面 4 个任选一个,注册都简单</div>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-medium flex-shrink-0">
                    2
                  </div>
                  <div>
                    <div className="font-medium">填入 API Key</div>
                    <div className="text-gray-500">只用一次，本地保存，不上传任何服务器</div>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-medium flex-shrink-0">
                    3
                  </div>
                  <div>
                    <div className="font-medium">添加微信群</div>
                    <div className="text-gray-500">选择要监控的群，开始整理通知</div>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                <button onClick={handleSkip} className="btn-secondary flex-1">
                  稍后配置
                </button>
                <button onClick={() => setStep(2)} className="btn-primary flex-1">
                  开始配置
                  <ChevronRight className="w-4 h-4 ml-1 inline" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-2xl font-semibold mb-2">选一个 AI 服务</h2>
                <p className="text-gray-600 text-sm">
                  下面 4 个是常用的 · 注册都不复杂 · 国产 / 海外 / 1M 上下文 / 中文最强 都有
                </p>
              </div>

              {/* 主推 4 张卡片(2x2 网格) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {MAIN_PROVIDERS.map((p) => {
                  const preset = AI_PRESETS[p];
                  const selected = provider === p;
                  const isPick = p === "zhipu";
                  return (
                    <button
                      key={p}
                      onClick={() => handleSelectProvider(p)}
                      className={`text-left p-4 rounded-lg border-2 transition-all relative ${
                        selected
                          ? "border-brand-500 bg-brand-50"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      {isPick && !selected && (
                        <span className="absolute -top-2 left-3 text-[10px] bg-amber-400 text-white px-1.5 py-0.5 rounded shadow">
                          我们的推荐
                        </span>
                      )}
                      <div className="font-medium text-base text-gray-900">{preset.name}</div>
                      <div className="flex flex-wrap gap-1.5 mt-1.5 mb-2">
                        {preset.tags?.map((tag) => (
                          <span
                            key={tag}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              tag === "推荐"
                                ? "bg-brand-100 text-brand-700"
                                : tag === "免费"
                                ? "bg-green-100 text-green-700"
                                : tag === "海外"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-gray-700 leading-relaxed">{preset.description}</div>
                      {preset.note && (
                        <div className="text-xs text-amber-700 mt-1.5">💡 {preset.note}</div>
                      )}
                      {selected && (
                        <Check className="absolute top-2 right-2 w-5 h-5 text-brand-600" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 高级用户折叠:OpenAI / Kimi / 硅基流动 / Ollama / 自定义 */}
              <details className="border border-gray-200 rounded-lg group">
                <summary className="px-3 py-2.5 cursor-pointer text-sm text-gray-600 hover:bg-gray-50 select-none flex items-center gap-2">
                  <span>🔧 高级用户 · 更多 AI 服务(OpenAI / Kimi / 硅基流动 / Ollama 等)</span>
                </summary>
                <div className="space-y-2 p-3 border-t border-gray-200">
                  {ADVANCED_PROVIDERS.map((p) => {
                    const preset = AI_PRESETS[p];
                    const selected = provider === p;
                    return (
                      <button
                        key={p}
                        onClick={() => handleSelectProvider(p)}
                        className={`w-full text-left p-2.5 rounded border transition-all flex items-start gap-2 ${
                          selected
                            ? "border-brand-500 bg-brand-50"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{preset.name}</div>
                          <div className="text-xs text-gray-500">{preset.description}</div>
                        </div>
                        {preset.tags?.includes("本地") && (
                          <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded shrink-0">本地</span>
                        )}
                        {preset.tags?.includes("高级") && (
                          <span className="text-[10px] bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded shrink-0">高级</span>
                        )}
                        {selected && (
                          <Check className="w-4 h-4 text-brand-600 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </details>

              <div className="flex gap-3 pt-4 border-t">
                <button onClick={() => setStep(1)} className="btn-secondary">
                  <ArrowLeft className="w-4 h-4 mr-1 inline" />
                  上一步
                </button>
                <button onClick={() => setStep(3)} className="btn-primary flex-1">
                  下一步
                  <ChevronRight className="w-4 h-4 ml-1 inline" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              {/* 头部 */}
              <div>
                <h2 className="text-2xl font-semibold mb-2 flex items-center gap-2">
                  <Key className="w-6 h-6 text-brand-600" />
                  填入 {AI_PRESETS[provider].name} 的密钥
                </h2>
                <p className="text-gray-600 text-sm">{AI_PRESETS[provider].description}</p>
              </div>

              {/* 操作步骤(三步搞定) */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm space-y-2">
                <div className="font-medium text-gray-700 flex items-center gap-1.5">
                  <HelpCircle className="w-4 h-4 text-gray-500" />
                  怎么拿到密钥 · 3 步搞定
                </div>
                <ol className="space-y-1.5 text-gray-600 text-xs pl-1">
                  <li>
                    ① 打开 {AI_PRESETS[provider].keyUrl ? (
                      <a
                        href={AI_PRESETS[provider].keyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                      >
                        {AI_PRESETS[provider].name} 密钥管理页
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span>{AI_PRESETS[provider].name} 官方控制台</span>
                    )},注册或登录
                  </li>
                  <li>
                    ② 在控制台找到 <span className="font-mono text-[11px] bg-white px-1 rounded border">API 密钥 / API Keys</span> 菜单,点「创建新密钥」,复制下来
                  </li>
                  <li>
                    ③ 把密钥粘贴到下面输入框(以 <span className="font-mono text-[11px] bg-white px-1 rounded border">{AI_PRESETS[provider].placeholder.slice(0, 6)}…</span> 开头)
                  </li>
                </ol>
              </div>

              {/* 密钥主输入 */}
              <div>
                <label className="text-sm font-medium mb-1 flex items-center gap-1.5">
                  <span>密钥</span>
                  <span className="text-xs text-gray-400 font-normal">(即 API Key)</span>
                  <span
                    className="text-[10px] text-gray-400 inline-flex items-center cursor-help"
                    title="密钥 = API Key = 账号密码,本地存储不上传"
                  >
                    <HelpCircle className="w-3 h-3 mr-0.5" />
                    什么是密钥?
                  </span>
                </label>
                <div className="flex gap-2">
                  <input
                    type={showKey ? "text" : "password"}
                    className="input flex-1 font-mono"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setTestResult(null);
                    }}
                    placeholder={AI_PRESETS[provider].placeholder}
                    autoComplete="off"
                    disabled={testing}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="btn-secondary px-3 shrink-0"
                    title={showKey ? "隐藏密钥" : "显示密钥(方便核对)"}
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  🔒 本地存储,不上传到任何服务器
                </div>
              </div>

              {/* 高级用户折叠:服务器地址 + 模型 */}
              <details className="border border-gray-200 rounded-md">
                <summary className="px-3 py-2 cursor-pointer text-sm text-gray-600 hover:bg-gray-50 select-none">
                  ⚙️ 高级用户(99% 不用改)
                </summary>
                <div className="p-3 space-y-3 border-t border-gray-200">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      服务器地址(API Base URL)
                    </label>
                    <input
                      type="text"
                      className="input text-sm"
                      value={apiBaseUrl}
                      onChange={(e) => setApiBaseUrl(e.target.value)}
                      placeholder={AI_PRESETS[provider].defaultBaseUrl}
                    />
                    <div className="text-[10px] text-gray-400 mt-1">
                      上游服务地址,默认就好,除非你用代理或私有部署
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      AI 模型(默认即可)
                    </label>
                    <div className="flex gap-2">
                      {availableModels && availableModels.length > 0 ? (
                        <select
                          className="input flex-1 text-sm"
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          disabled={testing}
                        >
                          {!availableModels.includes(model) && model && (
                            <option value={model}>{model}(自定义)</option>
                          )}
                          {availableModels.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          className="input flex-1 text-sm"
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          placeholder={AI_PRESETS[provider].defaultModel}
                          disabled={testing}
                        />
                      )}
                      <button
                        type="button"
                        onClick={handleFetchModels}
                        disabled={!apiKey || fetchingModels || testing}
                        className="btn-secondary shrink-0 text-sm"
                        title="从 provider 拉取可用模型"
                      >
                        {fetchingModels ? "拉取中..." : "获取列表"}
                      </button>
                    </div>
                    {modelsError && (
                      <div className="text-xs text-amber-600 mt-1">
                        ⚠️ {modelsError}(可手动输入模型名)
                      </div>
                    )}
                    {availableModels && availableModels.length > 0 && (
                      <div className="text-xs text-green-600 mt-1">
                        ✓ 已从 {AI_PRESETS[provider].name} 拉到 {availableModels.length} 个模型
                      </div>
                    )}
                    {!availableModels && AI_PRESETS[provider].modelExamples && AI_PRESETS[provider].modelExamples.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="text-xs text-gray-500">常见模型:</span>
                        {AI_PRESETS[provider].modelExamples.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setModel(m)}
                            className="text-xs px-2 py-0.5 bg-gray-100 hover:bg-brand-100 hover:text-brand-700 rounded"
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </details>

              {/* 测试结果 */}
              {testResult && (
                <div
                  className={`p-3 rounded-md text-sm flex items-start gap-2 ${
                    testResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  }`}
                >
                  {testResult.ok ? (
                    <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  )}
                  <span className="break-all">{testResult.message}</span>
                </div>
              )}

              {/* 测试按钮 */}
              <button
                onClick={handleTest}
                disabled={testing || !apiKey}
                className="btn-secondary w-full"
              >
                {testing ? "测试中..." : "🩺 测试连接"}
              </button>

              {/* 导航 */}
              <div className="flex gap-3 pt-4 border-t">
                <button onClick={() => setStep(2)} className="btn-secondary" disabled={testing}>
                  <ArrowLeft className="w-4 h-4 mr-1 inline" />
                  上一步
                </button>
                <button onClick={handleSkip} className="btn-secondary" disabled={testing}>
                  稍后配置
                </button>
                <button
                  onClick={handleFinish}
                  disabled={!apiKey || testing}
                  className="btn-primary flex-1"
                >
                  <Check className="w-4 h-4 mr-1 inline" />
                  完成
                </button>
              </div>

              {/* 帮助链接(可折叠) */}
              <details className="text-xs text-gray-500 pt-2 border-t">
                <summary className="cursor-pointer">📚 还是卡住?看官方链接</summary>
                <div className="pt-2 space-y-1">
                  {AI_PRESETS[provider].keyUrl && (
                    <div>
                      • 获取 API Key:{" "}
                      <a
                        href={AI_PRESETS[provider].keyUrl}
                        className="text-brand-600 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {AI_PRESETS[provider].keyUrl!.replace(/^https?:\/\//, "").split("/")[0]} ↗
                      </a>
                    </div>
                  )}
                  {AI_PRESETS[provider].docsUrl && (
                    <div>
                      • 查看可用模型:{" "}
                      <a
                        href={AI_PRESETS[provider].docsUrl}
                        className="text-brand-600 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {AI_PRESETS[provider].docsUrl!.replace(/^https?:\/\//, "").split("/")[0]} ↗
                      </a>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="text-center mt-6 text-xs text-gray-400">
          💡 随时可以在 <SettingsIcon className="w-3 h-3 inline" /> 设置页修改配置
        </div>
      </div>
    </div>
  );
}

/**
 * 数据源管理 - v1.0 简化版
 *
 * 只保留"PC 微信"一个核心数据通道。
 * - 粘贴 / OCR 入口已删除(用户反馈 v0-4 几乎不用,降低认知负担)
 * - 整张卡片可点(不要只点击按钮)
 */
import { useState } from "react";
import { Database, ChevronRight, Shield, RefreshCw } from "lucide-react";
import WeChatPanel from "../components/WeChatPanel";

export default function DataSources() {
  const [wechatOpen, setWechatOpen] = useState(true);  // v1.0 默认展开,降低使用成本

  return (
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-3">
        <h1 className="text-xl font-semibold">📦 数据源</h1>
        <p className="text-xs text-gray-500 mt-0.5">把 PC 微信里的群消息整理进时间线,数据只在本机处理</p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-3">
          {/* 主入口:PC 微信 —— 整张卡可点展开/收起 */}
          <button
            type="button"
            onClick={() => setWechatOpen((v) => !v)}
            className={`w-full card flex items-center gap-4 text-left cursor-pointer transition-all hover:shadow-md hover:border-brand-300 ${
              wechatOpen ? "ring-1 ring-brand-200 border-brand-200" : ""
            }`}
          >
            <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-brand-100 text-brand-600 shrink-0">
              <Database className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">PC 微信聊天记录</h3>
                <span className="text-[10px] bg-brand-100 text-brand-700 px-2 py-0.5 rounded-full font-medium">
                  主通道
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-0.5">
                自动读取 PC 微信中的聊天记录 · 全程只在本机处理
              </p>
              <p className="text-xs text-gray-400 mt-1">
                需要 Windows + 微信 4.x(含 4.1+)
              </p>
            </div>
            <ChevronRight
              className={`w-5 h-5 text-gray-400 shrink-0 transition-transform ${
                wechatOpen ? "rotate-90 text-brand-500" : ""
              }`}
            />
          </button>

          {wechatOpen && (
            <div className="ml-2 pl-4 border-l-2 border-brand-100 animate-fade-in">
              <WeChatPanel />
            </div>
          )}

          {/* 隐私提示卡 —— 让人放心 */}
          <div className="card bg-green-50/50 border-green-100">
            <div className="flex items-start gap-3">
              <Shield className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium text-green-900 text-sm">🔒 你的数据很安全</div>
                <p className="text-xs text-green-700 mt-1 leading-relaxed">
                  你的微信聊天数据只在电脑本地读取和处理,
                  <br />
                  AI 分析时只把"消息文本"发到你配置的 AI 服务(智谱/MiniMax/DeepSeek 等),
                  <br />
                  我们没有服务器,不收集任何东西。
                </p>
              </div>
            </div>
          </div>

          {/* 引导卡 —— 没有监控时提示 */}
          <div className="card bg-blue-50/40 border-blue-100 text-sm text-blue-900">
            <div className="flex items-start gap-3">
              <RefreshCw className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium">💡 没有看到想要的群?</div>
                <p className="text-xs text-blue-700 mt-1 leading-relaxed">
                  在微信里打开那个群(或单聊)停留几秒,
                  然后回这里点 <span className="font-mono text-[11px] bg-white px-1 rounded border">加载会话列表</span> 就能选到了。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

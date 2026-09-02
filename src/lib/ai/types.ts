/**
 * AI 引擎统一接口
 */

export type AIProvider =
  | "deepseek"      // DeepSeek
  | "zhipu"         // 智谱 GLM
  | "MiniMax"      // MiniMax
  | "openai"        // OpenAI
  | "google"        // Google Gemini(海外 / OpenAI 兼容)
  | "ollama"        // 本地 Ollama
  | "moonshot"      // 月之暗面 Kimi
  | "siliconflow"   // 硅基流动
  | "custom";       // 完全自定义

/**
 * AI 配置 - 支持简单模式（填 Key 就用）和高级模式（自定义协议细节）
 */
export interface AIConfig {
  provider: AIProvider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;

  /** 高级选项 - 大多数情况不用填 */
  advanced?: AIAdvancedConfig;

  /**
   * 用户自定义规则 - 在默认 system prompt 后追加,让 AI 更贴合个人场景。
   * 勾选的预设规则 id(来自 BUILTIN_RULES 的 key),由前端按需组合成文本。
   */
  customRules?: string[];
  /** 用户自由补充的规则文本(纯文本,直接追加在 system prompt 末尾) */
  customText?: string;
}

/**
 * 高级选项 - 适配非标准 OpenAI 协议
 */
export interface AIAdvancedConfig {
  /** Chat 端点路径，默认 "/chat/completions" */
  chatPath?: string;
  /** 认证 header 名，默认 "Authorization" */
  authHeaderName?: string;
  /** 认证 scheme，默认 "Bearer" */
  authScheme?: string;
  /** 响应内容提取路径（点分隔），默认 "choices.0.message.content" */
  responseContentPath?: string;
  /** 请求体中 max_tokens 字段名，默认 "max_tokens"（新版 OpenAI 用 "max_completion_tokens"）*/
  maxTokensField?: string;
  /** 是否使用 max_completion_tokens（新 OpenAI 风格） */
  useMaxCompletionTokens?: boolean;
  /** 额外请求头 */
  extraHeaders?: Record<string, string>;
  /** 额外请求体字段（合并到请求里）*/
  extraBody?: Record<string, any>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * AI 看到的「同群最近已有通知」上下文(用于推断 eventKey)
 */
export interface ExistingEventHint {
  eventKey: string;
  summary: string;
  status?: "active" | "changed" | "revoked";
}

export interface SummaryResult {
  /** 一句话行动摘要：读者看完知道要不要管、要不要做 */
  summary: string;
  importance: "urgent" | "important" | "normal" | "ignore";
  category: string;
  /** 是否是「需要我做事」的待办(v11 新增,前端用来自动归类到待办区) */
  isTodo?: boolean;
  /** 重点要点清单：3-6 条，每条具体、可执行，含时间/地点/要求/数字 */
  keyPoints?: string[];
  keyInfo: {
    /** 截止时间（如 "5月22日 23:59"） */
    deadline?: string;
    /** 时间（如 "5月22日 19:00"） */
    time?: string;
    /** 地点 */
    location?: string;
    /** 责任人 */
    responsiblePerson?: string;
  };
  /**
   * 事件 ID:标识「这一系列通知属于同一事件」。
   * AI 推断:与某条已有通知同主题/同时刻/同地点 → 复用该通知的 eventKey;
   * 新事件 → 生成新 key(基于群 ID + 时间 + 主题)。
   */
  eventKey?: string;
  /**
   * 本条通知相对于事件的当前状态:
   * - active: 事件正在/最新有效
   * - changed: 信息有变更(时间/地点/形式改过)
   * - revoked: 事件被取消/作废
   */
  eventStatus?: "active" | "changed" | "revoked";
  /**
   * 话题概要(v13 新增):用 1-3 句话描述这段对话整体在讨论什么、有什么结论。
   * 用于普通话题(isTodo=false)也能让用户看懂群内发生了什么。
   * 例:"大家在讨论国庆去哪儿玩,最终倾向云南。预算 3000/人。"
   */
  topicSummary?: string;
  /**
   * 对话情绪(v13 新增):整体氛围,帮用户快速感受群内态势。
   * - consensus: 达成共识/和谐
   * - debate: 有分歧但理性
   * - conflict: 争议/争吵
   * - casual: 闲聊/无主题
   */
  sentiment?: "consensus" | "debate" | "conflict" | "casual";
  /**
   * 核心参与者名单(v13 新增):这段对话里发言多、有推动话题的人。
   * 最多 5 个,按活跃度排。
   */
  participants?: string[];
}

export interface AIError {
  code: string;
  message: string;
  retryable: boolean;
}

export abstract class AIEngine {
  constructor(protected config: AIConfig) {}

  abstract chat(_messages: ChatMessage[]): Promise<string>;
  abstract analyzeNotification(
    _content: string,
    _context?: string,
    _existingEvents?: ExistingEventHint[]
  ): Promise<SummaryResult>;

  async analyzeImage(_imageBase64: string, _prompt: string): Promise<string> {
    throw new Error("当前引擎不支持视觉识别");
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.chat([{ role: "user", content: "你好" }]);
      return true;
    } catch {
      return false;
    }
  }
}

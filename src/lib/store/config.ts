/**
 * 用户配置存储（用 localStorage 持久化）
 */
import type { AIConfig, AIProvider } from "../ai/types";

const STORAGE_KEY = "miao-secretary-config";

/**
 * 调度档位(对小白友好,不用 cron):
 * - off: 不自动跑,只手动
 * - realtime: 每 15 分钟(固定档)
 * - interval: 每 N 分钟/小时(用 intervalMinutes 字段)
 * - daily: 每天 N 个时间点(用 dailyTimes 字段,["09:00", "18:00"])
 */
export type MonitorSchedule = "off" | "realtime" | "interval" | "daily";

export interface MonitorGroup {
  chatroomId: string;
  name: string;
  enabled: boolean;
  focusPersons?: string[];
  /** 调度档位,默认 interval */
  schedule?: MonitorSchedule;
  /** interval 模式:每多少秒抓一次(默认 3600 = 1 小时,支持任意精度如 320 = 5 分 20 秒) */
  intervalSeconds?: number;
  /** daily 模式:每天哪些时间点抓(24h HH:MM,如 ["09:00", "18:00"]) */
  dailyTimes?: string[];
  /** 上次成功轮询的时间戳(ms),用于增量抓取 */
  lastPolledAt?: number;
  /** 上次轮询实际处理的消息数(过滤文本后) */
  lastPolledMessageCount?: number;
  /**
   * 首次轮询回补窗口(小时)。未设置时用 DEFAULT_BACKFILL_HOURS(7 天)。
   * 用户添加监控时可指定:1/6/24/72/168/720
   */
  backfillHours?: number;
  /** 上次轮询拆出的簇数(AI 调用次数) */
  lastPolledClusterCount?: number;
  /** 上次轮询中缓存命中数(0 = 全新内容,>0 = 命中免 AI) */
  lastPolledCacheHits?: number;
}

export interface AppConfig {
  version: 2;
  onboarded: boolean;
  ai: AIConfig | null;
  monitors: MonitorGroup[];
  theme: "light" | "dark" | "system";
}

const DEFAULT_CONFIG: AppConfig = {
  version: 2,
  onboarded: false,
  ai: null,
  monitors: [],
  theme: "system",
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<Omit<AppConfig, "version">> & {
      version?: number;
    };
    return migrateConfig(parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 配置迁移 —— 处理版本升级时的字段默认值/强制重置
 *
 * v1 → v2(v1.0.0): UI 大改(4 卡平铺 + AI 规则独立 tab + Step 3 操作步骤化)
 *   → 强制 onboarded=false,让所有老用户走一遍新引导
 *   → 配置(AI key + monitors)保留不动
 */
function migrateConfig(
  cfg: Partial<Omit<AppConfig, "version">> & { version?: number }
): AppConfig {
  const sourceVersion = cfg.version ?? 1;
  const needsOnboardingReset = sourceVersion < DEFAULT_CONFIG.version;
  const merged = {
    ...DEFAULT_CONFIG,
    ...cfg,
    version: DEFAULT_CONFIG.version,
  } as AppConfig;

  if (needsOnboardingReset) {
    merged.onboarded = false;
  }

  return merged;
}

export function saveConfig(config: AppConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.error("保存配置失败:", e);
  }
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const updated = { ...current, ...patch };
  saveConfig(updated);
  return updated;
}

export function setAIConfig(ai: AIConfig): void {
  updateConfig({ ai, onboarded: true });
}

export function setMonitorGroups(monitors: MonitorGroup[]): void {
  updateConfig({ monitors });
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** 重置 onboarded 状态，强制回引导页 */
export function resetOnboarding(): void {
  const current = loadConfig();
  saveConfig({ ...current, onboarded: false });
}

export interface AIPreset {
  name: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** 价格提示 —— 尽量写功能性,不写"每天 200 次免费"这种会过期的具体数字 */
  free: string;
  /** 「卡上提示」:给 onboarding 用,1 行话术(也不写具体数字) */
  note?: string;
  placeholder: string;
  /** 模型名示例（仅供参考，最准确的以官网为准） */
  modelExamples?: string[];
  tags?: string[];
  /** 官网/控制台地址 - 用户去看模型列表 */
  docsUrl?: string;
  /** API Key 获取地址 */
  keyUrl?: string;
}

export const AI_PRESETS: Record<AIProvider, AIPreset> = {
  deepseek: {
    name: "DeepSeek",
    description: "中文对话能力强,适合微信群",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    free: "充值制",
    note: "起步充值 1 元能用很久,中文最强",
    placeholder: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    modelExamples: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://platform.deepseek.com/api-docs/",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  zhipu: {
    name: "智谱 GLM",
    description: "国内手机号注册,新用户有免费额度",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    free: "新用户免费",
    note: "推荐:注册即用,无需信用卡",
    placeholder: "your-zhipu-api-key",
    modelExamples: ["glm-4-flash", "glm-4-plus", "glm-4v-flash"],
    docsUrl: "https://bigmodel.cn/dev/api",
    keyUrl: "https://bigmodel.cn/usercenter/apikeys",
    tags: ["推荐", "免费"],
  },
  MiniMax: {
    name: "MiniMax",
    description: "国产 M 系列,1M 长上下文",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M3",
    free: "新用户小额",
    note: "支持 1M 上下文,适合超大群总结",
    placeholder: "eyJxxxxxxxxxxxxxxxxxxxxxxxx",
    modelExamples: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2",
    ],
    docsUrl: "https://platform.minimaxi.com/docs/api-reference/text/chat-api-v2",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  openai: {
    name: "OpenAI",
    description: "ChatGPT 官方",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    free: "按量付费",
    placeholder: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    modelExamples: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
    docsUrl: "https://platform.openai.com/docs/models",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    name: "Google Gemini",
    description: "Google 账号注册,海外用户友好",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.0-flash",
    free: "新用户免费",
    note: "OpenAI 兼容 API;需可访问 Google",
    placeholder: "AIzaSyxxxxxxxxxxxxxxxxxxxxxxxx",
    modelExamples: ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"],
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    keyUrl: "https://aistudio.google.com/apikey",
    tags: ["海外", "免费"],
  },
  moonshot: {
    name: "月之暗面 Kimi",
    description: "国产、长上下文",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    free: "充值制",
    placeholder: "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    modelExamples: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    docsUrl: "https://platform.moonshot.cn/docs",
    keyUrl: "https://platform.moonshot.cn/user-center/api-keys",
  },
  siliconflow: {
    name: "硅基流动",
    description: "国产、模型聚合,多选择",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    free: "有免费档",
    placeholder: "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    modelExamples: [
      "Qwen/Qwen2.5-7B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V2.5",
    ],
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  ollama: {
    name: "本地 Ollama",
    description: "完全本地、零费用",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5",
    free: "完全免费",
    placeholder: "（本地无需 Key）",
    modelExamples: ["qwen2.5", "llama3.2", "mistral"],
    docsUrl: "https://ollama.com/library",
    tags: ["本地"],
  },
  custom: {
    name: "完全自定义",
    description: "任意 OpenAI 兼容 / 自定义协议",
    defaultBaseUrl: "https://your-api.example.com/v1",
    defaultModel: "",
    free: "按服务定价",
    placeholder: "your-api-key",
    tags: ["高级"],
  },
};

// =============== 用户自定义 AI 规则 ===============

/** 单条预设规则:展示用 + 注入到 system prompt 的文本 */
export interface BuiltinRule {
  id: string;
  label: string;
  description: string;
  /** 注入到 system prompt 的文本(末尾会带 "【用户规则】" 前缀) */
  promptText: string;
}

/** 内置规则列表(顺序就是 UI 展示顺序) */
export const BUILTIN_RULES: BuiltinRule[] = [
  {
    id: "mention_me_urgent",
    label: "@我的消息一律 urgent",
    description: "消息里出现用户昵称或被 @ 时,直接把 importance 升到 urgent",
    promptText: "- 用户本人被 @ 时(消息里出现用户的昵称、或\"@我\"等代称),一律把 importance 升为 urgent",
  },
  {
    id: "authority_boost",
    label: "班委/老师/管理员 +1 级",
    description: "发送者是群主、老师、HR、班委等权威角色时,importance 在 AI 原判断基础上 +1 级",
    promptText: "- 如果消息发送者是班委、老师、群主、管理员、HR、领导等权威角色,把 importance 在 AI 原判断基础上 +1 级(例:normal → important,important → urgent)",
  },
  {
    id: "deadline_keyword_boost",
    label: "截止/报名/提交关键词升 importance",
    description: "消息里出现截止/报名/提交/缴费/打卡 等关键词时,importance 至少升到 important",
    promptText: "- 消息中出现「截止」「报名」「提交」「缴费」「打卡」「签到」「DDL」「deadline」等关键词时,importance 至少升到 important",
  },
  {
    id: "attachment_note",
    label: "链接/文件单独标注",
    description: "消息含链接/文件/图片时,在 keyPoints 末尾加一句「含链接/附件」",
    promptText: "- 如果消息里包含链接(URL)、文件、图片、文档、表单,在 keyPoints 末尾追加一句「含链接」「含附件」或「含文件」",
  },
  {
    id: "ignore_short_confirm",
    label: "短确认消息(收到/好的)归 ignore",
    description: "5 字以内的纯确认/回复(收到/好的/👌)一律归 ignore",
    promptText: "- 5 字以内的纯确认/回复类消息(如「收到」「好的」「👌」「+1」「感谢」「辛苦了」)一律归 ignore,summary 写\"群友确认/回复\"",
  },
  {
    id: "chitchat_penalty",
    label: "闲聊/表情包归 ignore",
    description: "无实质内容的闲聊、纯表情包、玩笑一律归 ignore",
    promptText: "- 无实质内容的闲聊、纯表情包、玩笑、复读一律归 ignore,即使发送者是权威",
  },
];

/** 出厂模板:一键套用一组规则 + 自由文本 */
export interface BuiltinTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  ruleIds: string[];
  customText: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: "student",
    name: "学生党",
    emoji: "🎓",
    description: "班级群、课程群、作业通知优先",
    ruleIds: ["mention_me_urgent", "authority_boost", "deadline_keyword_boost"],
    customText:
      "我主要关注学业信息:课程调整、作业截止、考试安排、选课通知、讲座报名。无关的群闲聊和表情包可以放心忽略。",
  },
  {
    id: "worker",
    name: "打工人",
    emoji: "💼",
    description: "工作群、会议、加班、报销优先",
    ruleIds: ["mention_me_urgent", "authority_boost", "deadline_keyword_boost", "attachment_note"],
    customText:
      "我主要关注工作通知:会议安排、加班通知、报销/审批进度、HR 政策、紧急事故。同事之间的闲聊可以降低权重。",
  },
  {
    id: "parent",
    name: "家长群",
    emoji: "🏠",
    description: "家校沟通、缴费、活动报名优先",
    ruleIds: ["mention_me_urgent", "authority_boost", "deadline_keyword_boost", "ignore_short_confirm"],
    customText:
      "我主要关注家校沟通:班主任通知、家长会、缴费(学费/校服/餐费)、放假安排、孩子作业要求。其他家长之间的寒暄可以降低权重。",
  },
  {
    id: "community",
    name: "社群运营",
    emoji: "🤝",
    description: "群活动、报名、签到、收费敏感",
    ruleIds: ["deadline_keyword_boost", "attachment_note"],
    customText:
      "我作为社群运营,需要快速识别群内的活动通知、报名接龙、签到打卡、收费/收款信息。其他成员的日常闲聊可以忽略。",
  },
  {
    id: "minimal",
    name: "默认(只多 1 条)",
    emoji: "✨",
    description: "只加一条「@我 = urgent」,其他用默认",
    ruleIds: ["mention_me_urgent"],
    customText: "",
  },
];

/** 把 customRules + customText 拼成最终要追加的规则文本(空就返回空字符串) */
export function buildUserRules(customRules?: string[], customText?: string): string {
  const lines: string[] = [];
  if (customRules && customRules.length > 0) {
    const idSet = new Set(customRules);
    for (const rule of BUILTIN_RULES) {
      if (idSet.has(rule.id)) {
        lines.push(rule.promptText);
      }
    }
  }
  if (customText && customText.trim()) {
    lines.push(customText.trim());
  }
  if (lines.length === 0) return "";
  return "【用户自定义规则 - 优先级高于默认规则】\n" + lines.join("\n");
}

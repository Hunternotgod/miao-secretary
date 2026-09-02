/**
 * 通用 AI 引擎
 *
 * 关键改动：chat() 通过 Rust 端 httpPost 发送请求
 * （之前用浏览器 fetch，会被 WebView CORS 阻止）
 */
import { AIEngine, type AIConfig, type ChatMessage, type SummaryResult, type AIAdvancedConfig, type ExistingEventHint } from "./types";
import { httpPost } from "../tauri/commands";
import { buildUserRules } from "../store/config";

export class UniversalEngine extends AIEngine {
  private get advanced(): Required<AIAdvancedConfig> {
    return {
      chatPath: this.config.advanced?.chatPath ?? "/chat/completions",
      authHeaderName: this.config.advanced?.authHeaderName ?? "Authorization",
      authScheme: this.config.advanced?.authScheme ?? "Bearer",
      responseContentPath: this.config.advanced?.responseContentPath ?? "choices.0.message.content",
      maxTokensField: this.config.advanced?.maxTokensField ?? (this.config.advanced?.useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"),
      useMaxCompletionTokens: this.config.advanced?.useMaxCompletionTokens ?? false,
      extraHeaders: this.config.advanced?.extraHeaders ?? {},
      extraBody: this.config.advanced?.extraBody ?? {},
    };
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const adv = this.advanced;
    const url = `${this.config.apiBaseUrl.replace(/\/$/, "")}${adv.chatPath}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [adv.authHeaderName]: adv.authScheme ? `${adv.authScheme} ${this.config.apiKey}` : this.config.apiKey,
      ...adv.extraHeaders,
    };

    const body: Record<string, any> = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.3,
      ...adv.extraBody,
    };
    body[adv.maxTokensField] = this.config.maxTokens || 2000;

    // ✅ 关键：通过 Rust 端 HTTP 发送，绕过 WebView CORS
    const data = await httpPost({
      url,
      headers,
      body,
      timeoutSecs: 60,
    });

    return this.extractContent(data, adv.responseContentPath);
  }

  private extractContent(data: any, path: string): string {
    const parts = path.split(".");
    let current: any = data;
    for (const part of parts) {
      if (current == null) return "";
      const idx = /^\d+$/.test(part) ? Number(part) : part;
      current = current[idx];
    }
    if (typeof current === "string") return current;
    if (current == null) return "";
    return JSON.stringify(current);
  }

  async analyzeNotification(
    content: string,
    context?: string,
    existingEvents?: ExistingEventHint[]
  ): Promise<SummaryResult> {
    const systemPrompt = `你是微信群通知分析助手。帮用户快速抓住重点、知道该做什么,同时理解群内对话整体脉络——不只筛通知,也是用户身边的秘书/朋友。

【核心原则】
1. 行动导向:summary 让读者 5 秒内知道要不要做、做什么
2. 不编造:原文没说的不补,keyInfo 字段缺失就省略
3. 可执行:keyPoints 动词开头,含具体时间/地点/数字/人名
4. 适度聚合:不硬凑 3-6 条,真正重要就 1-2 条,闲聊类可不输出
5. 稳定优先:重要性宁可保守(归 normal)也不要瞎猜
6. 结构稳定:严格按 schema 输出
7. 不只待办:即使 isTodo=false,也要用 topicSummary 帮用户理解群内整体在聊什么

【输出 JSON 格式】
{
  "summary": "明天 19:00 班级例会,需到场签到",
  "importance": "urgent|important|normal|ignore",
  "category": "作业|活动|调课|会议|缴费|考试|公告|闲聊|其他",
  "isTodo": true,
  "keyPoints": ["动词开头+含具体细节", ...],
  "keyInfo": {
    "deadline": "5月22日 23:59",
    "time": "5月22日 19:00",
    "location": "教 301",
    "responsiblePerson": "学习委员"
  },
  "topicSummary": "班级群在讨论下周运动会安排,明天 19:00 例会确认细节",
  "sentiment": "consensus",
  "participants": ["班长", "学习委员"],
  "eventKey": "本事件唯一标识(见下文)",
  "eventStatus": "active|changed|revoked"
}

【isTodo 判定 - 新增】
判断这条消息是否需要「我(消息接收者)做事或出席」:

→ true 的典型情况:
- 作业/任务/截止日期(DDL)
- 会议/活动需参加(包含具体时间地点)
- 缴费/报名/回复确认/RSVP
- 邀请/邀约/约饭/约玩/约下午茶/请吃饭/请唱歌(无论我是发起方还是受邀方)
- 已有约定的时间/地点变更(「改到5点」「换到会议室B」)
- 取消/作废一个之前的约定(需要确认)
- 等待我回复的具体请求(「谁有空」「能不能帮个忙」)
- 被点名/被 @ (mentionedMe)
- 包含具体未来时间点的安排(明天/今晚/周X/5点/19:00)

→ false 的典型情况:
- 闲聊/分享链接/表情包/纯问候
- 公告性质但和我无关(其他人的通知)
- 已自行完成事项的汇报
- 单纯陈述事实的新闻/分享

注意:
1. 即便「我」是发送方(自己发起的邀请),仍属 todo —— 因为我承诺了要按时出席/不取消
2. 时间变更消息比原约定优先级更高(改了就要按新时间)
3. isTodo 是「事实判断」,不替代用户决定;前端会用它把消息自动归到 📋 区,
   但用户仍可手动忽略或完成
4. 判断宁可保守:只标记明确需要行动的,闲聊类不要泛标记

【重要性分级 - 4 级】
- urgent: @所有人/@我/24 小时内截止/紧急事件
- important: 有截止(>24h)/作业/考试/会议/活动/正式通知
- normal: 日常通知、社团活动、群公告、非紧急分享
- ignore: 闲聊、表情包、重复消息、无实质内容

【话题分析 - 即使不是待办也要输出】
无论 isTodo 是 true 还是 false,都要输出:
- topicSummary:1-3 句话描述这段对话整体在讨论什么,有什么结论或倾向。
  例:"大家在讨论国庆去哪儿玩,最终倾向云南。预算 3000/人。"
  例:"同事汇报本周工作进展,无异常。"
  例:"群里讨论涨薪资的事,大家意见不一致。"
- sentiment:整体氛围
  - "consensus" 达成共识/和谐
  - "debate" 有分歧但理性
  - "conflict" 争议/争吵
  - "casual" 闲聊/无明确主题
- participants:核心参与者(发言多/推动话题的人),最多 5 个,按活跃度排。
  例:["张三", "李四"]
  
即使是 todo 类消息,topicSummary 也要简洁写出上下文,
让用户知道「在什么背景下我需要做什么」。

【eventKey 推断 - 关键】
${existingEvents && existingEvents.length > 0
  ? `本群最近已有这些事件(按时间倒序):
${existingEvents.map((e, i) => `${i+1}. key="${e.eventKey}" / 摘要="${e.summary}" / 状态=${e.status ?? "active"}`).join("\n")}

你的任务:
- 判断「当前消息」是否跟上面某个事件是同一事件(基于主题/时间/地点/发送者)
- 若是 → 复用该事件的 eventKey,并给出当前消息相对该事件的 eventStatus:
 - "changed" - 信息有变更(时间/地点/形式改了)
 - "revoked" - 事件被取消/作废(「不开了」「取消了」「作废」)
 - "active" - 这是事件的延续/补充(默认)
- 若否 → 生成新 eventKey,格式: evt_<群简称>_<时间 YYYYMMDD>_<主题>

注意:你只是「标记状态」,不要删掉任何信息。每次都新增一条,完整保留事件变迁。
`
  : `本群还没有任何已有事件。

生成新 eventKey,格式: evt_<群简称>_<时间 YYYYMMDD>_<主题>

eventStatus 默认 "active"。`}

【不准做的事】
1. 不编造原文中没有的信息
2. keyInfo 字段缺失就省略,不要填 "无" 或 null
3. 不在 JSON 外面加任何解释文字、emoji、前后缀
4. 不输出 markdown 代码块围栏

只返回 JSON,不要任何其他文字。`;

    // 用户自定义规则(可选,空就不追加)
    const userRules = buildUserRules(
      this.config.customRules,
      this.config.customText
    );
    const finalSystemPrompt = userRules
      ? `${systemPrompt}

${userRules}`
      : systemPrompt;

    const userPrompt = context
      ? `${context}\n\n消息内容：\n${content}`
      : `消息内容：\n${content}`;

    const result = await this.chat([
      { role: "system", content: finalSystemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const cleaned = result
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as Partial<SummaryResult>;
      // 归一化：保证关键字段结构稳定（部分模型可能漏字段）
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : cleaned.slice(0, 100),
        importance: parsed.importance ?? "normal",
        category: parsed.category ?? "其他",
        isTodo: parsed.isTodo === true,
        keyPoints: Array.isArray(parsed.keyPoints)
          ? parsed.keyPoints.filter((k): k is string => typeof k === "string")
          : undefined,
        keyInfo: {
          deadline: parsed.keyInfo?.deadline,
          time: parsed.keyInfo?.time,
          location: parsed.keyInfo?.location,
          responsiblePerson: parsed.keyInfo?.responsiblePerson,
        },
        eventKey: typeof parsed.eventKey === "string" ? parsed.eventKey : undefined,
        eventStatus: parsed.eventStatus,
        // v13 话题分析字段
        topicSummary: typeof parsed.topicSummary === "string" ? parsed.topicSummary : undefined,
        sentiment: ["consensus", "debate", "conflict", "casual"].includes(parsed.sentiment as string)
          ? (parsed.sentiment as SummaryResult["sentiment"])
          : undefined,
        participants: Array.isArray(parsed.participants)
          ? parsed.participants.filter((p): p is string => typeof p === "string").slice(0, 5)
          : undefined,
      };
    } catch {
      return {
        summary: cleaned.slice(0, 100),
        importance: "normal",
        category: "其他",
        keyPoints: [],
        keyInfo: {},
        eventKey: undefined,
        eventStatus: undefined,
      };
    }
  }
}

/** @deprecated */
export class CustomEngine extends UniversalEngine {}

/** @deprecated */
export class ZhipuEngine extends UniversalEngine {}

// ========= 各种预设 provider 实现（只是默认值不同）==========

export class DeepSeekEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    };
  }
}

export class ZhipuGLMEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-flash",
    };
  }

  /** 智谱 GLM-4V 视觉识别（也走 Rust 端 httpPost） */
  async analyzeImage(imageBase64: string, prompt: string): Promise<string> {
    const data = await httpPost({
      url: `${this.config.apiBaseUrl}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: {
        model: this.config.model || "glm-4v-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${imageBase64}` },
              },
            ],
          },
        ],
        temperature: this.config.temperature ?? 0.3,
      },
      timeoutSecs: 60,
    });

    return data.choices?.[0]?.message?.content || "";
  }
}

export class MiniMaxEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
    };
  }
}

export class OpenAIEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    };
  }
}

export class MoonshotEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "https://api.moonshot.cn/v1",
      model: "moonshot-v1-8k",
    };
  }
}

export class SiliconFlowEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "https://api.siliconflow.cn/v1",
      model: "Qwen/Qwen2.5-7B-Instruct",
    };
  }
}

export class OllamaEngine extends UniversalEngine {
  static defaults(): Partial<AIConfig> {
    return {
      apiBaseUrl: "http://localhost:11434/v1",
      model: "qwen2.5",
      advanced: { authScheme: "" },
    };
  }
}

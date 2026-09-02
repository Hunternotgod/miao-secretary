/**
 * AI 引擎工厂
 */
import { AIEngine, type AIConfig } from "./types";
import {
  UniversalEngine,
  DeepSeekEngine,
  ZhipuGLMEngine,
  MiniMaxEngine,
  OpenAIEngine,
  MoonshotEngine,
  SiliconFlowEngine,
  OllamaEngine,
} from "./custom";

export function createAIEngine(config: AIConfig): AIEngine {
  switch (config.provider) {
    case "deepseek":
      return new DeepSeekEngine(config);
    case "zhipu":
      return new ZhipuGLMEngine(config);
    case "MiniMax":
      return new MiniMaxEngine(config);
    case "openai":
      return new OpenAIEngine(config);
    case "moonshot":
      return new MoonshotEngine(config);
    case "siliconflow":
      return new SiliconFlowEngine(config);
    case "ollama":
      return new OllamaEngine(config);
    case "custom":
    default:
      // 自定义和其他都走通用引擎
      return new UniversalEngine(config);
  }
}

export { AIEngine } from "./types";
export type { AIConfig, AIProvider, ChatMessage, SummaryResult, AIAdvancedConfig } from "./types";

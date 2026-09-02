/**
 * 通知分析器 Hook - 把 AI 引擎接入 UI
 *
 * 用法：
 *   const { analyze } = useAnalyzer();
 *   const result = await analyze("消息内容", "群名");
 */
import { useCallback } from "react";
import { useApp } from "../store/AppContext";
import { createAIEngine } from "./factory";
import type { SummaryResult } from "./types";
import { toErrorMessage } from "../errors";

export function useAnalyzer() {
  const { config } = useApp();

  /**
   * 分析一条通知
   * @param content 原始消息内容
   * @param groupName 群名（作为上下文传给引擎）
   */
  const analyze = useCallback(
    async (content: string, groupName?: string): Promise<SummaryResult> => {
      const ai = config.ai;
      if (!ai) {
        throw new Error("还没有配置 AI，请先到「设置」里配置");
      }
      const engine = createAIEngine(ai);
      const context = groupName ? `所在群：${groupName}` : undefined;
      try {
        return await engine.analyzeNotification(content, context);
      } catch (e) {
        // 把真实原因透传，并带上当前用的 provider 方便排查
        const reason = toErrorMessage(e);
        throw new Error(
          `AI 分析失败（${ai.provider}/${ai.model}）：${reason}`
        );
      }
    },
    [config.ai]
  );

  return { analyze };
}

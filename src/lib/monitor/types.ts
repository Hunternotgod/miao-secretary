/**
 * Monitor 模块共享类型
 */

/** 单条微信消息(从后端 /wechat/history 拉回来的格式) */
export interface WeChatHistoryMsg {
  timestamp: number;
  time: string;
  chat: string;
  sender: string;
  msg_type: string;
  text: string;
}

/** /wechat/history 接口响应 */
export interface WeChatHistoryResp {
  count: number;
  messages: WeChatHistoryMsg[];
}

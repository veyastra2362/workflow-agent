import type { ChatMessage } from '../gateway/types';

/**
 * 上下文窗口控制：确定性摘要策略（MVP）。
 * - 始终保留 system 消息与首条 user 任务消息；
 * - 在字符预算内从最新往回保留消息；
 * - 被丢弃的中间消息用一条摘要占位消息说明。
 * 完整 transcript 由循环另行持久化，供恢复使用。
 */
export interface ContextView {
  messages: ChatMessage[];
  droppedCount: number;
}

export function estimateMessageChars(m: ChatMessage): number {
  let size = 24; // 角色与结构开销
  if (m.content) size += m.content.length;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      size += tc.name.length + tc.argumentsJson.length + 32;
    }
  }
  return size;
}

export function buildContextView(transcript: ChatMessage[], maxChars: number): ContextView {
  if (transcript.length === 0) return { messages: [], droppedCount: 0 };

  const headCount = Math.min(2, transcript.length); // system + 任务消息
  const head = transcript.slice(0, headCount);
  const rest = transcript.slice(headCount);

  let budget = maxChars - head.reduce((acc, m) => acc + estimateMessageChars(m), 0);
  if (budget < 0) budget = 0;

  const kept: ChatMessage[] = [];
  let dropped = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    const size = estimateMessageChars(m);
    // 至少保留最新一条，避免出现"没有可发送内容"的极端情况
    if (kept.length > 0 && size > budget) {
      dropped = i + 1;
      break;
    }
    budget -= size;
    kept.unshift(m);
  }

  const messages = [...head];
  if (dropped > 0) {
    messages.push({
      role: 'user',
      content: `[系统] 早前对话已折叠：以上省略了 ${dropped} 条较早的消息（含工具调用与结果）。完整执行记录已保存；请基于最近的消息继续工作，不要重复已完成的操作。`
    });
  }
  messages.push(...kept);
  return { messages, droppedCount: dropped };
}

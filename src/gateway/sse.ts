/**
 * 极简 SSE 解析器：从 fetch Response 的字节流中解析 `data:` 事件负载。
 * 兼容 CRLF；单条 data 行 JSON 解析失败时跳过（提高对中转站兼容性）。
 */
export async function* sseDataEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('SSE_ABORTED');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        if (payload === '[DONE]') return;
        yield payload;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流已关闭
    }
  }
}

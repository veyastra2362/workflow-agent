import { listFilesTool, readFileTool, writeFileTool, applyPatchTool, searchFilesTool } from './fs-tools';
import { gitDiffTool, runTestsTool } from './git-tools';
import { completeTaskTool, submitPlanTool, updatePlanTool } from './finish';
import { createWebFetchTool, createWebSearchTool, type WebFetchRuntime, type WebSearchConfig } from './web/web-tools';
import { BrowserSessionManager } from './browser/session';
import { createBrowserTools } from './browser/browser-tools';
import type { McpManager } from './mcp/manager';
import { ToolRegistry } from './registry';

export * from './registry';
export { listFilesTool, readFileTool, writeFileTool, applyPatchTool, searchFilesTool } from './fs-tools';
export { gitDiffTool, runTestsTool } from './git-tools';
export { completeTaskTool, submitPlanTool, updatePlanTool } from './finish';
export { createWebFetchTool, createWebSearchTool } from './web/web-tools';
export type { WebFetchRuntime, WebSearchConfig, SearchProvider } from './web/web-tools';
export type { DnsLookup, TargetPolicy } from './web/guarded-fetch';
export { guardedFetch, isBlockedIp, validateUrl, WebFetchError } from './web/guarded-fetch';
export { extractHtml } from './web/extract';
export { BrowserSessionManager } from './browser/session';
export type { BrowserPolicyConfig, TaskBrowserSession } from './browser/session';
export { createBrowserTools } from './browser/browser-tools';
export {
  classifyClick,
  classifyType,
  elementSignature,
  approvalSummary
} from '../policy/browser-risk';
export type { ElementDescriptor, BrowserRisk, RiskDecision } from '../policy/browser-risk';

export interface RegistryOptions {
  /** 搜索服务配置（provider=none 时 web_search 返回结构化错误） */
  webSearch?: WebSearchConfig;
  /** 测试注入：放行私网目标 / 替换 DNS（生产默认路径绝不设置） */
  webFetch?: WebFetchRuntime;
  /** 浏览器会话管理器（仅在用户启用浏览器自动化时传入，否则 6 个工具不注册） */
  browser?: { manager: BrowserSessionManager };
  /** MCP 连接管理器（仅注入已连接服务器的工具；external 风险默认逐次审批） */
  mcp?: { manager: McpManager };
}

/** 默认工具集（含联网工具）。webSearch 缺省为未配置状态；浏览器未启用时不注册。 */
export function createDefaultRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(searchFilesTool);
  registry.register(writeFileTool);
  registry.register(applyPatchTool);
  registry.register(gitDiffTool);
  registry.register(runTestsTool);
  registry.register(submitPlanTool);
  registry.register(updatePlanTool);
  registry.register(completeTaskTool);
  registry.register(
    createWebSearchTool(
      opts.webSearch ?? { provider: 'none', baseUrl: '', apiKey: () => null, runtime: opts.webFetch }
    )
  );
  registry.register(createWebFetchTool(opts.webFetch));
  if (opts.browser) {
    for (const tool of createBrowserTools(opts.browser)) {
      registry.register(tool);
    }
  }
  if (opts.mcp) {
    for (const tool of opts.mcp.manager.listToolDefinitions()) {
      registry.register(tool); // 命名冲突/非法名已在发现期处理；此处残余冲突直接抛出（fail-fast）
    }
  }
  return registry;
}

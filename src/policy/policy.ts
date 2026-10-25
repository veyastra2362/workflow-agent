/**
 * Policy Engine：工具风险分级与审批决策。
 * 路径边界检查由 policy/paths 在工具内部强制执行（程序层面，非提示词）；
 * 本模块决定"哪些操作可以自动执行、哪些需要用户确认、哪些直接拒绝"。
 */

export type RiskLevel = 'read' | 'write' | 'execute' | 'network' | 'external';
export type ApprovalAction = 'allow' | 'ask' | 'deny';

export interface PolicyDecision {
  action: ApprovalAction;
  reason: string;
}

export interface PolicySettings {
  allowedTestCommands: string[];
  autoApproveTestCommands: boolean;
  /** 开启后所有写入类工具执行前需要用户批准（默认关闭） */
  requireApprovalForWrites?: boolean;
  /** 开启后所有联网工具（web_fetch / web_search）执行前需要用户批准（默认关闭） */
  requireApprovalForWeb?: boolean;
  /** 开启后所有 MCP 外部工具执行前需要用户批准（默认开启；不提供服务器级信任开关） */
  requireApprovalForMcp?: boolean;
}

export class PolicyEngine {
  constructor(private readonly settings: PolicySettings) {}

  decide(toolName: string, risk: RiskLevel, args: unknown): PolicyDecision {
    if (toolName === 'run_tests') {
      return this.decideRunTests(args);
    }
    switch (risk) {
      case 'read':
        return { action: 'allow', reason: '只读工具自动放行' };
      case 'write':
        if (this.settings.requireApprovalForWrites === true) {
          return { action: 'ask', reason: '设置已开启"写入操作需审批"，本次写入需要确认' };
        }
        return {
          action: 'allow',
          reason: '工作区内写入自动放行（已记录变更与备份）'
        };
      case 'network':
        if (this.settings.requireApprovalForWeb === true) {
          return { action: 'ask', reason: '设置已开启"联网操作需审批"，本次联网请求需要确认' };
        }
        return { action: 'allow', reason: '只读联网请求（GET）自动放行' };
      case 'external':
        // MCP 外部工具：默认逐次审批（保守默认）；服务器自称安全不参与判定
        if (this.settings.requireApprovalForMcp !== false) {
          return { action: 'ask', reason: 'MCP 外部工具调用需要用户确认（默认策略）' };
        }
        return { action: 'allow', reason: '设置已关闭 MCP 审批（用户显式选择）' };
      case 'execute':
      default:
        return { action: 'deny', reason: '未注册的执行类工具被策略拒绝' };
    }
  }

  private decideRunTests(args: unknown): PolicyDecision {
    const command =
      typeof args === 'object' && args !== null
        ? (args as { command?: unknown }).command
        : undefined;
    if (typeof command !== 'string') {
      return { action: 'deny', reason: 'run_tests 缺少 command 参数' };
    }
    const normalized = command.trim();
    const allowed = this.settings.allowedTestCommands
      .map((c) => c.trim())
      .includes(normalized);
    if (!allowed) {
      return {
        action: 'deny',
        reason: `命令 "${normalized}" 不在允许的测试命令白名单中（可在设置中配置）`
      };
    }
    if (this.settings.autoApproveTestCommands) {
      return { action: 'allow', reason: '设置允许自动执行白名单测试命令' };
    }
    return { action: 'ask', reason: '执行测试命令需要用户确认' };
  }
}

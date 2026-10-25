import type { FinishRequest, Verifier, VerifierInput, Verdict } from './types';

/** 验收标准中出现这些关键词时，任务必须存在成功的测试执行 */
const ACCEPTANCE_TEST_RE = /(test|测试|spec|jest|pytest)/i;

/**
 * Verifier：任务验收裁决。
 * 核心原则：完成状态不依赖模型自述 ——
 * - 模型必须通过 complete_task 提交汇报；
 * - 汇报缺少验证说明 → 警告；
 * - 存在阻塞 → needs_review；
 * - run_tests 实际执行失败（工具失败或退出码非 0）→ 不得判为 completed；
 * - 验收标准要求测试时，必须存在成功的测试执行；
 * - 修改了文件但从未运行测试 → 警告（需人工复核提示）；
 * - 模型未提交汇报循环即结束（超步数/超时等）→ failed。
 */
export class DefaultVerifier implements Verifier {
  constructor(private readonly opts: { requireTestsWhenFilesChanged?: boolean } = {}) {}

  verify(input: VerifierInput): Verdict {
    const reasons: string[] = [];
    const warnings: string[] = [];

    const finish: FinishRequest | null = input.finish;
    if (!finish) {
      reasons.push('模型未调用 complete_task 提交完成汇报，循环因以下原因终止' + (input.endReason ? `：${input.endReason}` : ''));
    } else {
      if (!finish.verification || finish.verification.trim() === '') {
        warnings.push('完成汇报缺少验证说明（verification 为空）');
      }
      if (finish.blockers && finish.blockers.trim() !== '') {
        reasons.push(`模型报告存在未完成事项或阻塞：${finish.blockers}`);
      }
    }

    const failedCalls = input.toolRecords.filter((r) => !r.ok);
    if (failedCalls.length > 0) {
      warnings.push(
        `${failedCalls.length} 次工具调用以错误结束（${[...new Set(failedCalls.map((r) => r.name))].join(', ')}），详情见执行时间线`
      );
    }

    // 测试实际未通过：工具执行失败，或最近一次 run_tests 退出码非 0/超时（由循环跟踪）
    const failedTests =
      input.toolRecords.some((r) => r.name === 'run_tests' && !r.ok) || input.testsFailed === true;
    if (failedTests) {
      reasons.push('存在执行失败的测试（run_tests 未通过），不能判定为已完成');
    }

    // 验收标准明确要求测试时，必须存在成功的测试执行
    if (input.acceptance && ACCEPTANCE_TEST_RE.test(input.acceptance)) {
      const hasPassingTests = input.toolRecords.some((r) => r.name === 'run_tests' && r.ok);
      if (!hasPassingTests) {
        reasons.push('验收标准要求测试通过，但任务未执行任何成功的测试命令');
      }
    }

    if (
      (this.opts.requireTestsWhenFilesChanged ?? true) &&
      input.fileChanges.length > 0 &&
      !input.toolRecords.some((r) => r.name === 'run_tests' && r.ok)
    ) {
      warnings.push(`本任务修改了 ${input.fileChanges.length} 个文件，但未执行 run_tests 验证`);
    }

    if (input.deniedApprovals > 0) {
      warnings.push(`${input.deniedApprovals} 项操作被用户拒绝，相关步骤未执行`);
    }

    if (input.endReason && finish) {
      warnings.push(`循环提前终止：${input.endReason}`);
    }

    if (reasons.length > 0) {
      return { status: finish ? 'needs_review' : 'failed', reasons, warnings };
    }
    return { status: 'completed', reasons, warnings };
  }
}

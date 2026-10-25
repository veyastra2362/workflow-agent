import { z } from 'zod';
import type { ToolDefinition } from './registry';

// ---------------------------------------------------------------------------
// complete_task —— 任务结束标记。Agent Loop 拦截此调用并交给 Verifier 裁决。
// ---------------------------------------------------------------------------

const completeTaskArgs = z.object({
  summary: z.string().min(1).max(8000),
  verification: z.string().max(4000).optional(),
  blockers: z.string().max(4000).optional(),
  files_changed: z.array(z.string().max(500)).max(50).optional()
});

export const completeTaskTool: ToolDefinition<z.infer<typeof completeTaskArgs>> = {
  name: 'complete_task',
  description:
    '提交任务完成汇报并结束任务。必须包含 summary（完成内容）与 verification（你实际执行过的验证及结果）；如有未完成事项或阻塞原因，写入 blockers。注意：任务是否成功由系统验收程序判定，不取决于此调用本身。',
  riskLevel: 'read',
  timeoutMs: 5_000,
  schema: completeTaskArgs,
  async execute() {
    return { acknowledged: true };
  },
  summarize() {
    return '提交任务汇报';
  }
};

// ---------------------------------------------------------------------------
// submit_plan —— 计划提交（可选步骤）
// ---------------------------------------------------------------------------

const submitPlanArgs = z.object({
  steps: z.array(z.string().min(1).max(500)).min(1).max(20)
});

export const submitPlanTool: ToolDefinition<z.infer<typeof submitPlanArgs>> = {
  name: 'submit_plan',
  description: '提交任务执行计划（有序步骤列表）。复杂任务应在开始执行前调用一次；简单任务可跳过。',
  riskLevel: 'read',
  timeoutMs: 5_000,
  schema: submitPlanArgs,
  async execute(args) {
    // 计划状态由 Agent Loop 持有并持久化；这里返回步数便于摘要与排查
    return { acknowledged: true, steps: args.steps.length };
  },
  summarize(data) {
    const d = data as { steps?: number | string[] };
    const count = Array.isArray(d.steps) ? d.steps.length : d.steps;
    return count != null ? `计划 ${count} 步` : '提交计划';
  }
};

// ---------------------------------------------------------------------------
// update_plan —— 步骤状态跟踪（由 Agent Loop 拦截并应用到计划状态）
// ---------------------------------------------------------------------------

const updatePlanArgs = z.object({
  step_updates: z
    .array(
      z.object({
        index: z.number().int().min(1),
        status: z.enum(['done', 'skipped'])
      })
    )
    .min(1)
    .max(20),
  note: z.string().max(500).optional()
});

export const updatePlanTool: ToolDefinition<z.infer<typeof updatePlanArgs>> = {
  name: 'update_plan',
  description:
    '更新执行计划中的步骤状态。step_updates 为要更新的步骤列表：index 是 submit_plan 中步骤的序号（从 1 开始），status 为 done（已完成）或 skipped（已跳过）。每完成一个步骤应及时标记；未提交计划或索引越界会返回错误。',
  riskLevel: 'read',
  timeoutMs: 5_000,
  schema: updatePlanArgs,
  async execute() {
    // 实际状态变更由 Agent Loop 基于任务内计划状态裁决
    return { acknowledged: true };
  },
  summarize() {
    return '更新计划状态';
  }
};

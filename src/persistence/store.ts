import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  FileChangeRecord,
  PendingActionRecord,
  TaskDetail,
  TaskEvent,
  TaskEventType,
  TaskStatus,
  TaskSummary,
  TemplateConstraints,
  TemplateDetail,
  TemplateParam,
  TemplateSummary,
  ToolCallRecord
} from '../shared/types';

/**
 * State Store：任务、事件、工具调用、待审批操作、文件变更的持久化访问层。
 * 所有 JSON 字段在此层做序列化/反序列化，上层不接触 SQL。
 */

export interface TaskRowInput {
  id: string;
  goal: string;
  acceptance?: string;
  workspace: string;
  templateId?: string;
  templateName?: string;
}

export interface FinishTaskInput {
  status: TaskStatus;
  summary?: string;
  report?: unknown;
  error?: string;
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  // ---------- tasks ----------

  createTask(input: TaskRowInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, goal, acceptance, workspace, status, template_id, template_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.goal,
        input.acceptance ?? null,
        input.workspace,
        input.templateId ?? null,
        input.templateName ?? null,
        now,
        now
      );
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  setTaskPlan(id: string, planJson: string): void {
    this.db.prepare('UPDATE tasks SET plan_json = ?, updated_at = ? WHERE id = ?').run(planJson, Date.now(), id);
  }

  saveTranscript(id: string, transcriptJson: string): void {
    this.db
      .prepare('UPDATE tasks SET transcript_json = ?, updated_at = ? WHERE id = ?')
      .run(transcriptJson, Date.now(), id);
  }

  finishTask(id: string, input: FinishTaskInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, summary = ?, report_json = ?, error = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.summary ?? null,
        input.report === undefined ? null : JSON.stringify(input.report),
        input.error ?? null,
        now,
        now,
        id
      );
  }

  getTask(id: string): TaskDetail | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      goal: String(row.goal),
      acceptance: row.acceptance === null ? undefined : String(row.acceptance),
      workspace: String(row.workspace),
      status: row.status as TaskStatus,
      templateId: row.template_id == null ? undefined : String(row.template_id),
      templateName: row.template_name == null ? undefined : String(row.template_name),
      planJson: row.plan_json === null ? undefined : String(row.plan_json),
      transcriptJson: row.transcript_json === null ? undefined : String(row.transcript_json),
      summary: row.summary === null ? undefined : String(row.summary),
      report: row.report_json === null ? undefined : JSON.parse(String(row.report_json)),
      error: row.error === null ? undefined : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      events: this.listEvents(id),
      fileChanges: this.listFileChanges(id),
      pendingActions: this.listPendingActions(id),
      toolCalls: this.listToolCalls(id)
    } as TaskDetail & { report?: unknown };
  }

  listTasks(): TaskSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, goal, status, workspace, created_at, updated_at, template_id, template_name
         FROM tasks ORDER BY created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      goal: String(r.goal),
      status: r.status as TaskStatus,
      workspace: String(r.workspace),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      templateId: r.template_id == null ? undefined : String(r.template_id),
      templateName: r.template_name == null ? undefined : String(r.template_name)
    }));
  }

  /** 找到应用崩溃/退出时仍处于未完成状态的任务，用于启动时标记为 interrupted。 */
  findUnfinishedTasks(): TaskSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, goal, status, workspace, created_at, updated_at, template_id, template_name
         FROM tasks
         WHERE status IN ('queued','running','waiting_approval','paused')
         ORDER BY created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      goal: String(r.goal),
      status: r.status as TaskStatus,
      workspace: String(r.workspace),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      templateId: r.template_id == null ? undefined : String(r.template_id),
      templateName: r.template_name == null ? undefined : String(r.template_name)
    }));
  }

  // ---------- events ----------

  addEvent(taskId: string, type: TaskEventType, data: Record<string, unknown>): TaskEvent {
    const ts = Date.now();
    const res = this.db
      .prepare('INSERT INTO events (task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, type, JSON.stringify(data), ts);
    return {
      id: Number(res.lastInsertRowid),
      taskId,
      ts,
      type,
      data
    };
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT id, task_id, type, payload_json, created_at FROM events WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      ts: Number(r.created_at),
      type: r.type as TaskEventType,
      data: JSON.parse(String(r.payload_json)) as Record<string, unknown>
    }));
  }

  // ---------- tool calls ----------

  addToolCall(rec: {
    id: string;
    taskId: string;
    name: string;
    argsSummary: string;
    status: string;
    durationMs: number;
    resultSummary: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, task_id, name, args_summary, status, duration_ms, result_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(rec.id, rec.taskId, rec.name, rec.argsSummary, rec.status, rec.durationMs, rec.resultSummary, Date.now());
  }

  listToolCalls(taskId: string): ToolCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, name, args_summary, status, duration_ms, result_summary, created_at
         FROM tool_calls WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      name: String(r.name),
      argsSummary: String(r.args_summary),
      status: String(r.status),
      durationMs: Number(r.duration_ms),
      resultSummary: String(r.result_summary),
      createdAt: Number(r.created_at)
    }));
  }

  // ---------- pending actions ----------

  addPendingAction(rec: {
    id: string;
    taskId: string;
    toolName: string;
    argsSummary: string;
    reason: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions (id, task_id, tool_name, args_summary, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(rec.id, rec.taskId, rec.toolName, rec.argsSummary, rec.reason, Date.now());
  }

  resolvePendingAction(id: string, status: 'approved' | 'denied' | 'expired'): void {
    this.db
      .prepare('UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  getPendingAction(id: string): PendingActionRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      toolName: String(row.tool_name),
      argsSummary: String(row.args_summary),
      reason: String(row.reason),
      status: row.status as PendingActionRecord['status'],
      createdAt: Number(row.created_at)
    };
  }

  listPendingActions(taskId: string): PendingActionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM pending_actions WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      toolName: String(r.tool_name),
      argsSummary: String(r.args_summary),
      reason: String(r.reason),
      status: r.status as PendingActionRecord['status'],
      createdAt: Number(r.created_at)
    }));
  }

  // ---------- file changes ----------

  addFileChange(rec: {
    taskId: string;
    path: string;
    kind: 'create' | 'modify';
    backupContent: string | null;
  }): FileChangeRecord {
    const createdAt = Date.now();
    const res = this.db
      .prepare(
        'INSERT INTO file_changes (task_id, path, kind, backup_content, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(rec.taskId, rec.path, rec.kind, rec.backupContent, createdAt);
    return {
      id: Number(res.lastInsertRowid),
      taskId: rec.taskId,
      path: rec.path,
      kind: rec.kind,
      backupAvailable: rec.backupContent !== null,
      restoredAt: null,
      createdAt
    };
  }

  listFileChanges(taskId: string): FileChangeRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, task_id, path, kind, backup_content, restored_at, created_at FROM file_changes WHERE task_id = ? ORDER BY id ASC'
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      path: String(r.path),
      kind: r.kind as 'create' | 'modify',
      backupAvailable: r.backup_content !== null,
      restoredAt: r.restored_at === null || r.restored_at === undefined ? null : Number(r.restored_at),
      createdAt: Number(r.created_at)
    }));
  }

  markFileChangeRestored(id: number): void {
    this.db.prepare('UPDATE file_changes SET restored_at = ? WHERE id = ?').run(Date.now(), id);
  }

  getFileChangeBackup(changeId: number): { path: string; backupContent: string | null } | null {
    const row = this.db.prepare('SELECT path, backup_content FROM file_changes WHERE id = ?').get(changeId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      path: String(row.path),
      backupContent: row.backup_content === null ? null : String(row.backup_content)
    };
  }

  // ---------- templates ----------

  saveTemplate(input: {
    id?: string;
    name: string;
    description: string;
    goalTemplate: string;
    acceptanceTemplate?: string;
    params: TemplateParam[];
    constraints: TemplateConstraints;
  }): TemplateDetail {
    const conflict = this.getTemplateByName(input.name);
    if (conflict && conflict.id !== input.id) {
      throw new Error(`模板名称 "${input.name}" 已被其他模板使用`);
    }
    const now = Date.now();
    if (input.id && this.getTemplate(input.id)) {
      this.db
        .prepare(
          `UPDATE templates
           SET name = ?, description = ?, goal_template = ?, acceptance_template = ?,
               params_json = ?, constraints_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.description,
          input.goalTemplate,
          input.acceptanceTemplate ?? null,
          JSON.stringify(input.params),
          JSON.stringify(input.constraints),
          now,
          input.id
        );
      return this.getTemplate(input.id)!;
    }
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO templates (id, name, description, goal_template, acceptance_template, params_json, constraints_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description,
        input.goalTemplate,
        input.acceptanceTemplate ?? null,
        JSON.stringify(input.params),
        JSON.stringify(input.constraints),
        now,
        now
      );
    return this.getTemplate(id)!;
  }

  getTemplate(id: string): TemplateDetail | null {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToTemplate(row) : null;
  }

  getTemplateByName(name: string): TemplateDetail | null {
    const row = this.db.prepare('SELECT * FROM templates WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToTemplate(row) : null;
  }

  listTemplates(): TemplateSummary[] {
    const rows = this.db
      .prepare('SELECT id, name, description, updated_at FROM templates ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: String(r.description),
      updatedAt: Number(r.updated_at)
    }));
  }

  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  private rowToTemplate(row: Record<string, unknown>): TemplateDetail {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      goalTemplate: String(row.goal_template),
      acceptanceTemplate:
        row.acceptance_template == null ? undefined : String(row.acceptance_template),
      params: JSON.parse(String(row.params_json)) as TemplateParam[],
      constraints: JSON.parse(String(row.constraints_json)) as TemplateConstraints,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  close(): void {
    this.db.close();
  }
}

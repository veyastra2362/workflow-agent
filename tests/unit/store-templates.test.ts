import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/persistence/db';
import { Store } from '../../src/persistence/store';

describe('Store：模板 CRUD', () => {
  it('保存/查询/列表/删除往返', () => {
    const store = new Store(openDatabase(':memory:'));
    const saved = store.saveTemplate({
      name: '代码整理',
      description: 'd',
      goalTemplate: '整理 {{directory}}',
      acceptanceTemplate: '{{directory}} 无重复',
      params: [{ name: 'directory', required: true, default: 'src' }],
      constraints: { maxSteps: 10, allowedTools: ['read_file'] }
    });
    expect(saved.id).toBeTruthy();
    expect(saved.params[0]).toEqual({ name: 'directory', required: true, default: 'src' });

    const got = store.getTemplate(saved.id)!;
    expect(got.name).toBe('代码整理');
    expect(got.constraints).toEqual({ maxSteps: 10, allowedTools: ['read_file'] });
    expect(store.getTemplateByName('代码整理')!.id).toBe(saved.id);
    expect(store.listTemplates()).toHaveLength(1);

    store.deleteTemplate(saved.id);
    expect(store.getTemplate(saved.id)).toBeNull();
    expect(store.listTemplates()).toHaveLength(0);
  });

  it('同名模板被拒绝（不同 id）', () => {
    const store = new Store(openDatabase(':memory:'));
    store.saveTemplate({ name: 'A', description: '', goalTemplate: 'g', params: [], constraints: {} });
    expect(() =>
      store.saveTemplate({ name: 'A', description: '', goalTemplate: 'g2', params: [], constraints: {} })
    ).toThrow(/已被其他模板使用/);
  });

  it('带 id 保存 = 更新（名称可改，id 不变）', () => {
    const store = new Store(openDatabase(':memory:'));
    const t = store.saveTemplate({ name: 'A', description: '', goalTemplate: 'g', params: [], constraints: {} });
    const updated = store.saveTemplate({
      id: t.id,
      name: 'B',
      description: 'new',
      goalTemplate: 'g2',
      params: [{ name: 'x', required: false }],
      constraints: { maxSteps: 5 }
    });
    expect(updated.id).toBe(t.id);
    expect(updated.name).toBe('B');
    expect(store.listTemplates()).toHaveLength(1);
    expect(store.getTemplateByName('A')).toBeNull();
  });
});

describe('模板/任务列：文件库持久化与旧库迁移', () => {
  function tempDbPath(): string {
    return path.join(os.tmpdir(), `wa-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  }

  it('重开数据库后模板仍在，tasks 模板列可读写', () => {
    const dbPath = tempDbPath();
    try {
      const store1 = new Store(openDatabase(dbPath));
      const tpl = store1.saveTemplate({
        name: '整理',
        description: '',
        goalTemplate: '整理 {{dir}}',
        params: [{ name: 'dir', required: true }],
        constraints: { maxSteps: 8 }
      });
      store1.createTask({
        id: 't1',
        goal: '整理 src',
        workspace: '/tmp/ws',
        templateId: tpl.id,
        templateName: tpl.name
      });
      store1.close();

      // 模拟应用重启
      const store2 = new Store(openDatabase(dbPath));
      expect(store2.listTemplates()[0]!.name).toBe('整理');
      const task = store2.getTask('t1')!;
      expect(task.templateId).toBe(tpl.id);
      expect(task.templateName).toBe('整理');
      expect(store2.listTasks()[0]!.templateName).toBe('整理');
      store2.close();
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it('阶段 3 之前的旧库（tasks 无模板列）打开时自动迁移', () => {
    const dbPath = tempDbPath();
    try {
      // 手工构造旧结构：无 template_id/template_name/restored_at
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          goal TEXT NOT NULL,
          acceptance TEXT,
          workspace TEXT NOT NULL,
          status TEXT NOT NULL,
          plan_json TEXT,
          transcript_json TEXT,
          summary TEXT,
          report_json TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE TABLE file_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          backup_content TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO tasks (id, goal, workspace, status, created_at, updated_at)
          VALUES ('legacy-1', '旧任务', '/tmp', 'completed', 1, 1);
      `);
      legacy.close();

      const store = new Store(openDatabase(dbPath));
      const task = store.getTask('legacy-1')!;
      expect(task.goal).toBe('旧任务');
      expect(task.templateName).toBeUndefined();
      // 迁移后可正常写入新列
      store.createTask({ id: 't2', goal: 'g', workspace: '/tmp', templateName: 'T' });
      expect(store.getTask('t2')!.templateName).toBe('T');
      store.close();
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});

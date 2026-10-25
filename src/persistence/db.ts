import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 打开与迁移。使用 Node >= 22.13 / Electron >= 35 内置的 node:sqlite，
 * 避免引入需要按 ABI 重编译的原生模块。
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
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

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  result_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id, created_at);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  backup_content TEXT,
  restored_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_changes_task ON file_changes(task_id, id);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  goal_template TEXT NOT NULL,
  acceptance_template TEXT,
  params_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** 轻量迁移：为旧版本库补充新增列/表。 */
function migrate(db: DatabaseSync): void {
  const ensureColumn = (table: string, column: string, ddl: string): void => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    const names = new Set(columns.map((c) => String(c.name)));
    if (!names.has(column)) {
      db.exec(ddl);
    }
  };
  ensureColumn('file_changes', 'restored_at', 'ALTER TABLE file_changes ADD COLUMN restored_at INTEGER');
  ensureColumn('tasks', 'template_id', 'ALTER TABLE tasks ADD COLUMN template_id TEXT');
  ensureColumn('tasks', 'template_name', 'ALTER TABLE tasks ADD COLUMN template_name TEXT');
}

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // :memory: 等场景下 WAL 不可用，忽略
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

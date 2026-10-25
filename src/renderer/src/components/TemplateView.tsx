import { useEffect, useState, type ReactNode } from 'react';
import type { TemplateDetail, TemplateSummary } from '../../../shared/types';
import { Btn, Card, Field, inputCls } from './ui';

/**
 * 任务模板管理（阶段 4.1）：
 * - 列表 + 新建/编辑/删除（占位符、工具名、约束范围由主进程校验并回报错误）；
 * - 参数 = 目标/验收中的 {{占位符}} 自动推导；「参数默认值」里给过默认值的参数变为可选；
 * - 「使用」展开参数表单；渲染与执行约束全部在主进程完成。
 */

interface FormState {
  id?: string;
  name: string;
  description: string;
  goalTemplate: string;
  acceptanceTemplate: string;
  defaults: string; // 每行 name=默认值
  maxSteps: string;
  timeoutMin: string;
  allowedTools: string; // 每行一个工具名，留空 = 不限制
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  goalTemplate: '',
  acceptanceTemplate: '',
  defaults: '',
  maxSteps: '',
  timeoutMin: '',
  allowedTools: ''
};

export function TemplateView({ onStarted }: { onStarted: (taskId: string) => void }): ReactNode {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [using, setUsing] = useState<{ template: TemplateDetail; values: Record<string, string> } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setTemplates(await window.api.listTemplates());
    } catch (err) {
      setMessage(`加载模板失败：${String(err)}`);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openUse = async (id: string): Promise<void> => {
    try {
      const detail = await window.api.getTemplate(id);
      if (!detail) throw new Error('模板不存在');
      setUsing({
        template: detail,
        values: Object.fromEntries(detail.params.map((p) => [p.name, p.default ?? '']))
      });
      setEditing(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const buildParams = (form: FormState): Array<{ name: string; required: boolean; default?: string }> => {
    const defaults = parseDefaults(form.defaults);
    const seen = new Map<string, { name: string; required: boolean; default?: string }>();
    for (const m of `${form.goalTemplate}\n${form.acceptanceTemplate}`.matchAll(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
    )) {
      const name = m[1]!;
      if (!seen.has(name)) {
        const def = defaults.get(name);
        seen.set(name, { name, required: def === undefined, default: def });
      }
    }
    return [...seen.values()];
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setMessage(null);
    try {
      const constraints: Record<string, unknown> = {};
      if (editing.maxSteps.trim()) constraints.maxSteps = Number(editing.maxSteps);
      if (editing.timeoutMin.trim()) constraints.taskTimeoutMs = Number(editing.timeoutMin) * 60_000;
      const tools = editing.allowedTools
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (tools.length > 0) constraints.allowedTools = tools;
      await window.api.saveTemplate({
        id: editing.id,
        name: editing.name.trim(),
        description: editing.description.trim(),
        goalTemplate: editing.goalTemplate,
        acceptanceTemplate: editing.acceptanceTemplate.trim() || undefined,
        params: buildParams(editing),
        constraints
      });
      setEditing(null);
      await refresh();
      setMessage('模板已保存');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await window.api.deleteTemplate(id);
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!using) return;
    setBusy(true);
    setMessage(null);
    try {
      const { taskId } = await window.api.startFromTemplate({
        templateId: using.template.id,
        paramValues: using.values
      });
      setUsing(null);
      onStarted(taskId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const editExisting = async (id: string): Promise<void> => {
    try {
      const d = await window.api.getTemplate(id);
      if (!d) throw new Error('模板不存在');
      setEditing({
        id: d.id,
        name: d.name,
        description: d.description,
        goalTemplate: d.goalTemplate,
        acceptanceTemplate: d.acceptanceTemplate ?? '',
        defaults: d.params
          .filter((p) => p.default !== undefined)
          .map((p) => `${p.name}=${p.default}`)
          .join('\n'),
        maxSteps: d.constraints.maxSteps ? String(d.constraints.maxSteps) : '',
        timeoutMin: d.constraints.taskTimeoutMs ? String(Math.round(d.constraints.taskTimeoutMs / 60_000)) : '',
        allowedTools: (d.constraints.allowedTools ?? []).join('\n')
      });
      setUsing(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">任务模板</h2>
        <Btn variant="primary" onClick={() => setEditing({ ...EMPTY_FORM })}>
          ＋ 新建模板
        </Btn>
      </div>
      {message && (
        <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">{message}</div>
      )}

      {editing && (
        <Card className="space-y-4 p-5">
          <h3 className="text-sm font-medium text-zinc-300">{editing.id ? `编辑模板${templates.find((t) => t.id === editing.id) ? `：${templates.find((t) => t.id === editing.id)!.name}` : ''}` : '新建模板'}</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="模板名称">
              <input
                className={inputCls}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="如：代码整理"
              />
            </Field>
            <Field label="描述">
              <input
                className={inputCls}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </Field>
          </div>
          <Field label="任务目标模板" hint="用 {{参数名}} 占位，如：整理 {{directory}} 目录下的重复代码">
            <textarea
              className={`${inputCls} min-h-20`}
              value={editing.goalTemplate}
              onChange={(e) => setEditing({ ...editing, goalTemplate: e.target.value })}
            />
          </Field>
          <Field label="验收标准模板（可选，支持同样的占位符）">
            <textarea
              className={`${inputCls} min-h-14`}
              value={editing.acceptanceTemplate}
              onChange={(e) => setEditing({ ...editing, acceptanceTemplate: e.target.value })}
            />
          </Field>
          <Field
            label="参数默认值（每行 名称=默认值）"
            hint="占位符自动推导为必填参数；给出默认值的参数变为可选"
          >
            <div className="space-y-2">
              <textarea
                className={`${inputCls} mono min-h-14`}
                value={editing.defaults}
                onChange={(e) => setEditing({ ...editing, defaults: e.target.value })}
                placeholder={'directory=src'}
              />
              <div className="mono rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                {buildParams(editing)
                  .map((p) => `${p.name}${p.required ? '（必填）' : `（默认：${p.default}）`}`)
                  .join('、') || '（目标中还没有占位符）'}
              </div>
            </div>
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="最大步数（留空=不限）" hint="只能比全局更严">
              <input
                className={inputCls}
                type="number"
                min={1}
                max={200}
                value={editing.maxSteps}
                onChange={(e) => setEditing({ ...editing, maxSteps: e.target.value })}
              />
            </Field>
            <Field label="任务超时（分钟，留空=不限）">
              <input
                className={inputCls}
                type="number"
                min={1}
                max={360}
                value={editing.timeoutMin}
                onChange={(e) => setEditing({ ...editing, timeoutMin: e.target.value })}
              />
            </Field>
            <Field label="允许的工具" hint="每行一个（如 read_file），留空=全部">
              <textarea
                className={`${inputCls} mono min-h-10`}
                value={editing.allowedTools}
                onChange={(e) => setEditing({ ...editing, allowedTools: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Btn variant="primary" onClick={() => void save()} disabled={busy || !editing.name || !editing.goalTemplate}>
              保存
            </Btn>
            <Btn onClick={() => setEditing(null)}>取消</Btn>
          </div>
        </Card>
      )}

      {using && (
        <Card className="space-y-4 border-sky-500/30 p-5">
          <h3 className="text-sm font-medium text-zinc-300">使用模板：{using.template.name}</h3>
          {using.template.params.length === 0 && (
            <div className="text-xs text-zinc-500">此模板没有参数，可直接启动。</div>
          )}
          {using.template.params.map((p) => (
            <Field key={p.name} label={`${p.name}${p.required ? '（必填）' : ''}`}>
              <input
                className={inputCls}
                value={using.values[p.name] ?? ''}
                onChange={(e) => setUsing({ ...using, values: { ...using.values, [p.name]: e.target.value } })}
              />
            </Field>
          ))}
          <div className="flex gap-2">
            <Btn variant="primary" onClick={() => void start()} disabled={busy}>
              ▶ 从模板启动任务
            </Btn>
            <Btn onClick={() => setUsing(null)}>取消</Btn>
          </div>
        </Card>
      )}

      {templates.length === 0 && !editing && (
        <div className="py-10 text-center text-sm text-zinc-600">还没有模板，点击右上角"新建模板"创建一个</div>
      )}
      {templates.map((t) => (
        <Card key={t.id} className="flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="text-sm text-zinc-100">{t.name}</div>
            <div className="mt-0.5 truncate text-xs text-zinc-500">{t.description || '（无描述）'}</div>
            <div className="mt-1 text-[11px] text-zinc-600">更新于 {new Date(t.updatedAt).toLocaleString()}</div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Btn variant="primary" onClick={() => void openUse(t.id)}>
              使用
            </Btn>
            <Btn onClick={() => void editExisting(t.id)}>编辑</Btn>
            {confirmDeleteId === t.id ? (
              <Btn variant="danger" onClick={() => void remove(t.id)} disabled={busy}>
                确认删除
              </Btn>
            ) : (
              <Btn variant="ghost" onClick={() => setConfirmDeleteId(t.id)}>
                删除
              </Btn>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function parseDefaults(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) map.set(name, value);
  }
  return map;
}

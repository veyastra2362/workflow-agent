import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, TaskDetail, TaskEvent, TaskSummary } from '../../shared/types';
import { Sidebar } from './components/Sidebar';
import { TaskView } from './components/TaskView';
import { SettingsView } from './components/SettingsView';
import { TemplateView } from './components/TemplateView';

type ViewKey = 'task' | 'settings' | 'templates';

export default function App(): ReactNode {
  const [view, setView] = useState<ViewKey>('task');
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const eventIdsRef = useRef<Set<number>>(new Set());

  activeTaskRef.current = activeTaskId;

  const refreshTasks = useCallback(async (): Promise<void> => {
    try {
      setTasks(await window.api.listTasks());
    } catch {
      // 忽略刷新失败
    }
  }, []);

  const loadTask = useCallback(async (id: string): Promise<void> => {
    try {
      const d = await window.api.getTask(id);
      if (!d) return;
      setDetail(d);
      eventIdsRef.current = new Set(d.events.map((e) => e.id));
      setEvents(d.events);
    } catch (err) {
      showToast(`加载任务失败：${String(err)}`);
    }
  }, []);

  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  // 初始化：设置 + 任务列表 + 事件订阅
  useEffect(() => {
    window.api
      .getSettings()
      .then((s: AppSettings) => setWorkspace(s.lastWorkspace))
      .catch(() => undefined);
    void refreshTasks();

    const off = window.api.onTaskEvent((ev) => {
      // 只实时追加当前打开任务的增量事件
      if (ev.taskId === activeTaskRef.current && !eventIdsRef.current.has(ev.id)) {
        eventIdsRef.current.add(ev.id);
        setEvents((prev) => [...prev, ev]);
      }
      if (
        ev.type === 'status_changed' ||
        ev.type === 'task_finished' ||
        ev.type === 'approval_required' ||
        ev.type === 'approval_resolved'
      ) {
        void refreshTasks();
      }
      // 文件变更/回滚后刷新详情（文件变更页实时显示持久化记录与回滚状态）
      if ((ev.type === 'file_changed' || ev.type === 'file_restored') && ev.taskId === activeTaskRef.current) {
        void loadTask(ev.taskId);
      }
      if (ev.type === 'task_finished' && ev.taskId === activeTaskRef.current) {
        void loadTask(ev.taskId);
      }
    });
    return off;
  }, [refreshTasks, loadTask]);

  const selectTask = (id: string): void => {
    setActiveTaskId(id);
    setView('task');
    void loadTask(id);
  };

  const selectWorkspace = async (): Promise<void> => {
    try {
      const dir = await window.api.selectWorkspace();
      if (dir) setWorkspace(dir);
    } catch (err) {
      showToast(`选择工作区失败：${String(err)}`);
    }
  };

  const startTask = async (goal: string, acceptance: string): Promise<void> => {
    try {
      const { taskId } = await window.api.startTask({
        goal,
        acceptance: acceptance.trim() || undefined
        // 不传 modelConfig = 使用设置中已保存的模型配置
      });
      setActiveTaskId(taskId);
      setDetail(null);
      setEvents([]);
      eventIdsRef.current = new Set();
      void loadTask(taskId);
      void refreshTasks();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelTask = async (): Promise<void> => {
    if (!activeTaskId) return;
    try {
      await window.api.cancelTask(activeTaskId);
    } catch (err) {
      showToast(String(err));
    }
  };

  const pauseTask = async (): Promise<void> => {
    if (!activeTaskId) return;
    try {
      const ok = await window.api.pauseTask(activeTaskId);
      if (!ok) showToast('当前没有正在运行的任务可暂停');
    } catch (err) {
      showToast(String(err));
    }
  };

  const resumeTask = async (): Promise<void> => {
    if (!activeTaskId) return;
    try {
      await window.api.resumeTask(activeTaskId);
      showToast('任务已恢复执行');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const approve = async (actionId: string, approved: boolean): Promise<void> => {
    try {
      await window.api.resolveApproval(actionId, approved);
    } catch (err) {
      showToast(String(err));
    }
  };

  const restoreChange = async (changeId: number): Promise<void> => {
    if (!activeTaskId) return;
    try {
      const r = await window.api.restoreFileChange(activeTaskId, changeId);
      showToast(r.restored ? `已回滚 ${r.path}` : '该变更此前已回滚');
      void loadTask(activeTaskId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const restoreAll = async (): Promise<void> => {
    if (!activeTaskId) return;
    try {
      const r = await window.api.restoreTaskFiles(activeTaskId);
      showToast(r.paths.length > 0 ? `已回滚 ${r.paths.length} 个文件` : '没有可回滚的变更');
      void loadTask(activeTaskId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full">
      <Sidebar
        workspace={workspace}
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={selectTask}
        onSelectWorkspace={() => void selectWorkspace()}
        onOpenSettings={() => setView('settings')}
        onOpenTemplates={() => setView('templates')}
      />
      <main className="min-w-0 flex-1">
        {view === 'settings' ? (
          <SettingsView
            onSaved={() => undefined}
          />
        ) : view === 'templates' ? (
          <TemplateView
            onStarted={(taskId) => {
              setActiveTaskId(taskId);
              setDetail(null);
              setEvents([]);
              eventIdsRef.current = new Set();
              void loadTask(taskId);
              void refreshTasks();
              setView('task');
            }}
          />
        ) : (
          <TaskView
            detail={detail}
            events={events}
            workspace={workspace}
            busy={false}
            onStart={(g, a) => void startTask(g, a)}
            onCancel={() => void cancelTask()}
            onPause={() => void pauseTask()}
            onResume={() => void resumeTask()}
            onApprove={(id, ok) => void approve(id, ok)}
            onRestoreChange={(id) => void restoreChange(id)}
            onRestoreAll={() => void restoreAll()}
          />
        )}
      </main>
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

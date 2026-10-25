import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, ConnectionTestResult } from '../../../shared/types';
import { Btn, Card, Field, inputCls } from './ui';

export function SettingsView({ onSaved }: { onSaved: (s: AppSettings) => void }): ReactNode {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [streaming, setStreaming] = useState(true);
  const [maxSteps, setMaxSteps] = useState(40);
  const [taskTimeoutMin, setTaskTimeoutMin] = useState(15);
  const [testCommands, setTestCommands] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [requireWrites, setRequireWrites] = useState(false);
  const [requireWeb, setRequireWeb] = useState(false);
  const [searchProvider, setSearchProvider] = useState<'none' | 'searxng' | 'brave'>('none');
  const [searchBaseUrl, setSearchBaseUrl] = useState('');
  const [searchKey, setSearchKey] = useState('');
  const [webMsg, setWebMsg] = useState<string | null>(null);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [chromiumStatus, setChromiumStatus] = useState<{ installed: boolean; browsersPath: string } | null>(null);
  const [chromiumInstalling, setChromiumInstalling] = useState(false);
  const [chromiumMsg, setChromiumMsg] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<Array<{ id: string; name: string; status: string; toolCount: number; error?: string }>>([]);
  const [mcpMsg, setMcpMsg] = useState<string | null>(null);
  const [mcpForm, setMcpForm] = useState<{ id?: string; name: string; command: string; args: string; env: string; enabled: boolean } | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
        setTemperature(s.temperature);
        setMaxTokens(s.maxTokens);
        setStreaming(s.streaming);
        setMaxSteps(s.maxSteps);
        setTaskTimeoutMin(Math.round(s.taskTimeoutMs / 60_000));
        setTestCommands(s.allowedTestCommands.join('\n'));
        setAutoApprove(s.autoApproveTestCommands);
        setRequireWrites(s.requireApprovalForWrites);
        setRequireWeb(s.requireApprovalForWeb);
        setSearchProvider(s.searchProvider);
        setSearchBaseUrl(s.searchBaseUrl);
        setBrowserEnabled(s.browserEnabled);
      })
      .catch((err) => setSaveMsg(`加载设置失败：${String(err)}`));
  }, []);

  const buildConfig = () => ({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim() || undefined, // 留空保留旧 Key
    model: model.trim(),
    temperature,
    maxTokens,
    streaming,
    maxSteps,
    taskTimeoutMs: taskTimeoutMin * 60_000,
    allowedTestCommands: testCommands
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    autoApproveTestCommands: autoApprove,
    requireApprovalForWrites: requireWrites,
    browserEnabled
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const next = await window.api.setModelConfig(buildConfig());
      setSettings(next);
      setApiKey('');
      setSaveMsg('已保存（API Key 仅保存在本次运行的内存中，重启后需重新输入）');
      onSaved(next);
    } catch (err) {
      setSaveMsg(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.api.testConnection({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        model: model.trim()
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const refreshMcp = async (): Promise<void> => {
    try {
      const r = await window.api.listMcpServers();
      setMcpServers(r.servers);
    } catch (err) {
      setMcpMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const saveMcp = async (): Promise<void> => {
    if (!mcpForm) return;
    setMcpBusy(true);
    setMcpMsg(null);
    try {
      const args = mcpForm.args.split('\n').map((s) => s.trim()).filter(Boolean);
      const env: Record<string, string> = {};
      for (const line of mcpForm.env.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1);
      }
      const r = await window.api.saveMcpServer({
        id: mcpForm.id ?? crypto.randomUUID(),
        name: mcpForm.name.trim(),
        command: mcpForm.command.trim(),
        args,
        env,
        enabled: mcpForm.enabled
      });
      setMcpServers(r.servers);
      setMcpForm(null);
      setMcpMsg('已保存并触发连接');
      const s = await window.api.getSettings();
      setSettings(s);
    } catch (err) {
      setMcpMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpBusy(false);
    }
  };

  useEffect(() => {
    void refreshMcp();
    void window.api.browserCheckInstall().then(setChromiumStatus).catch(() => undefined);
  }, []);

  const saveWeb = async (): Promise<void> => {
    setSaving(true);
    setWebMsg(null);
    try {
      const next = await window.api.setWebConfig({
        provider: searchProvider,
        baseUrl: searchProvider === 'none' ? undefined : searchBaseUrl.trim() || undefined,
        apiKey: searchKey.trim() || undefined,
        requireApprovalForWeb: requireWeb
      });
      setSettings(next);
      setSearchKey('');
      setWebMsg(
        searchProvider === 'none'
          ? '已保存并清除内存中的搜索密钥'
          : `已保存${next.hasSearchKey ? '（密钥仅存本次运行内存）' : ''}`
      );
      onSaved(next);
    } catch (err) {
      setWebMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 overflow-y-auto p-6">
      <h2 className="text-lg font-semibold text-zinc-100">模型设置</h2>

      <Card className="space-y-4 p-5">
        <Field label="API Base URL（OpenAI 兼容中转站或官方地址）" hint="例如 https://api.openai.com/v1 或你的中转站地址">
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://.../v1" />
        </Field>
        <Field
          label="API Key"
          hint={settings?.hasApiKey ? '已保存在本次运行内存中；留空则沿用旧值。不会写入磁盘或日志。' : '仅保存在本次运行的内存中，重启应用后需重新输入'}
        >
          <input
            className={inputCls}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.hasApiKey ? '••••••••（留空沿用）' : 'sk-...'}
          />
        </Field>
        <Field label="模型名称">
          <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini / deepseek-chat / ..." />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={`Temperature：${temperature}`}>
            <input type="range" min={0} max={1} step={0.05} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="w-full accent-sky-500" />
          </Field>
          <Field label="Max Tokens（单次模型回复上限）">
            <input className={inputCls} type="number" value={maxTokens} min={64} max={200000} onChange={(e) => setMaxTokens(Number(e.target.value))} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={streaming} onChange={(e) => setStreaming(e.target.checked)} className="accent-sky-500" />
          流式输出（SSE）
        </label>
      </Card>

      <div className="flex items-center gap-2">
        <Btn variant="primary" onClick={save} disabled={saving || !baseUrl || !model}>
          {saving ? '保存中…' : '保存设置'}
        </Btn>
        <Btn onClick={test} disabled={testing || !baseUrl || !model}>
          {testing ? '测试中…' : '测试连接'}
        </Btn>
        {testResult && (
          <span className={`text-sm ${testResult.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {testResult.ok ? `连接成功（${testResult.latencyMs}ms）` : `连接失败：${testResult.error}`}
          </span>
        )}
      </div>
      {saveMsg && <div className="text-xs text-zinc-400">{saveMsg}</div>}

      <h2 className="pt-4 text-lg font-semibold text-zinc-100">联网</h2>
      <Card className="space-y-4 p-5">
        <Field label="搜索服务" hint="SearXNG（自建实例 JSON API）或 Brave Search；未配置时 web_search 返回结构化错误">
          <select
            className={inputCls}
            value={searchProvider}
            onChange={(e) => setSearchProvider(e.target.value as 'none' | 'searxng' | 'brave')}
          >
            <option value="none">未配置（禁用搜索）</option>
            <option value="searxng">SearXNG</option>
            <option value="brave">Brave Search</option>
          </select>
        </Field>
        {searchProvider !== 'none' && (
          <>
            <Field label="Base URL" hint={searchProvider === 'searxng' ? '如 http://127.0.0.1:8080（自建实例允许私网与自定义端口）' : '如 https://api.search.brave.com'}>
              <input className={inputCls} value={searchBaseUrl} onChange={(e) => setSearchBaseUrl(e.target.value)} placeholder="https://..." />
            </Field>
            {searchProvider === 'brave' && (
              <Field label="API Key" hint={settings?.hasSearchKey ? '已保存在本次运行内存中；留空沿用旧值' : '仅保存在内存，不写入磁盘'}>
                <input className={inputCls} type="password" value={searchKey} onChange={(e) => setSearchKey(e.target.value)} placeholder={settings?.hasSearchKey ? '••••••••（留空沿用）' : ''} />
              </Field>
            )}
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={requireWeb} onChange={(e) => setRequireWeb(e.target.checked)} className="accent-sky-500" />
          联网操作前需要审批（开启后每次 web_fetch / web_search 都需人工确认）
        </label>
        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={browserEnabled}
            onChange={(e) => setBrowserEnabled(e.target.checked)}
            className="mt-1 accent-sky-500"
          />
          <span>
            启用浏览器自动化（browser_* 工具，独立隔离上下文）
            <span className="block text-xs text-zinc-500">
              使用内置 Chromium（首次启用需下载，体积较大）；不接管你的日常浏览器；提交/删除/支付等副作用操作始终需要审批
            </span>
          </span>
        </label>
        {/* Chromium 安装状态 */}
        {chromiumStatus && (
          <div className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2">
            <div>
              <div className="text-sm text-zinc-300">
                {chromiumStatus.installed ? '✓ Chromium 已安装' : '✗ Chromium 未安装'}
              </div>
              {!chromiumStatus.installed && (
                <div className="text-xs text-zinc-500">
                  浏览器自动化需要 Chromium（约 150MB）。下载到 {chromiumStatus.browsersPath}
                </div>
              )}
            </div>
            {!chromiumStatus.installed && (
              <Btn
                variant="primary"
                disabled={chromiumInstalling}
                onClick={async () => {
                  setChromiumInstalling(true);
                  setChromiumMsg('正在下载 Chromium...');
                  try {
                    const r = await window.api.browserInstallChromium();
                    setChromiumMsg(r.ok ? 'Chromium 安装完成并验证可用' : `安装失败：${r.error}`);
                    if (r.ok) {
                      const s = await window.api.browserCheckInstall();
                      setChromiumStatus(s);
                    }
                  } catch (err) {
                    setChromiumMsg(`安装失败：${err instanceof Error ? err.message : String(err)}`);
                  } finally {
                    setChromiumInstalling(false);
                  }
                }}
              >
                {chromiumInstalling ? '下载中...' : '下载 Chromium'}
              </Btn>
            )}
          </div>
        )}
        {chromiumMsg && <div className="text-xs text-zinc-400">{chromiumMsg}</div>}
        <div className="flex items-center gap-3">
          <Btn variant="primary" onClick={saveWeb} disabled={saving}>
            保存联网设置
          </Btn>
          {webMsg && <span className="text-xs text-zinc-400">{webMsg}</span>}
        </div>
      </Card>

      <h2 className="pt-4 text-lg font-semibold text-zinc-100">MCP 服务器（stdio）</h2>
      <Card className="space-y-3 p-5">
        <div className="text-xs text-zinc-500">
          仅添加你信任的本地程序。命令与参数分立执行（不经 Shell 拼接）；MCP 工具调用默认每次需要审批，
          服务器描述与结果均视为不可信数据；密钥不会写入配置文件。
        </div>
        {mcpServers.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2">
            <div>
              <span className="mono text-sm text-zinc-200">{s.name}</span>
              <span className="ml-2 text-xs text-zinc-500">
                {s.status === 'connected' ? `已连接（${s.toolCount} 工具）` : s.status === 'connecting' ? '连接中…' : s.status === 'error' ? `错误：${s.error ?? ''}` : '未连接'}
              </span>
            </div>
            <Btn
              onClick={async () => {
                try {
                  await window.api.reconnectMcpServer(s.id);
                  void refreshMcp();
                } catch (err) {
                  setMcpMsg(String(err));
                }
              }}
            >
              重连
            </Btn>
          </div>
        ))}
        {mcpForm ? (
          <div className="space-y-2 rounded-md border border-zinc-700 p-3">
            <Field label="名称（小写 slug，如 my-tools）">
              <input className={inputCls} value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} />
            </Field>
            <Field label="可执行文件（如 node、C:\\tools\\mcp.exe，不允许空格/元字符）">
              <input className={inputCls} value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
            </Field>
            <Field label="参数（每行一个）">
              <textarea className={`${inputCls} mono min-h-14`} value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
            </Field>
            <Field label="环境变量（每行 K=V；禁止 token/secret/key 等敏感键名）">
              <textarea className={`${inputCls} mono min-h-14`} value={mcpForm.env} onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <Btn variant="primary" onClick={() => void saveMcp()} disabled={mcpBusy || !mcpForm.name || !mcpForm.command}>
                保存并连接
              </Btn>
              <Btn onClick={() => setMcpForm(null)}>取消</Btn>
            </div>
          </div>
        ) : (
          <Btn variant="primary" onClick={() => setMcpForm({ name: '', command: '', args: '', env: '', enabled: true })}>
            ＋ 添加服务器
          </Btn>
        )}
        {mcpMsg && <div className="text-xs text-zinc-400">{mcpMsg}</div>}
      </Card>

      <h2 className="pt-4 text-lg font-semibold text-zinc-100">执行与安全</h2>
      <Card className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="最大决策步数" hint="达到上限后任务安全停止">
            <input className={inputCls} type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} />
          </Field>
          <Field label="任务总超时（分钟）">
            <input className={inputCls} type="number" min={1} max={360} value={taskTimeoutMin} onChange={(e) => setTaskTimeoutMin(Number(e.target.value))} />
          </Field>
        </div>
        <Field
          label="允许的测试命令（每行一条，精确匹配）"
          hint="run_tests 只能执行这里的命令；参数经数组传递，不经过 shell，避免命令注入"
        >
          <textarea className={`${inputCls} mono min-h-24`} value={testCommands} onChange={(e) => setTestCommands(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="accent-sky-500" />
          自动批准白名单内的测试命令（关闭则每次执行前都需要确认）
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={requireWrites} onChange={(e) => setRequireWrites(e.target.checked)} className="accent-sky-500" />
          写入操作前需要审批（开启后每次 write_file / apply_patch 都需人工确认）
        </label>
      </Card>
    </div>
  );
}

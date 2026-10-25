import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  assertWritableInsideWorkspace,
  ensureParentInsideWorkspace,
  PolicyViolationError,
  requireReadableInsideWorkspace,
  resolveInsideWorkspace
} from '../policy/paths';
import {
  DEFAULT_LIST_LIMIT,
  IGNORED_DIRS,
  MAX_SEARCH_FILE_BYTES,
  MAX_WALK_FILES,
  globToRegExp,
  isBinaryContent,
  toWorkspaceRel,
  walkFiles
} from './fsutil';
import type { ToolDefinition } from './registry';

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const listFilesArgs = z.object({
  path: z.string().default('.'),
  maxEntries: z.number().int().min(1).max(5000).default(DEFAULT_LIST_LIMIT)
});

export const listFilesTool: ToolDefinition<z.infer<typeof listFilesArgs>> = {
  name: 'list_files',
  description:
    '列出工作区内的文件与目录（自动忽略 node_modules、.git 等目录，不跟随符号链接）。path 为相对工作区的路径，默认根目录。',
  riskLevel: 'read',
  timeoutMs: 15_000,
  schema: listFilesArgs,
  async execute(args, ctx) {
    const abs = requireReadableInsideWorkspace(
      ctx.workspace,
      resolveInsideWorkspace(ctx.workspace, args.path)
    );
    const st = await fsp.stat(abs);
    if (st.isFile()) {
      return {
        root: ctx.workspace,
        count: 1,
        truncated: false,
        entries: [{ path: toWorkspaceRel(ctx.workspace, abs), type: 'file', size: st.size }]
      };
    }
    const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = [];
    let truncated = false;
    const relPrefix = toWorkspaceRel(ctx.workspace, abs);
    const baseRel = relPrefix === '.' ? '' : relPrefix;
    const walk = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
      if (entries.length >= args.maxEntries) {
        truncated = true;
        return;
      }
      if (depth > 8) return;
      let dirents;
      try {
        dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (entries.length >= args.maxEntries) {
          truncated = true;
          break;
        }
        if (d.isSymbolicLink()) continue; // 不跟随符号链接
        const childRel = dirRel ? `${dirRel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (IGNORED_DIRS.has(d.name)) continue;
          entries.push({ path: childRel, type: 'dir' });
          await walk(path.join(dirAbs, d.name), childRel, depth + 1);
        } else if (d.isFile()) {
          let size: number | undefined;
          try {
            size = (await fsp.stat(path.join(dirAbs, d.name))).size;
          } catch {
            size = undefined;
          }
          entries.push({ path: childRel, type: 'file', size });
        }
      }
    };
    await walk(abs, baseRel, 0);
    return { root: ctx.workspace, count: entries.length, truncated, entries };
  },
  summarize(data) {
    const d = data as { count: number; truncated: boolean };
    return `${d.count} 个条目${d.truncated ? '（已截断）' : ''}`;
  }
};

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const readFileArgs = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  maxBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024)
});

export const readFileTool: ToolDefinition<z.infer<typeof readFileArgs>> = {
  name: 'read_file',
  description:
    '读取工作区内的文本文件（UTF-8）。单次默认最多读取 256KB，可用 offset/maxBytes 分段读取大文件；二进制文件不会返回内容。',
  riskLevel: 'read',
  timeoutMs: 15_000,
  schema: readFileArgs,
  async execute(args, ctx) {
    const abs = resolveInsideWorkspace(ctx.workspace, args.path);
    const real = requireReadableInsideWorkspace(ctx.workspace, abs);
    const st = await fsp.stat(real);
    if (st.isDirectory()) {
      throw new PolicyViolationError('目标是目录，不能作为文件读取');
    }
    const start = Math.min(args.offset, st.size);
    const end = Math.min(st.size, start + args.maxBytes);
    const length = Math.max(0, end - start);
    const rel = toWorkspaceRel(ctx.workspace, real);
    if (length === 0) {
      return { path: rel, sizeBytes: st.size, truncated: false, content: '' };
    }
    const fh = await fsp.open(real, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      if (isBinaryContent(buf)) {
        return {
          path: rel,
          sizeBytes: st.size,
          binary: true,
          note: '检测到二进制内容，未返回文本',
          truncated: start > 0
        };
      }
      return {
        path: rel,
        sizeBytes: st.size,
        truncated: end < st.size,
        content: buf.toString('utf8')
      };
    } finally {
      await fh.close();
    }
  },
  summarize(data) {
    const d = data as { path: string; truncated: boolean; binary?: boolean };
    if (d.binary) return `${d.path}（二进制文件）`;
    return `${d.path}${d.truncated ? '（已截断）' : ''}`;
  }
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

const writeFileArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().default(true)
});

export const writeFileTool: ToolDefinition<z.infer<typeof writeFileArgs>> = {
  name: 'write_file',
  description:
    '在工作区内创建或整体重写文本文件（UTF-8）。覆盖已有文件前会自动备份原内容；拒绝覆盖二进制文件、符号链接与超过 2MB 的文件。',
  riskLevel: 'write',
  timeoutMs: 20_000,
  schema: writeFileArgs,
  async execute(args, ctx) {
    const abs = resolveInsideWorkspace(ctx.workspace, args.path);
    const rel = toWorkspaceRel(ctx.workspace, abs);
    const parent = path.dirname(abs);
    if (args.createDirs) {
      // 先校验最近的已存在祖先，再创建缺失目录（防符号链接逃逸）
      ensureParentInsideWorkspace(ctx.workspace, abs);
    } else if (!fs.existsSync(parent)) {
      throw new PolicyViolationError(`父目录不存在：${rel}`);
    }
    assertWritableInsideWorkspace(ctx.workspace, abs);

    let created = false;
    let backup: string | null = null;
    if (fs.existsSync(abs)) {
      const old = await fsp.readFile(abs);
      if (old.length > 2 * 1024 * 1024) {
        throw new PolicyViolationError('拒绝覆盖超过 2MB 的已有文件，请人工确认');
      }
      if (isBinaryContent(old)) {
        throw new PolicyViolationError('拒绝覆盖二进制文件');
      }
      backup = old.toString('utf8');
    } else {
      created = true;
    }

    await fsp.writeFile(abs, args.content, 'utf8');
    ctx.recordFileChange({ path: rel, kind: created ? 'create' : 'modify', backupContent: backup });
    return {
      path: rel,
      bytesWritten: Buffer.byteLength(args.content, 'utf8'),
      created,
      backupRecorded: backup !== null
    };
  },
  summarize(data) {
    const d = data as { path: string; created: boolean };
    return `${d.created ? '创建' : '更新'} ${d.path}`;
  }
};

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

const patchEdit = z.object({
  find: z.string().min(1),
  replace: z.string(),
  mode: z.enum(['first', 'all']).default('first'),
  expectedCount: z.number().int().min(1).optional()
});

const applyPatchArgs = z.object({
  path: z.string().min(1),
  edits: z.array(patchEdit).min(1).max(50)
});

class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

export const applyPatchTool: ToolDefinition<z.infer<typeof applyPatchArgs>> = {
  name: 'apply_patch',
  description:
    "对工作区内已有文本文件做局部修改（查找/替换式，可审查的最小变更）。edits 中每项包含 find（必须存在的原文）与 replace（替换内容）；mode='first' 只替换第一处，'all' 替换全部；可用 expectedCount 断言出现次数。所有编辑先在内存中校验并整体应用，任一编辑失败则文件保持不变。",
  riskLevel: 'write',
  timeoutMs: 20_000,
  schema: applyPatchArgs,
  async execute(args, ctx) {
    const abs = resolveInsideWorkspace(ctx.workspace, args.path);
    const real = requireReadableInsideWorkspace(ctx.workspace, abs);
    const st = await fsp.stat(real);
    if (st.isDirectory()) {
      throw new PolicyViolationError('目标是目录，不能应用补丁');
    }
    const raw = await fsp.readFile(real);
    if (st.size > 2 * 1024 * 1024) {
      throw new PolicyViolationError('拒绝修改超过 2MB 的文件，请人工确认');
    }
    if (isBinaryContent(raw)) {
      throw new PolicyViolationError('拒绝修改二进制文件');
    }
    const original = raw.toString('utf8');
    const rel = toWorkspaceRel(ctx.workspace, real);

    let current = original;
    const applied: Array<{ index: number; matched: number; mode: string }> = [];
    for (let i = 0; i < args.edits.length; i++) {
      const edit = args.edits[i];
      const count = countOccurrences(current, edit.find);
      if (edit.expectedCount !== undefined) {
        if (count !== edit.expectedCount) {
          throw new PatchError(
            `第 ${i + 1} 个编辑失败：find 在文件中出现 ${count} 次，与 expectedCount=${edit.expectedCount} 不符，文件未被修改`
          );
        }
      } else if (count === 0) {
        throw new PatchError(`第 ${i + 1} 个编辑失败：find 内容未在文件中找到，文件未被修改`);
      }
      // 使用函数替换/分段拼接，避免 replace 字符串中 $ 系列被解释
      current =
        edit.mode === 'all'
          ? current.split(edit.find).join(edit.replace)
          : current.replace(edit.find, () => edit.replace);
      applied.push({ index: i + 1, matched: count, mode: edit.mode });
    }

    const backup = original;
    await fsp.writeFile(real, current, 'utf8');
    ctx.recordFileChange({ path: rel, kind: 'modify', backupContent: backup });

    const { createTwoFilesPatch } = await import('diff');
    const diff = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, original, current, undefined, undefined, {
      context: 3
    });
    return { path: rel, appliedEdits: applied, diff, created: false };
  },
  summarize(data) {
    const d = data as { path: string; appliedEdits: unknown[] };
    return `修改 ${d.path}（${d.appliedEdits.length} 个编辑）`;
  }
};

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

const searchArgs = z.object({
  query: z.string().min(1),
  mode: z.enum(['content', 'filename']).default('content'),
  glob: z.string().optional(),
  isRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(500).default(50)
});

export const searchFilesTool: ToolDefinition<z.infer<typeof searchArgs>> = {
  name: 'search_files',
  description:
    '在工作区内搜索。mode=content 按文件内容逐行搜索（默认，跳过二进制与 node_modules/.git 等）；mode=filename 按文件名搜索。支持 isRegex 正则、caseSensitive 大小写、glob 过滤文件路径（如 **/*.ts）。',
  riskLevel: 'read',
  timeoutMs: 30_000,
  schema: searchArgs,
  async execute(args, ctx) {
    const globRe = args.glob ? globToRegExp(args.glob) : null;
    let lineMatcher: (line: string) => boolean;
    let nameMatcher: (name: string) => boolean;
    if (args.mode === 'content') {
      if (args.isRegex) {
        const re = new RegExp(args.query, args.caseSensitive ? '' : 'i');
        lineMatcher = (line) => re.test(line);
      } else {
        const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
        lineMatcher = (line) => (args.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
      }
      nameMatcher = () => true;
    } else {
      lineMatcher = () => false;
      if (args.isRegex || /[*?]/.test(args.query)) {
        const re = args.isRegex ? new RegExp(args.query, args.caseSensitive ? '' : 'i') : globToRegExp(args.query);
        nameMatcher = (name) => re.test(name);
      } else {
        const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
        nameMatcher = (name) => (args.caseSensitive ? name.includes(needle) : name.toLowerCase().includes(needle));
      }
    }

    const matches: Array<Record<string, unknown>> = [];
    let truncated = false;
    let filesScanned = 0;

    for await (const file of walkFiles(ctx.workspace)) {
      if (matches.length >= args.maxResults) {
        truncated = true;
        break;
      }
      if (globRe && !globRe.test(file.rel)) continue;

      if (args.mode === 'filename') {
        const base = file.rel.split('/').pop() ?? file.rel;
        if (nameMatcher(base)) {
          let size: number | undefined;
          try {
            size = (await fsp.stat(file.abs)).size;
          } catch {
            size = undefined;
          }
          matches.push({ path: file.rel, type: 'file', size });
        }
        continue;
      }

      let raw: Buffer;
      try {
        raw = await fsp.readFile(file.abs);
      } catch {
        continue;
      }
      if (raw.length > MAX_SEARCH_FILE_BYTES) continue;
      if (isBinaryContent(raw)) continue;
      filesScanned += 1;
      const lines = raw.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!lineMatcher(line)) continue;
        const trimmed = line.trim();
        matches.push({
          path: file.rel,
          line: i + 1,
          snippet: trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed
        });
        if (matches.length >= args.maxResults) {
          truncated = true;
          break;
        }
      }
    }

    return args.mode === 'content'
      ? { query: args.query, mode: 'content', filesScanned, matches, truncated }
      : { query: args.query, mode: 'filename', matches, truncated };
  },
  summarize(data) {
    const d = data as { matches: unknown[]; truncated: boolean };
    return `${d.matches.length} 处匹配${d.truncated ? '（已截断）' : ''}`;
  }
};

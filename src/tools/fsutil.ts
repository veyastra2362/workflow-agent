import fsp from 'node:fs/promises';
import path from 'node:path';

/** 递归遍历时跳过的目录名 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.gradle'
]);

export const DEFAULT_LIST_LIMIT = 1000;
export const MAX_WALK_FILES = 3000;
export const MAX_SEARCH_FILE_BYTES = 512 * 1024;

/** 前 8KB 内出现 NUL 视为二进制内容 */
export function isBinaryContent(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  return sample.includes(0);
}

/** 工作区绝对路径 → 以 / 分隔的相对路径展示形式 */
export function toWorkspaceRel(workspaceAbs: string, targetAbs: string): string {
  const rel = path.relative(path.resolve(workspaceAbs), targetAbs);
  return rel.split(path.sep).join('/') || '.';
}

export interface WalkedFile {
  abs: string;
  rel: string;
}

/** 深度优先遍历工作区内的普通文件；跳过忽略目录与一切符号链接；有文件数上限。 */
export async function* walkFiles(
  rootAbs: string,
  opts: { maxFiles?: number } = {}
): AsyncGenerator<WalkedFile> {
  const maxFiles = opts.maxFiles ?? MAX_WALK_FILES;
  const stack: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: path.resolve(rootAbs), rel: '', depth: 0 }
  ];
  let count = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let dirents;
    try {
      dirents = await fsp.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (count >= maxFiles) return;
      if (d.isSymbolicLink()) continue;
      const childRel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) continue;
        if (cur.depth >= 12) continue;
        stack.push({ abs: path.join(cur.abs, d.name), rel: childRel, depth: cur.depth + 1 });
      } else if (d.isFile()) {
        count += 1;
        yield { abs: path.join(cur.abs, d.name), rel: childRel };
      }
    }
  }
}

/** 极简 glob（仅支持 **、*、?），用于 search_files 的文件名过滤 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 或 `**`
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

import fs from 'node:fs';
import path from 'node:path';

/**
 * 工作区路径安全：所有文件工具的路径都必须经过本模块。
 * 防御目标：`..` 路径穿越、绝对路径越界、符号链接（含目录 junction）逃逸、
 * 通过写入尚不存在的父目录间接越界。
 */

export class PolicyViolationError extends Error {
  readonly code = 'POLICY_VIOLATION';
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

/** 将用户提供的相对（或绝对）路径解析到工作区内，越界即抛 PolicyViolationError。 */
export function resolveInsideWorkspace(root: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.trim() === '') {
    throw new PolicyViolationError('路径不能为空');
  }
  if (userPath.includes('\0')) {
    throw new PolicyViolationError('路径包含非法字符');
  }
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, userPath);
  if (!isInside(rootAbs, resolved)) {
    throw new PolicyViolationError(
      `路径越界："${userPath}" 解析到工作区之外`,
      resolved
    );
  }
  return resolved;
}

/** 已存在路径的真实路径必须仍在工作区内（拦截符号链接/junction 逃逸）。 */
export function requireRealInsideWorkspace(root: string, targetAbs: string): string {
  const rootReal = realPath(path.resolve(root));
  let targetReal: string;
  try {
    targetReal = realPath(targetAbs);
  } catch (err) {
    throw new PolicyViolationError(
      `无法解析路径真实位置：${targetAbs}`,
      String(err)
    );
  }
  if (!isInside(rootReal, targetReal)) {
    throw new PolicyViolationError(
      '路径经由符号链接指向工作区之外，已拒绝访问',
      `${targetAbs} -> ${targetReal}`
    );
  }
  return targetReal;
}

/**
 * 写入目标检查：
 * - 父目录必须存在且真实位置在工作区内；
 * - 目标本身若已存在，则不能是符号链接，也不能是目录。
 */
export function assertWritableInsideWorkspace(root: string, targetAbs: string): void {
  const parent = path.dirname(targetAbs);
  if (!fs.existsSync(parent)) {
    throw new PolicyViolationError(`父目录不存在：${parent}`);
  }
  requireRealInsideWorkspace(root, parent);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(targetAbs);
  } catch {
    return; // 目标不存在 —— 写入将创建新文件，父目录已确认安全
  }
  if (st.isSymbolicLink()) {
    throw new PolicyViolationError('拒绝写入：目标路径是符号链接');
  }
  if (st.isDirectory()) {
    throw new PolicyViolationError('拒绝写入：目标路径是目录');
  }
}

/** 读取目标检查：必须存在、不是符号链接、真实位置在工作区内。 */
export function requireReadableInsideWorkspace(root: string, targetAbs: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(targetAbs);
  } catch (err) {
    throw new PolicyViolationError(`文件不存在：${targetAbs}`, String(err));
  }
  if (st.isSymbolicLink()) {
    // 先拦下符号链接，再由真实路径检查给出具体指向
    throw new PolicyViolationError('拒绝读取：目标路径是符号链接');
  }
  return requireRealInsideWorkspace(root, targetAbs);
}

/**
 * createDirs 场景：从目标向上找到最近的已存在祖先目录，校验其真实路径在工作区内，
 * 再创建缺失的父目录 —— 防止经由符号链接祖先在区外创建目录。
 */
export function ensureParentInsideWorkspace(root: string, targetAbs: string): void {
  let dir = path.dirname(targetAbs);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  requireRealInsideWorkspace(root, dir);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
}

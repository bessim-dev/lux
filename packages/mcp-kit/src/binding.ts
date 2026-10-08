import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { z } from 'zod';

export type BindingProblem = 'PROJECT_DIR_REQUIRED' | 'PROJECT_DIR_INVALID' | 'NOT_A_REPOSITORY' | 'BINDING_INVALID' | 'BINDING_EXISTS';

export class BindingError extends Error {
  readonly problem: BindingProblem;
  constructor(problem: BindingProblem, message: string) {
    super(message);
    this.name = 'BindingError';
    this.problem = problem;
  }
}

export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export function deepFreeze<T>(value: T): DeepReadonly<T>;
export function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface ProjectDirSources {
  /** An explicit `--project-dir` style argument. Wins over the environment. */
  explicit?: string | undefined;
  /** A harness-supplied directory such as `CLAUDE_PROJECT_DIR`. */
  fromEnvironment?: string | undefined;
  /** Used only when neither of the above is set. Pass `process.cwd()` for interactive commands, nothing for servers. */
  fallback?: string | undefined;
}

/** Resolve and verify the directory a process is pinned to: absolute, existing, a directory; symlinks resolved. */
export async function resolveProjectDir(sources: ProjectDirSources): Promise<string> {
  const chosen = sources.explicit || sources.fromEnvironment || sources.fallback;
  if (!chosen) throw new BindingError('PROJECT_DIR_REQUIRED', 'No project directory. Pass --project-dir <path> or run inside a repository.');
  if (!isAbsolute(chosen)) throw new BindingError('PROJECT_DIR_INVALID', `Project directory must be an absolute path: ${chosen}`);
  try {
    const real = await realpath(chosen);
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    return real;
  } catch {
    throw new BindingError('PROJECT_DIR_INVALID', `Project directory does not exist or is not a directory: ${chosen}`);
  }
}

/** Walk upward for a `.git` entry (a directory, or a file in a linked worktree). Never goes past it. */
export async function findGitRoot(startDir: string): Promise<string> {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, '.git'));
      return dir;
    } catch {
      /* keep walking */
    }
    if (dirname(dir) === dir) throw new BindingError('NOT_A_REPOSITORY', `Not inside a Git repository: ${startDir}`);
  }
}

export interface BindingSpec<S extends z.ZodType> {
  fileName: string;
  schema: S;
  maxBytes?: number;
}

export interface FoundBinding<T> {
  path: string;
  root: string;
  binding: DeepReadonly<T>;
}

async function readBindingFile<S extends z.ZodType>(path: string, spec: BindingSpec<S>): Promise<DeepReadonly<z.output<S>>> {
  const fail = (reason: string): never => {
    throw new BindingError('BINDING_INVALID', `Invalid binding ${path}: ${reason}`);
  };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() =>
    fail('it is not a readable regular file (symlinks are refused)'),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('it is not a regular file');
    if (info.size > (spec.maxBytes ?? 8192)) fail('it is too large');
    let data: unknown;
    try {
      data = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    } catch {
      return fail('it is not valid JSON');
    }
    const parsed = spec.schema.safeParse(data);
    if (!parsed.success) return fail(parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
    return deepFreeze(parsed.data);
  } finally {
    await handle.close();
  }
}

/**
 * Find the closest binding file between `startDir` and the Git root. The closest file decides: if it is invalid
 * the call fails instead of falling back to an outer file. Returns null when none exists.
 */
export async function discoverBinding<S extends z.ZodType>(startDir: string, spec: BindingSpec<S>): Promise<FoundBinding<z.output<S>> | null> {
  const root = await findGitRoot(startDir);
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const path = join(dir, spec.fileName);
    const exists = await lstat(path).then(
      () => true,
      () => false,
    );
    if (exists) return { path, root, binding: await readBindingFile(path, spec) };
    if (dir === root) return null;
  }
}

/** Validate and write a non-secret binding atomically. Refuses to replace an existing file unless asked. */
export async function writeBinding<S extends z.ZodType>(
  path: string,
  value: z.input<S>,
  spec: BindingSpec<S>,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const parsed = spec.schema.parse(value);
  const temp = join(dirname(path), `.${spec.fileName}.${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  try {
    if (options.overwrite) await rename(temp, path);
    else await link(temp, path).then(() => unlink(temp));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new BindingError('BINDING_EXISTS', `Binding already exists: ${path}. Pass --force to replace it.`);
    throw error;
  }
}

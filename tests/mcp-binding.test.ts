import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  BindingError,
  PrivateFileError,
  ToolError,
  discoverBinding,
  findGitRoot,
  parseServiceOrigin,
  readPrivateFile,
  resolveProjectDir,
  writeBinding,
} from '@reotech/mcp-kit';
import { applyBinding, bindingSpec, findLuxBinding } from '../agent/binding';
import { loadCredential } from '../agent/credentials';
import { jwt, writeCredential } from './mcp-helpers';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lux-binding-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const binding = { version: 1, instance: 'https://lux.example.convex.cloud', workspace: 'ws_1', project: 'proj_1' } as const;
const put = async (path: string, value: unknown) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
};

describe('binding discovery', () => {
  test('walks upward from a subdirectory to the Git root and returns a frozen binding', async () => {
    await mkdir(join(dir, '.git'));
    await put(join(dir, '.lux.json'), binding);
    await mkdir(join(dir, 'a/b'), { recursive: true });
    const found = await findLuxBinding(join(dir, 'a/b'), false);
    expect(found?.binding).toEqual(binding);
    expect(found?.root).toBe(await findGitRoot(dir));
    expect(Object.isFrozen(found?.binding)).toBe(true);
  });

  test('treats a linked worktree (.git is a file) as its own root and ignores the parent checkout', async () => {
    await mkdir(join(dir, '.git'));
    await put(join(dir, '.lux.json'), binding);
    const worktree = join(dir, 'worktrees/feature');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: /somewhere/.git/worktrees/feature\n');
    expect(await findLuxBinding(worktree, false)).toBeNull();
    await put(join(worktree, '.lux.json'), { ...binding, project: 'proj_2' });
    expect((await findLuxBinding(worktree, false))?.binding.project).toBe('proj_2');
  });

  test('the closest file decides, and an invalid closest file fails instead of falling back', async () => {
    await mkdir(join(dir, '.git'));
    await put(join(dir, '.lux.json'), binding);
    await put(join(dir, 'pkg/.lux.json'), { ...binding, project: 'proj_pkg' });
    expect((await findLuxBinding(join(dir, 'pkg'), false))?.binding.project).toBe('proj_pkg');
    for (const bad of [
      '{not json',
      { ...binding, version: 2 },
      { ...binding, extra: true },
      { ...binding, workspace: '../x' },
      { ...binding, instance: 'http://lux.example.com' },
      { ...binding, instance: 'https://u:p@lux.example.com' },
      { ...binding, instance: 'https://lux.example.com/path' },
    ]) {
      await put(join(dir, 'pkg/.lux.json'), bad);
      await expect(findLuxBinding(join(dir, 'pkg'), false)).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    }
  });

  test('never looks above the Git root and refuses directories outside a repository', async () => {
    await put(join(dir, '.lux.json'), binding);
    await mkdir(join(dir, 'repo/.git'), { recursive: true });
    expect(await findLuxBinding(join(dir, 'repo'), false)).toBeNull();
    await mkdir(join(dir, 'plain'));
    await expect(discoverBinding(join(dir, 'plain'), bindingSpec(false))).rejects.toBeInstanceOf(BindingError);
  });

  test('refuses a symlinked binding file', async () => {
    await mkdir(join(dir, '.git'));
    await put(join(dir, 'elsewhere.json'), binding);
    await symlink(join(dir, 'elsewhere.json'), join(dir, '.lux.json'));
    await expect(findLuxBinding(dir, false)).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  });

  test('accepts loopback http only when the local-test choice is explicit', async () => {
    await mkdir(join(dir, '.git'));
    await put(join(dir, '.lux.json'), { ...binding, instance: 'http://127.0.0.1:3210' });
    await expect(findLuxBinding(dir, false)).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect((await findLuxBinding(dir, true))?.binding.instance).toBe('http://127.0.0.1:3210');
  });

  test('writes atomically, refuses to replace without force, and validates before writing', async () => {
    const spec = bindingSpec(false);
    const path = join(dir, '.lux.json');
    await writeBinding(path, binding, spec);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(binding);
    await expect(writeBinding(path, { ...binding, project: 'other' }, spec)).rejects.toMatchObject({ problem: 'BINDING_EXISTS' });
    await writeBinding(path, { ...binding, project: 'other' }, spec, { overwrite: true });
    expect(JSON.parse(await readFile(path, 'utf8')).project).toBe('other');
    await expect(writeBinding(join(dir, 'x.json'), { ...binding, instance: 'http://evil.example' }, spec)).rejects.toThrow();
  });
});

describe('project directory and pinned scope', () => {
  test('requires an absolute existing directory; explicit beats the environment; no silent fallback', async () => {
    await expect(resolveProjectDir({})).rejects.toMatchObject({ problem: 'PROJECT_DIR_REQUIRED' });
    await expect(resolveProjectDir({ explicit: 'relative/dir' })).rejects.toMatchObject({ problem: 'PROJECT_DIR_INVALID' });
    await expect(resolveProjectDir({ explicit: join(dir, 'missing') })).rejects.toMatchObject({ problem: 'PROJECT_DIR_INVALID' });
    await writeFile(join(dir, 'file'), '');
    await expect(resolveProjectDir({ explicit: join(dir, 'file') })).rejects.toMatchObject({ problem: 'PROJECT_DIR_INVALID' });
    await mkdir(join(dir, 'env'));
    expect(await resolveProjectDir({ explicit: dir, fromEnvironment: join(dir, 'env') })).toBe(await resolveProjectDir({ explicit: dir }));
    expect((await resolveProjectDir({ fromEnvironment: join(dir, 'env') })).endsWith('env')).toBe(true);
  });

  test('applyBinding fills only from the pinned binding and never mixes workspaces', () => {
    const pinned = { version: 1 as const, instance: 'https://lux.example.convex.cloud', workspace: 'ws_1', project: 'proj_1' };
    expect(applyBinding({}, pinned)).toEqual({ workspace: 'ws_1', project: 'proj_1' });
    expect(applyBinding({ project: 'p2' }, pinned)).toEqual({ workspace: 'ws_1', project: 'p2' });
    expect(applyBinding({ workspace: 'ws_2' }, pinned)).toEqual({ workspace: 'ws_2', project: undefined });
    expect(applyBinding({}, null)).toEqual({ workspace: undefined, project: undefined });
  });
});

describe('parseServiceOrigin', () => {
  test.each([
    'http://example.com',
    'https://u:p@example.com',
    'https://example.com?x=1',
    'https://example.com#x',
    'https://example.com/path',
    'http://localhost',
    'http://10.0.0.1',
    'ftp://example.com',
    'nonsense',
  ])('rejects %s', raw => {
    expect(() => parseServiceOrigin(raw, { allowLoopbackHttp: true })).toThrow();
  });
  test('accepts https and, only when explicit, loopback http', () => {
    expect(parseServiceOrigin('https://Example.COM')).toBe('https://example.com');
    expect(() => parseServiceOrigin('http://127.0.0.1:3000')).toThrow();
    expect(parseServiceOrigin('http://127.0.0.1:3000', { allowLoopbackHttp: true })).toBe('http://127.0.0.1:3000');
    expect(parseServiceOrigin('http://[::1]:3000', { allowLoopbackHttp: true })).toBe('http://[::1]:3000');
  });
});

describe('private files and credentials', () => {
  test('rejects credential and binding FIFOs without blocking the process', async () => {
    const exec = promisify(execFile);
    await mkdir(join(dir, '.git'));
    const credential = join(dir, 'credential-fifo');
    await exec('mkfifo', [credential, join(dir, '.lux.json')]);
    // A subprocess timeout also bounds this regression if open() blocks a libuv worker.
    const probe = `
      import { readPrivateFile, discoverBinding } from '@reotech/mcp-kit';
      import { z } from 'zod';
      const results = [];
      for (const read of [
        () => readPrivateFile(process.argv[1]),
        () => discoverBinding(process.argv[2], { fileName: '.lux.json', schema: z.object({}) }),
      ]) {
        try { await read(); results.push('accepted'); }
        catch (error) { results.push(error.problem); }
      }
      console.log(JSON.stringify(results));
    `;
    const result = await exec(process.execPath, ['--input-type=module', '--eval', probe, credential, dir], { timeout: 1000 });
    expect(JSON.parse(result.stdout)).toEqual(['NOT_REGULAR', 'BINDING_INVALID']);
  });

  test('requires a regular, current-user, owner-only file', async () => {
    const path = join(dir, 'secret');
    await writeFile(path, 'value', { mode: 0o600 });
    expect(await readPrivateFile(path)).toBe('value');
    await chmod(path, 0o640);
    await expect(readPrivateFile(path)).rejects.toMatchObject({ problem: 'TOO_PERMISSIVE' });
    await chmod(path, 0o600);
    await expect(readPrivateFile(path, { uid: (process.getuid?.() ?? 0) + 1 })).rejects.toMatchObject({ problem: 'WRONG_OWNER' });
    await expect(readPrivateFile(path, { maxBytes: 2 })).rejects.toMatchObject({ problem: 'TOO_LARGE' });
    await expect(readPrivateFile(join(dir, 'nope'))).rejects.toMatchObject({ problem: 'MISSING' });
    await expect(readPrivateFile(dir)).rejects.toBeInstanceOf(PrivateFileError);
    await symlink(path, join(dir, 'link'));
    await expect(readPrivateFile(join(dir, 'link'))).rejects.toMatchObject({ problem: 'SYMLINK' });
    await expect(readPrivateFile(path, { platform: 'win32' })).rejects.toMatchObject({ problem: 'UNSUPPORTED_PLATFORM' });
  });

  const options = { allowLoopbackHttp: false };
  const instance = 'https://lux.example.convex.cloud';

  test('loads a valid credential on every call so rotation takes effect', async () => {
    const path = await writeCredential(dir, { version: 1, instance, token: jwt({ sub: 'one' }) });
    const first = await loadCredential(path, options);
    await writeCredential(dir, { version: 1, instance, token: jwt({ sub: 'two' }) });
    const second = await loadCredential(path, options);
    expect(first.instance).toBe(instance);
    expect(second.token).not.toBe(first.token);
  });

  test.each([
    ['unset path', undefined, 'AUTH_REQUIRED'],
    ['missing file', '/definitely/not/here.json', 'AUTH_REQUIRED'],
  ])('reports %s as actionable', async (_n, path, code) => {
    await expect(loadCredential(path, options)).rejects.toMatchObject({ code });
  });

  test('rejects malformed, expired, wrong-audience, wrong-instance and unsafe credentials without echoing the token', async () => {
    const token = jwt({ sub: 'u' });
    const cases: [string, Record<string, unknown> | string, string][] = [
      ['not json', 'not json {{', 'AUTH_INVALID'],
      ['unknown field', { version: 1, instance, token, extra: 1 }, 'AUTH_INVALID'],
      ['bad version', { version: 2, instance, token }, 'AUTH_INVALID'],
      ['not a jwt', { version: 1, instance, token: 'x'.repeat(40) }, 'AUTH_INVALID'],
      ['expired', { version: 1, instance, token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }) }, 'AUTH_EXPIRED'],
      ['oauth audience', { version: 1, instance, token: jwt({ aud: 'https://mcp.example.test' }) }, 'AUTH_INVALID'],
      ['insecure instance', { version: 1, instance: 'http://lux.example.com', token }, 'INSTANCE_INVALID'],
      ['instance with path', { version: 1, instance: `${instance}/steal`, token }, 'INSTANCE_INVALID'],
    ];
    for (const [name, content, code] of cases) {
      const path = await writeCredential(dir, content);
      const error = await loadCredential(path, options).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(ToolError);
      expect(error, name).toMatchObject({ code });
      expect(error instanceof Error ? error.message : '', name).not.toContain(token);
    }
    const loose = await writeCredential(dir, { version: 1, instance, token }, 0o644);
    await expect(loadCredential(loose, options)).rejects.toMatchObject({ code: 'AUTH_FILE_UNSAFE' });
    const real = await writeCredential(dir, { version: 1, instance, token });
    await symlink(real, join(dir, 'cred-link.json'));
    await expect(loadCredential(join(dir, 'cred-link.json'), options)).rejects.toMatchObject({ code: 'AUTH_FILE_UNSAFE' });
  });
});

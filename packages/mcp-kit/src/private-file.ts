import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';

export type PrivateFileProblem = 'MISSING' | 'SYMLINK' | 'NOT_REGULAR' | 'WRONG_OWNER' | 'TOO_PERMISSIVE' | 'TOO_LARGE' | 'UNSUPPORTED_PLATFORM' | 'UNREADABLE';

export class PrivateFileError extends Error {
  readonly problem: PrivateFileProblem;
  constructor(problem: PrivateFileProblem, message: string) {
    super(message);
    this.name = 'PrivateFileError';
    this.problem = problem;
  }
}

export interface PrivateFileOptions {
  maxBytes?: number;
  /** Test seams. */
  platform?: NodeJS.Platform;
  uid?: number | undefined;
}

/**
 * Read a small file that holds a secret. The file must be a regular file (not a symlink) owned by the current
 * user and not accessible to group or others. The checks run on the opened descriptor, so the file cannot be
 * swapped between the check and the read. Messages name the path, never the contents.
 */
export async function readPrivateFile(path: string, options: PrivateFileOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new PrivateFileError('UNSUPPORTED_PLATFORM', 'Private credential files are not supported on Windows in this release.');
  }
  const maxBytes = options.maxBytes ?? 16 * 1024;
  const uid = 'uid' in options ? options.uid : process.getuid?.();
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') throw new PrivateFileError('MISSING', `File not found: ${path}`);
    if (code === 'ELOOP') throw new PrivateFileError('SYMLINK', `Refusing to follow a symlink: ${path}`);
    throw new PrivateFileError('UNREADABLE', `Cannot open ${path}${typeof code === 'string' ? ` (${code})` : ''}.`);
  }
  try {
    const stats: Stats = await handle.stat();
    if (!stats.isFile()) throw new PrivateFileError('NOT_REGULAR', `Not a regular file: ${path}`);
    if (uid !== undefined && stats.uid !== uid) throw new PrivateFileError('WRONG_OWNER', `File is not owned by the current user: ${path}`);
    if ((stats.mode & 0o077) !== 0) {
      throw new PrivateFileError('TOO_PERMISSIVE', `File is accessible to other users (mode ${(stats.mode & 0o777).toString(8)}). Run: chmod 600 ${path}`);
    }
    if (stats.size > maxBytes) throw new PrivateFileError('TOO_LARGE', `File is larger than ${maxBytes} bytes: ${path}`);
    const text = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(text) > maxBytes) throw new PrivateFileError('TOO_LARGE', `File is larger than ${maxBytes} bytes: ${path}`);
    return text;
  } finally {
    await handle.close();
  }
}

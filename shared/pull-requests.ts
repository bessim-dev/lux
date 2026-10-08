import { z } from 'zod';

export const MAX_PULL_REQUEST_LINKS = 50;
const urlInput = z.string().trim().min(1).max(2048);

export interface PullRequestReference {
  provider: 'github' | 'forgejo';
  host: string;
  owner: string;
  repository: string;
  number: number;
  url: string;
}
export interface PullRequestLink extends PullRequestReference {
  id: string;
  createdAt: number;
}
export interface PullRequestLinksState {
  task: string | null;
  links: PullRequestLink[];
  canEdit: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
}

// This classifies URL references only. It does not verify the provider or fetch private metadata.
export function parsePullRequestUrl(input: string): PullRequestReference {
  const raw = urlInput.parse(input);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS pull request URL without credentials.');
  const github = url.hostname === 'github.com';
  const match = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/(pull|pulls)\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..')
    throw new Error('Use a GitHub /owner/repo/pull/number or Forgejo /owner/repo/pulls/number URL.');
  if ((github && (match[3] !== 'pull' || url.port)) || (!github && match[3] !== 'pulls')) throw new Error('Use a GitHub or Forgejo pull request URL.');
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) throw new Error('The pull request number is too large.');
  // Both providers resolve owner/repository names without case distinctions.
  const owner = match[1].toLowerCase();
  const repository = match[2].toLowerCase();
  const provider = github ? 'github' : 'forgejo';
  return { provider, host: url.host, owner, repository, number, url: `${url.origin}/${owner}/${repository}/${github ? 'pull' : 'pulls'}/${number}` };
}

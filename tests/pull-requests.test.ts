import { describe, expect, test } from 'vitest';
import { parsePullRequestUrl } from '../shared/pull-requests';

describe('parsePullRequestUrl', () => {
  test('normalizes HTTPS GitHub pull URLs by case and removes query/hash/trailing slash', () => {
    expect(parsePullRequestUrl(' https://GitHub.com/Acme/Repo/pull/42/?tab=files#discussion ')).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
    });
  });

  test('accepts Forgejo pulls URLs, including a host port', () => {
    expect(parsePullRequestUrl('https://Git.Example.test:3443/Acme/Repo/pulls/9/?view=commits#x')).toMatchObject({
      provider: 'forgejo',
      host: 'git.example.test:3443',
      owner: 'acme',
      repository: 'repo',
      number: 9,
      url: 'https://git.example.test:3443/acme/repo/pulls/9',
    });
  });

  test.each([
    'http://github.com/acme/repo/pull/1',
    'https://user:secret@github.com/acme/repo/pull/1',
    'https://github.com/acme/repo/pull/0',
    'https://github.com/acme/repo/pull/-1',
    'https://github.com/acme/repo/pull/1.5',
    'https://github.com/acme/repo/pull/9007199254740992',
    'https://github.com/acme/repo/pulls/1',
    'https://git.example.test/acme/repo/pull/1',
    'https://github.com/acme/repo/pull/1/extra',
    'https://github.com/../repo/pull/1',
  ])('rejects invalid URL %s', url => {
    expect(() => parsePullRequestUrl(url)).toThrow();
  });

  test('rejects a non-default GitHub port and provider-specific path spellings', () => {
    expect(() => parsePullRequestUrl('https://github.com:444/acme/repo/pull/1')).toThrow();
    expect(() => parsePullRequestUrl('https://git.example.test/acme/repo/pull/1')).toThrow();
    expect(() => parsePullRequestUrl('https://github.com/acme/repo/pulls/1')).toThrow();
  });
});

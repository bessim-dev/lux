import { describe, expect, test } from 'vitest';
import { mapPlane, planeExportSchema } from '../scripts/plane';
import { mapGithubIssue } from '../scripts/github';
const source = () =>
  planeExportSchema.parse({
    version: 1,
    source: 'https://plane.reotech.org',
    workspace: 'reotech_internal',
    exportedAt: '2026-10-09T00:00:00Z',
    members: [{ id: 'u1', email: 'owner@example.com' }],
    projects: [
      {
        project: { id: 'p1', name: 'Project', identifier: 'LUX', network: 0 },
        states: [{ id: 's1', name: 'Todo', group: 'unstarted' }],
        labels: [{ id: 'label', name: 'bug' }],
        members: [{ id: 'u1' }],
        cycles: [{ id: 'cycle1' }],
        modules: [],
        tasks: [
          {
            task: {
              id: 't1',
              name: 'Imported issue',
              sequence_id: 11,
              state: 's1',
              priority: 'high',
              assignees: ['u1'],
              labels: ['label'],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-02-01T00:00:00Z',
              description_html: '<p>Hello <strong>team</strong></p>',
            },
            comments: [{ id: 'c1', actor: 'u1', created_at: '2026-03-01T00:00:00Z', comment_html: '<p>Comment</p>' }],
            attachments: [],
            links: [{ url: 'https://github.com/org/repo/pull/2' }],
          },
        ],
      },
    ],
  });
describe('source mapping', () => {
  test('preserves native keys, private access, authors, source times and valid PR links; reports unsupported concepts', () => {
    const result = mapPlane(source(), 'owner', new Map([['u1', 'owner']]));
    expect(result.records.map(r => r.entity.kind)).toEqual(['projects', 'tasks', 'comments']);
    expect(result.records[0]?.entity.value).toMatchObject({ access: 'private', members: ['owner'] });
    expect(result.records[1]?.entity.value).toMatchObject({
      key: 'LUX-11',
      assignee: 'owner',
      labels: ['bug'],
      desc: 'Hello team',
      created: Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(result.records[2]?.entity.value).toMatchObject({ by: 'owner', task: 'plane_t_t1', text: 'Comment' });
    expect(result.pullRequestLinks).toEqual([{ task: 'plane_t_t1', url: 'https://github.com/org/repo/pull/2' }]);
    expect(result.warnings).toHaveLength(1);
    expect(mapPlane(source(), 'owner', new Map([['u1', 'owner']]))).toEqual(result);
  });
  test('blocks unmapped states, labels, assignees, and comment authors before any destination writes', () => {
    expect(() => mapPlane(source(), 'owner', new Map())).toThrow('assignee');
    const missing = source();
    missing.projects[0]!.states = [];
    expect(() => mapPlane(missing, 'owner', new Map([['u1', 'owner']]))).toThrow('state');
    const labels = source();
    labels.projects[0]!.labels = [];
    expect(() => mapPlane(labels, 'owner', new Map([['u1', 'owner']]))).toThrow('label');
    const author = source();
    author.projects[0]!.tasks[0]!.comments[0]!.actor = 'unknown';
    expect(() => mapPlane(author, 'owner', new Map([['u1', 'owner']]))).toThrow('author');
  });
  test('maps closed GitHub issues and stable immutable IDs without treating PRs as issues', () => {
    const mapped = mapGithubIssue(
      {
        id: 123,
        number: 9,
        title: 'Closed issue',
        body: 'Details',
        state: 'closed',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/issues/9',
        labels: [{ name: 'bug' }],
      },
      42,
      'project',
      'LUX',
      9,
    );
    expect(mapped.entity.value).toMatchObject({ id: 'github_t_42_123', key: 'LUX-9', status: 'done', labels: ['bug'] });
    expect(mapped.sourceId).toBe('123');
  });
});

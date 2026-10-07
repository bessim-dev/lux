/* ---------- ACTIVITY ---------- */
import { dayBucket, esc } from '../core/utils.js';
import { D, S, canSee, proj } from '../core/store.js';
import { empty } from '../ui/helpers.js';
import { actHtml } from '../components/task-list.js';

export function pageActivity() {
  const f = S.ui.actFilter || 'all';
  const who = S.ui.actWho || 'all';
  let as = D().activity.filter(a => !a.project || canSee(proj(a.project)));
  if (f !== 'all')
    as = as.filter(a =>
      f === 'comments'
        ? a.verb.includes('comment')
        : f === 'status'
          ? /moved|completed|reopened/.test(a.verb)
          : f === 'projects'
            ? a.verb.includes('project')
            : true,
    );
  if (who !== 'all') as = as.filter(a => a.by === who);
  const b = {};
  as.forEach(a => (b[dayBucket(a.at)] ||= []).push(a));
  return `<div class="page" style="max-width:820px">
    <div class="ph"><div><h1>Activity</h1><p>Everything that's changed across the workspace.</p></div></div>
    <div class="row" style="gap:8px;margin-bottom:6px;flex-wrap:wrap"><div class="seg">${[
      ['all', 'All'],
      ['status', 'Status changes'],
      ['comments', 'Comments'],
      ['projects', 'Projects'],
    ]
      .map(([k, n]) => `<button class="${f === k ? 'on' : ''}" data-a="set" data-k="actFilter" data-v="${k}">${n}</button>`)
      .join('')}</div>
    <select class="select" style="height:26px;width:auto;font-size:12px" data-in="actWho" aria-label="Filter by person"><option value="all">Everyone</option>${D()
      .members.map(m => `<option value="${m.id}" ${who === m.id ? 'selected' : ''}>${esc(m.name)}</option>`)
      .join('')}</select></div>
    ${
      as.length
        ? Object.entries(b)
            .map(([k, list]) => `<div class="day-h">${k}</div><div class="feed lined">${list.map(a => actHtml(a, { proj: true })).join('')}</div>`)
            .join('')
        : empty('activity', 'No activity yet', 'Changes to tasks and projects will appear here.')
    }
  </div>`;
}

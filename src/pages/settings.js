/* =====================================================================
   SETTINGS · AUTH · ONBOARDING · DESIGN SYSTEM · SYSTEM STATES
   ===================================================================== */
import { dOff, esc, fmtDate } from '../core/utils.js';
import { ic, wsLogo } from '../core/icons.js';
import { D, S, me } from '../core/store.js';
import { av, pIcon } from '../ui/helpers.js';
import { teamsGrid } from './members.js';
import { page404 } from './errors.js';
import { SHORTCUTS } from '../overlays/modals.js';

export const SET_NAV = [
  [
    'General',
    [
      ['workspace', 'Workspace', 'building-2'],
      ['appearance', 'Appearance', 'palette'],
      ['language', 'Language', 'languages'],
      ['datetime', 'Date & time', 'clock'],
    ],
  ],
  [
    'Workspace',
    [
      ['members', 'Members', 'users'],
      ['teams', 'Teams', 'users-round'],
      ['projects', 'Projects', 'folder-kanban'],
      ['permissions', 'Permissions', 'shield'],
    ],
  ],
  [
    'Notifications',
    [
      ['notif-email', 'Email', 'mail'],
      ['notif-push', 'Push', 'smartphone'],
      ['notif-mentions', 'Mentions', 'at-sign'],
      ['notif-assign', 'Task assignments', 'user-check'],
      ['notif-comments', 'Comments', 'message-square'],
    ],
  ],
  [
    'Personal',
    [
      ['profile', 'Profile', 'user'],
      ['preferences', 'Preferences', 'sliders-horizontal'],
      ['shortcuts', 'Keyboard shortcuts', 'keyboard'],
    ],
  ],
  [
    'Security',
    [
      ['password', 'Password', 'key-round'],
      ['sessions', 'Sessions', 'monitor-smartphone'],
      ['2fa', 'Two-factor authentication', 'shield-check'],
    ],
  ],
  [
    'Workspace access',
    [
      ['plan', 'Access overview', 'building-2'],
      ['payment', 'Account', 'user-round'],
      ['invoices', 'Billing status', 'receipt'],
    ],
  ],
];
export function srow(t, d, ctl) {
  return `<div class="srow"><div><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}</div><div class="row">${ctl}</div></div>`;
}
export const tog = (k, on, src = 'pref') =>
  `<input type="checkbox" class="toggle" data-in="${src}Toggle" data-k="${k}" ${on ? 'checked' : ''} aria-label="${k}">`;
export const sel = (k, opts, v) =>
  `<select class="select" style="width:auto;min-width:180px" data-in="prefSel" data-k="${k}" aria-label="${k}">${opts
    .map(o => {
      const [val, n] = Array.isArray(o) ? o : [o, o];
      return `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${n}</option>`;
    })
    .join('')}</select>`;

const deliveryStatus = message => `<div class="alert info" style="margin:18px 0">${ic('info', 15)}<span>${message}</span></div>`;

const inAppNotificationLink = `<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" data-a="go" data-r="settings" data-sec="notif-mentions">Mention preferences</button><button class="btn btn-secondary btn-sm" data-a="go" data-r="settings" data-sec="notif-assign">Assignment preferences</button><button class="btn btn-secondary btn-sm" data-a="go" data-r="settings" data-sec="notif-comments">Comment preferences</button></div>`;

const boundedDeliveryCount = value => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(99999, Math.max(0, Math.floor(count))) : 0;
};

function notificationServiceCard() {
  const service = S.ui.notificationDelivery;
  const current = me();
  const admin = current?.role === 'Owner' || current?.role === 'Admin';
  const configured = service?.configured === true;
  const pending = boundedDeliveryCount(service?.pending);
  const failed = boundedDeliveryCount(service?.failed);
  const sent = boundedDeliveryCount(service?.sent);
  const retryable = configured && admin && pending + failed > 0;
  const counts = configured
    ? `<div class="row" style="gap:16px;flex-wrap:wrap;margin-top:12px;font-size:12px"><span><b class="num">${sent}</b> sent</span><span><b class="num">${pending}</b> pending</span><span><b class="num">${failed}</b> failed</span></div>${service?.hasMore ? '<p class="hint" style="margin-top:8px">More deliveries exist. Counts are capped at 500 per state.</p>' : ''}`
    : '';
  return `<div class="panel" style="padding:16px;margin:18px 0"><div class="row" style="align-items:flex-start;gap:10px"><div class="grow"><div class="eyebrow">Notification service</div><div style="font-weight:600;margin-top:4px">Lux inbox <span class="badge green" style="margin-left:4px">Always active</span></div><div class="muted" style="font-size:12.5px;margin-top:4px">In-app read status belongs to Lux. ${configured ? 'The shared Reotech notification inbox is configured; external delivery can still be delayed or fail.' : 'Lux keeps events in its own inbox while the shared Reotech notification service awaits setup.'}</div></div><span class="badge ${configured ? 'green' : 'amber'}">${configured ? 'Configured' : 'Waiting for setup'}</span></div>${counts}${retryable ? `<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" data-a="retryNotificationDelivery">${ic('refresh-cw', 13)}Retry queued events</button></div>` : ''}</div>`;
}

function permissionSettings() {
  const current = me();
  const role = current?.role || 'Member';
  const admin = role === 'Owner' || role === 'Admin';
  const roleDescription = {
    Owner: 'You own this workspace and can manage workspace settings, members, teams, and project access.',
    Admin: 'You can manage workspace settings, members, teams, and project access.',
    Member: 'You can work in projects you can access. Project leads and admins manage project access.',
    Guest: 'You can open projects you are invited to. Commenting and editing follow each project’s access setting.',
  }[role];
  return `<h1>Workspace permissions</h1><p class="lead">These permissions are enforced by the workspace server and project access rules.</p>
    <div class="panel" style="padding:18px;margin-top:18px"><div class="eyebrow">Your role</div><div class="row" style="gap:8px;margin-top:6px"><span class="badge accent">${esc(role)}</span><span class="muted">${esc(roleDescription)}</span></div></div>
    <div class="sblock"><h2>Enforced access rules</h2><div class="col" style="gap:12px;margin-top:12px">
      ${permissionRule('Workspace settings', admin ? 'Owner and Admin' : 'Owner and Admin only')}
      ${permissionRule('Members and teams', admin ? 'Owner and Admin' : 'Owner and Admin only')}
      ${permissionRule('Create a project', 'A non-guest member must be the project lead')}
      ${permissionRule('Change project access', 'Workspace Admin, project lead, or project Full access')}
      ${permissionRule('Delete a project', 'Workspace Admin or project lead')}
      ${permissionRule('Edit tasks and add comments', 'Requires project access; Guests need an explicit project permission')}
    </div></div>
    <p class="hint">Public share links, billing limits, and workspace-wide policy toggles are not stored or enforced by the current backend.</p>
    <div style="margin-top:14px"><button class="btn btn-secondary" data-a="go" data-r="members">Open member directory</button></div>`;
}

const permissionRule = (name, rule) =>
  `<div class="srow" style="padding:0"><div><div class="t">${esc(name)}</div><div class="d">${esc(rule)}</div></div><span class="badge green">Enforced</span></div>`;

function teamAccessBody(sec) {
  const d = D();
  const current = me();
  const role = current?.role || 'Member';
  if (sec === 'plan')
    return `<h1>Workspace access</h1><p class="lead">Access is provided by workspace membership. Lux does not currently change plans or enforce usage tiers.</p>
      <div class="panel" style="padding:18px;margin-top:18px"><div class="eyebrow">Current workspace</div><div style="font-size:20px;font-weight:600;margin-top:4px">${esc(d.ws.name)}</div><div class="muted" style="font-size:13px;margin-top:4px">${d.members.length} member${d.members.length === 1 ? '' : 's'} · Your role: <b>${esc(role)}</b></div></div>
      <div class="row" style="margin-top:14px;gap:8px"><button class="btn btn-secondary" data-a="go" data-r="members">Manage members</button><button class="btn btn-secondary" data-a="go" data-r="settings" data-sec="permissions">View permissions</button></div>`;
  if (sec === 'payment')
    return `<h1>Account</h1><p class="lead">Sign-in, password, and multi-factor authentication are managed by Clerk.</p>
      ${deliveryStatus('Workspace billing is not connected. Lux does not collect card details or create charges.')}
      <button class="btn btn-primary" data-a="manageAccount">Manage Clerk account</button>`;
  return `<h1>Billing status</h1><p class="lead">Billing and invoices are not connected to this workspace.</p>
    ${deliveryStatus('No payment processor is configured, so Lux has no invoices or payment history to display.')}
    <p class="hint">When billing is connected, this section can show processor supplied records without inventing plan, card, or invoice data.</p>`;
}
export function pageSettings() {
  const sec = S.ui.params.sec || S.ui.settings || 'appearance';
  const title = SET_NAV.flatMap(g => g[1]).find(x => x[0] === sec) || ['appearance', 'Appearance'];
  return `<div class="set">
    <nav class="set-nav" aria-label="Settings">${SET_NAV.map(([g, items]) => `<div class="gh">${g}</div>${items.map(([k, n, i]) => `<button class="sitem ${sec === k ? 'on' : ''}" data-a="go" data-r="settings" data-sec="${k}">${ic(i, 15)}<span>${n}</span></button>`).join('')}`).join('')}</nav>
    <div class="set-body" data-keep="set:${sec}"><div class="set-in">${settingsBody(sec, title[1])}</div></div>
  </div>`;
}
export function settingsBody(sec, title) {
  if (S.ui.teamReady && ['password', 'sessions', '2fa'].includes(sec))
    return `<h1>Account security</h1><p class="lead">Manage your sign-in methods and account security.</p><button class="btn btn-primary" data-a="manageAccount">Manage account</button>`;
  if (S.ui.teamReady && ['plan', 'payment', 'invoices'].includes(sec)) return teamAccessBody(sec);
  const P = S.prefs;
  const d = D();
  const np = d.notifPrefs || {};
  const H = lead => `<h1>${title}</h1><p class="lead">${lead}</p>`;
  switch (sec) {
    case 'workspace':
      return (
        H('Your workspace name, address, and identity.') +
        `
      <form data-submit="saveWorkspace">
      <div class="sblock" style="margin-top:0"><div class="row" style="gap:14px;margin-bottom:18px">${wsLogo(d.ws, 52)}<div><div class="label" style="margin-bottom:6px">Workspace icon</div><div class="swatches">${['#2F2E2A', '#5A67D8', '#3B82C4', '#23918A', '#C54B78', '#C48A1E'].map(c => `<button type="button" class="sw ${d.ws.c === c ? 'on' : ''}" style="--c:${c};width:22px;height:22px" data-a="wsColor" data-v="${c}" aria-label="Color ${c}"></button>`).join('')}</div></div></div>
      <div class="col" style="gap:14px;max-width:440px"><div class="field"><label class="label" for="ws-name">Workspace name</label><input class="input" id="ws-name" value="${esc(d.ws.name)}"></div>
      <div class="field"><label class="label" for="ws-url">Workspace URL</label><div class="row" style="gap:0"><span class="input" style="width:auto;background:var(--surface-2);border-right:0;border-radius:6px 0 0 6px;display:flex;align-items:center;color:var(--text-2)">${esc(location.host)}/</span><input class="input" id="ws-url" value="${esc(d.ws.url)}" style="border-radius:0 6px 6px 0"></div><span class="hint">Changing the URL will break existing links.</span></div>
      <div><button class="btn btn-primary" data-a="saveWorkspace" id="ws-save">Save changes</button></div></div></div></form>
      <div class="sblock"><h2 style="color:var(--red)">Danger zone</h2>${srow('Delete workspace', 'Permanently delete this workspace, its projects, tasks, and files. This cannot be undone.', `<button class="btn btn-danger-ghost" style="border:1px solid color-mix(in srgb,var(--red) 35%,transparent)" data-a="delWorkspace">Delete workspace</button>`)}</div>`
      );
    case 'appearance':
      return (
        H('Customize how Lux looks on this device.') +
        `
      <div class="sblock" style="margin-top:0"><h2>Theme</h2><div class="themecards" style="margin-top:12px" role="radiogroup" aria-label="Theme">${[
        ['light', 'Light'],
        ['dark', 'Dark'],
        ['system', 'System'],
      ]
        .map(([k, n]) => {
          const L = { bg: '#FBFAF8', s: '#F2F1EE', t: '#1D1C1A', b: '#E3E1DC', a: '#4B5BD6' },
            Dk = { bg: '#1D1D1C', s: '#151514', t: '#ECEAE5', b: '#333230', a: '#8E9AF3' };
          const pv = c =>
            `<div class="s" style="background:${c.s}"><i style="background:${c.b};width:70%"></i><i style="background:${c.a};width:55%"></i><i style="background:${c.b};width:80%"></i><i style="background:${c.b};width:60%"></i></div><div class="m" style="background:${c.bg}"><i style="background:${c.t};width:45%;height:7px"></i><i style="background:${c.b}"></i><i style="background:${c.b};width:80%"></i><i style="background:${c.a};width:30%;height:10px;margin-top:4px"></i></div>`;
          return `<button class="tcard ${P.theme === k ? 'on' : ''}" role="radio" aria-checked="${P.theme === k}" data-a="setTheme" data-v="${k}"><div class="tprev" style="${k === 'system' ? 'grid-template-columns:1fr 1fr;display:grid' : ''}">${k === 'system' ? `<div style="display:grid;grid-template-columns:30% 1fr">${pv(L)}</div><div style="display:grid;grid-template-columns:30% 1fr">${pv(Dk)}</div>` : pv(k === 'light' ? L : Dk)}</div><span class="row" style="font-weight:500;font-size:13px;gap:6px">${ic(k === 'light' ? 'sun' : k === 'dark' ? 'moon' : 'monitor', 14)}${n}${P.theme === k ? `<span class="sp"></span><span style="color:var(--accent)">${ic('circle-check', 15)}</span>` : ''}</span></button>`;
        })
        .join('')}</div></div>
      <div class="sblock"><h2>Accent color</h2>${srow(
        'Accent',
        'Used for primary buttons, focus rings, and selection.',
        `<div class="swatches" role="radiogroup" aria-label="Accent color">${[
          ['indigo', '#4B5BD6'],
          ['blue', '#2F6CD4'],
          ['violet', '#7348CC'],
          ['teal', '#1A7F7A'],
          ['rose', '#B93D68'],
          ['graphite', '#34332F'],
        ]
          .map(
            ([k, c]) =>
              `<button class="sw ${P.accent === k ? 'on' : ''}" style="--c:${c}" role="radio" aria-checked="${P.accent === k}" data-a="setPref" data-k="accent" data-v="${k}" aria-label="${k}" data-tip="${k[0].toUpperCase() + k.slice(1)}">${P.accent === k ? ic('check', 13) : ''}</button>`,
          )
          .join('')}</div>`,
      )}</div>
      <div class="sblock"><h2>Density</h2>
        ${srow('Sidebar density', 'Compact fits more projects on screen.', `<div class="seg">${['comfortable', 'compact'].map(k => `<button class="${P.side === k ? 'on' : ''}" data-a="setPref" data-k="side" data-v="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>`)}
        ${srow('Task display', 'Row height in lists and card padding on boards.', `<div class="seg">${['comfortable', 'compact'].map(k => `<button class="${P.density === k ? 'on' : ''}" data-a="setPref" data-k="density" data-v="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>`)}
        ${srow(
          'Motion',
          'Reduce animations for drawers, modals, and transitions.',
          sel(
            'motion',
            [
              ['system', 'Follow system'],
              ['reduce', 'Reduce motion'],
            ],
            P.motion,
          ),
        )}
      </div>`
      );
    case 'language':
      return (
        H('Lux is currently available in English.') +
        srow('Interface language', 'Additional translations are not connected yet.', `<span class="badge">English</span>`) +
        srow('Spellcheck', 'Spellcheck follows your browser and operating system settings.', `<span class="muted">Browser controlled</span>`)
      );
    case 'datetime':
      return (
        H('How dates and times appear across the workspace. Date formatting is saved on this device.') +
        srow(
          'Time zone',
          'Lux currently uses your browser time zone for dates and times.',
          `<span class="muted">${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Browser time zone')}</span>`,
        ) +
        srow(
          'Date format',
          `Preview: <b>${fmtDate(dOff(8))}</b>`,
          sel(
            'dateFmt',
            [
              ['MMM d', 'Oct 1'],
              ['d/M', '1/10'],
              ['M/d', '10/1'],
              ['yyyy-MM-dd', '2026-10-01'],
            ],
            P.dateFmt,
          ),
        ) +
        srow(
          'Start week on',
          'Affects calendars and the timeline.',
          sel(
            'weekStart',
            [
              ['1', 'Monday'],
              ['0', 'Sunday'],
              ['6', 'Saturday'],
            ],
            P.weekStart,
          ),
        ) +
        srow('Time format', 'Time display follows your browser locale.', `<span class="muted">Browser controlled</span>`)
      );
    case 'members':
      return (
        H(`${d.members.length} people have access to ${esc(d.ws.name)}.`) +
        `<div class="row" style="margin-bottom:12px"><button class="btn btn-primary" data-a="invite">${ic('user-plus', 14)}Invite member</button><button class="btn btn-secondary" data-a="go" data-r="members">Open member directory</button></div>
      <div class="panel" style="overflow:hidden">${d.members.map(m => `<div class="mini" style="min-height:52px;cursor:default" data-ctx="member" data-id="${m.id}">${av(m.id, 'md', false)}<div class="grow"><div style="font-weight:500">${esc(m.name)}</div><div class="faint" style="font-size:12px">${esc(m.email)}</div></div>${m.status === 'invited' ? '<span class="badge amber">Invited</span>' : ''}${m.role === 'Owner' ? `<span class="pillbtn">${ic('crown', 13)}Owner</span>` : `<button class="pillbtn bordered" data-a="pop" data-pop="role" data-id="${m.id}">${m.role}${ic('chevron-down', 12)}</button>`}<button class="ibtn ibtn-sm" data-a="ctxBtn" data-ctx="member" data-id="${m.id}" aria-label="Options">${ic('ellipsis', 14)}</button></div>`).join('')}</div>`
      );
    case 'teams':
      return H('Teams group people and projects.') + teamsGrid();
    case 'projects': {
      const arch = d.projects.filter(p => p.archived);
      return (
        H('Defaults for new projects and archived work.') +
        srow(
          'Default project view',
          'The tab that opens when you open a project.',
          sel(
            'defaultTab',
            [
              ['board', 'Board'],
              ['list', 'List'],
              ['table', 'Table'],
              ['overview', 'Overview'],
              ['timeline', 'Timeline'],
            ],
            P.defaultTab || 'board',
          ),
        ) +
        srow('Show completed tasks on boards', '', tog('showDoneBoard', P.showDoneBoard !== false)) +
        `<div class="sblock"><h2>Archived projects</h2>${arch.length ? arch.map(p => `<div class="srow"><div class="row">${pIcon(p, '', 14)}<b style="font-weight:500">${esc(p.name)}</b></div><div class="row"><button class="btn btn-secondary btn-sm" data-a="restoreProject" data-id="${p.id}">Restore</button><button class="btn btn-danger-ghost btn-sm" data-a="delProject" data-id="${p.id}">Delete</button></div></div>`).join('') : `<p class="faint" style="padding:12px 0">No archived projects. Archived projects are hidden from the sidebar but keep all their tasks.</p>`}<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" data-a="go" data-r="archive">${ic('archive', 13)}Open archive</button></div></div>`
      );
    }
    case 'permissions':
      return permissionSettings();
    case 'notif-email':
      return (
        H('Email delivery is not available in this workspace.') +
        deliveryStatus('Lux currently delivers notifications in the in-app inbox. No email messages are sent from these settings.') +
        inAppNotificationLink
      );
    case 'notif-push':
      return (
        H('Mobile push delivery is not available in this workspace.') +
        deliveryStatus('Lux currently delivers notifications in the in-app inbox. No mobile push messages are sent from these settings.') +
        inAppNotificationLink
      );
    case 'notif-mentions':
      return (
        H('Decide which mentions reach you.') +
        notificationServiceCard() +
        srow('@mentions in comments and descriptions', '', tog('mention_all', np.mention_all !== false, 'np'))
      );
    case 'notif-assign':
      return (
        H('Updates about tasks assigned to you and projects you can access.') +
        notificationServiceCard() +
        srow("When I'm assigned a task", '', tog('assign_self', np.assign_self !== false, 'np')) +
        srow('Updates on followed projects and tasks', 'When an accessible project or task changes.', tog('assign_status', np.assign_status !== false, 'np'))
      );
    case 'notif-comments':
      return (
        H('Comments on tasks you can access.') +
        notificationServiceCard() +
        srow('Task comments', 'When a relevant task receives a comment.', tog('comment_all', np.comment_all !== false, 'np'))
      );
    case 'profile': {
      const err = S.ui.errors.pname2;
      return (
        H('How you appear to others in the workspace.') +
        `<form data-submit="saveProfile" class="col" style="gap:16px;max-width:440px">
      <div class="row" style="gap:14px">${av(d.me, 'xl', false)}<div><div class="label" style="margin-bottom:6px">Avatar color</div><div class="swatches">${['#5A67D8', '#C54B78', '#3B82C4', '#23918A', '#C48A1E', '#8662C9'].map(c => `<button type="button" class="sw ${me().c === c ? 'on' : ''}" style="--c:${c};width:22px;height:22px" data-a="avColor" data-v="${c}" aria-label="Color"></button>`).join('')}</div></div></div>
      <div class="field"><label class="label" for="pf-name">Full name</label><input class="input ${err ? 'is-error' : ''}" id="pf-name" value="${esc(P.name)}">${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
      <div class="field"><label class="label" for="pf-title">Title</label><input class="input" id="pf-title" value="${esc(P.title)}"></div>
      <div class="field"><label class="label" for="pf-email">Email</label><input class="input" id="pf-email" value="${esc(me().email)}" disabled><span class="hint">Contact a workspace owner to change your sign-in email.</span></div>
      <div><button class="btn btn-primary" data-a="saveProfile" id="pf-save">Save profile</button></div></form>`
      );
    }
    case 'preferences':
      return (
        H('Personal defaults for how you work.') +
        srow(
          'Open on launch',
          'The page you see when Lux opens.',
          sel(
            'home',
            [
              ['home', 'Home'],
              ['mytasks', 'My Tasks'],
              ['inbox', 'Inbox'],
            ],
            P.home,
          ),
        ) +
        srow(
          'Open tasks in',
          'Side panel keeps your place in the list.',
          sel(
            'openTasks',
            [
              ['drawer', 'Side panel'],
              ['full', 'Full page'],
            ],
            P.openTasks,
          ),
        ) +
        srow('Confirm before deleting tasks', '', tog('confirmDel', P.confirmDel !== false))
      );
    case 'shortcuts':
      return (
        H('Move faster with the keyboard.') +
        SHORTCUTS.map(
          ([g, list]) =>
            `<div class="sblock" style="margin-top:18px"><h2>${g}</h2>${list.map(([n, k]) => `<div class="srow" style="padding:9px 0"><span>${n}</span><span class="row" style="gap:4px">${k.map((x, i) => `${i && k[0] === 'G' ? '<span class="faint" style="font-size:11px">then</span>' : ''}<kbd>${x}</kbd>`).join('')}</span></div>`).join('')}</div>`,
        ).join('')
      );
    case 'password': {
      const e = S.ui.errors;
      const pw = S.ui.pwNew || '';
      return (
        H("Use a long password you don't use anywhere else.") +
        `${S.ui.pwDone ? `<div class="alert ok" style="margin-bottom:14px">${ic('circle-check', 15)}<span>Password updated. Other sessions stay signed in.</span></div>` : ''}<form data-submit="savePassword" class="col" style="gap:14px;max-width:400px">
      <div class="field"><label class="label" for="pw-cur">Current password</label><input type="password" class="input ${e.pwCur ? 'is-error' : ''}" id="pw-cur" autocomplete="current-password">${e.pwCur ? `<span class="err">${ic('circle-alert', 12)}${e.pwCur}</span>` : ''}</div>
      <div class="field"><label class="label" for="pw-new">New password</label><input type="password" class="input ${e.pwNew ? 'is-error' : ''}" id="pw-new" data-in="pwStrength" value="${esc(pw)}" autocomplete="new-password">${strengthMeter(pw)}${e.pwNew ? `<span class="err">${ic('circle-alert', 12)}${e.pwNew}</span>` : '<span class="hint">At least 10 characters with a number or symbol.</span>'}</div>
      <div class="field"><label class="label" for="pw-conf">Confirm new password</label><input type="password" class="input ${e.pwConf ? 'is-error' : ''}" id="pw-conf" autocomplete="new-password">${e.pwConf ? `<span class="err">${ic('circle-alert', 12)}${e.pwConf}</span>` : ''}</div>
      <div><button class="btn btn-primary" data-a="savePassword" id="pw-save">Update password</button></div></form>`
      );
    }
    case 'sessions':
      return (
        H('Devices currently signed in to your account.') +
        d.sessions
          .map(s =>
            srow(
              `<span class="row" style="gap:8px">${ic(s.dev.includes('iPhone') ? 'smartphone' : 'monitor', 15)}${esc(s.dev)}${s.cur ? '<span class="badge green">This device</span>' : ''}</span>`,
              `${esc(s.loc)} · ${esc(s.at)}`,
              s.cur ? '' : `<button class="btn btn-secondary btn-sm" data-a="revokeSession" data-id="${s.id}">Sign out</button>`,
            ),
          )
          .join('') +
        `<div style="margin-top:16px"><button class="btn btn-danger-ghost" data-a="revokeAll" ${d.sessions.length > 1 ? '' : 'disabled'}>Sign out of all other sessions</button></div>`
      );
    case '2fa':
      return (
        H('Add a second step when signing in.') +
        (d.tfa
          ? `<div class="alert ok">${ic('shield-check', 16)}<div><b>Two-factor authentication is on.</b><div class="muted">You'll enter a code from your authenticator app when signing in on a new device.</div></div></div><div class="sblock"><h2>Recovery codes</h2><p class="muted" style="font-size:13px">Store these somewhere safe. Each code works once.</p><div style="display:grid;grid-template-columns:repeat(2,max-content);gap:6px 28px;font-family:var(--mono);font-size:13px;padding:14px;border:1px solid var(--border);border-radius:var(--r);background:var(--sunken);user-select:all">${['7KQ2-M8PX', 'D4TN-9WRE', 'HV3C-QZ6L', 'P2YB-J7SK', 'R9FG-4NUD', 'X6MA-T3HE'].map(c => `<span>${c}</span>`).join('')}</div><div style="margin-top:14px"><button class="btn btn-danger-ghost" data-a="disable2fa">Turn off two-factor authentication</button></div></div>`
          : S.ui.tfaSetup
            ? `<div class="panel" style="padding:18px;display:flex;gap:20px;flex-wrap:wrap"><div style="width:132px;height:132px;display:grid;grid-template-columns:repeat(11,1fr);gap:1px;padding:8px;background:#fff;border-radius:8px;border:1px solid var(--border)" aria-label="QR code">${Array.from(
                { length: 121 },
                (_, i) => {
                  const r = Math.floor(i / 11),
                    c = i % 11;
                  const f = (r < 3 && c < 3) || (r < 3 && c > 7) || (r > 7 && c < 3);
                  const on = f ? !((r === 1 && c === 1) || (r === 1 && c === 9) || (r === 9 && c === 1)) : (i * 7919) % 13 < 6;
                  return `<i style="background:${on ? '#1D1C1A' : '#fff'}"></i>`;
                },
              ).join('')}</div>
        <div class="grow col" style="gap:10px;min-width:220px"><div><b>1. Scan the QR code</b><div class="muted" style="font-size:13px">Use 1Password, Authy, or Google Authenticator.</div></div><div><b>2. Enter the 6-digit code</b></div><form data-submit="verify2fa" class="row"><input class="input mono ${S.ui.errors.tfa ? 'is-error' : ''}" id="tfa-code" inputmode="numeric" maxlength="6" placeholder="000000" style="width:130px;letter-spacing:.2em;font-size:15px" autofocus><button class="btn btn-primary" data-a="verify2fa">Verify</button><button type="button" class="btn btn-ghost" data-a="cancel2fa">Cancel</button></form>${S.ui.errors.tfa ? `<span class="err">${ic('circle-alert', 12)}${S.ui.errors.tfa}</span>` : '<span class="hint">Any 6 digits work in this prototype.</span>'}</div></div>`
            : `<div class="panel" style="padding:18px" ><div class="row" style="gap:14px;align-items:flex-start"><span class="ftype" style="--c:var(--amber);width:36px;height:36px">${ic('shield-alert', 18)}</span><div class="grow"><b>Two-factor authentication is off</b><p class="muted" style="margin:4px 0 12px;font-size:13px">Protect your account with a code from an authenticator app in addition to your password.</p><button class="btn btn-primary" data-a="setup2fa">Set up two-factor authentication</button></div></div></div>`)
      );
    case 'plan':
      return teamAccessBody('plan');
    case 'payment':
      return teamAccessBody('payment');
    case 'invoices':
      return teamAccessBody('invoices');
  }
  return page404();
}
export function strengthMeter(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  const c = ['var(--red)', 'var(--red)', 'var(--amber)', 'var(--green)', 'var(--green)'][s];
  const n = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s];
  return pw
    ? `<div class="row" style="gap:8px"><div class="strength grow" aria-hidden="true">${[0, 1, 2, 3].map(i => `<i class="${i < s ? 'on' : ''}" style="--c:${c}"></i>`).join('')}</div><span style="font-size:11.5px;color:${c};width:60px;text-align:right">${n}</span></div>`
    : '';
}

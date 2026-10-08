import { emptyData } from '../../shared/model.ts';
import { S, D, setSaveHandler } from '../core/store.js';
import { A, IN, copy } from '../actions/actions.js';
import { render, setDrawerObserver, notifyDrawer, preparePullRequestAnchors } from '../shell/render.js';
import { renderPullRequests } from '../overlays/drawer.js';
import DOMPurify from 'dompurify';
import { toast } from '../ui/toast.js';

function status(message, busy, error = false) {
  let host = document.getElementById('team-sync');
  if (!host) {
    host = document.createElement('div');
    host.id = 'team-sync';
    host.setAttribute('role', 'status');
    document.body.append(host);
  }
  host.textContent = message;
  host.className = error ? 'team-sync error' : 'team-sync';
  for (const id of ['app', 'layer']) document.getElementById(id).inert = busy;
}
let pullRequestFocus = null;
function reset() {
  S.ui.teamReady = false;
  notifyDrawer(null);
  pullRequestFocus = null;
  S.data = { ...emptyData(), workspaces: [], projOrder: [], notifs: [], sessions: [], invoices: [], notifPrefs: {}, recentSearches: [] };
  S.ui.auth = null;
  S.ui.modals = [];
  S.ui.drawer = null;
  S.ui.palette = null;
  S.ui.pop = null;
  S.ui.route = 'home';
  S.ui.params = {};
  S.ui.pullRequestLinks = { task: null, links: [], canEdit: false, loading: false, busy: false, error: null };
  S.ui.pullRequestDrafts = {};
  S.ui.notificationHasMore = false;
  S.ui.notificationLoading = false;
  S.ui.notificationDelivery = null;
  document.getElementById('app').replaceChildren();
  document.getElementById('layer').replaceChildren();
  document.getElementById('toasts').replaceChildren();
}
function apply(data, workspaces) {
  // Favorites, view order, and appearance belong to this browser/user, not the team.
  const sameUser = D().me === data.me;
  let local = {};
  try {
    local = JSON.parse(localStorage.getItem('lux.prefs.' + data.me) || '{}');
  } catch {
    /* Use defaults if browser storage is unavailable. */
  }
  if (!sameUser) {
    S.prefs = { ...S.prefs, ...local.prefs };
    S.views = local.views || {};
    S.ui.collapsed = !!local.collapsed;
  }
  const favs = new Set(sameUser ? [...D().projects, ...D().tasks].filter(x => x.fav).map(x => x.id) : local.favorites || []);
  const order = sameUser ? D().projOrder || [] : local.order || [];
  S.data = {
    ...data,
    workspaces,
    projOrder: [...order.filter(id => data.projects.some(p => p.id === id)), ...data.projects.map(p => p.id).filter(id => !order.includes(id))],
    notifs: sameUser ? D().notifs : [],
    sessions: [],
    invoices: [],
    notifPrefs: sameUser ? D().notifPrefs : {},
    recentSearches: [],
  };
  for (const p of D().projects) {
    p.seq = Math.max(
      200,
      ...D()
        .tasks.filter(t => t.project === p.id)
        .map(t => Number(t.key.split('-').at(-1)) || 0),
    );
    p.fav = favs.has(p.id);
  }
  for (const t of D().tasks) t.fav = favs.has(t.id);
  if (S.ui.drawer && !D().tasks.some(t => t.id === S.ui.drawer)) S.ui.drawer = null;
  if (S.ui.route === 'project' && !D().projects.some(p => p.id === S.ui.params.id)) {
    S.ui.route = 'projects';
    S.ui.params = {};
  }
  S.prefs.name = D().members.find(m => m.id === data.me)?.name || '';
  S.prefs.title = D().members.find(m => m.id === data.me)?.title || '';
}
export const bridge = {
  read: () => D(),
  apply,
  reset,
  pullRequests(state) {
    S.ui.pullRequestLinks = state;
    const section = document.querySelector('.prsec');
    if (!section || S.ui.drawer !== state.task) {
      pullRequestFocus = null;
      return;
    }
    const active = document.activeElement;
    const focused = section.contains(active);
    if (focused && active.id) pullRequestFocus = { task: state.task, id: active.id, start: active.selectionStart, end: active.selectionEnd };
    // Subscription updates must not replace unrelated unsaved drawer inputs.
    section.outerHTML = DOMPurify.sanitize(renderPullRequests(state.task));
    preparePullRequestAnchors();
    if (!state.busy && pullRequestFocus?.task === state.task && (focused || document.activeElement === document.body)) {
      const control = document.getElementById(state.error ? 'pr-url-' + state.task : pullRequestFocus.id) || document.getElementById('pr-url-' + state.task);
      control?.focus({ preventScroll: true });
      if (control?.setSelectionRange && pullRequestFocus.start != null) control.setSelectionRange(pullRequestFocus.start, pullRequestFocus.end);
    }
    if (!state.busy) pullRequestFocus = null;
  },
  clearPullRequestDraft(task, expected) {
    if (S.ui.pullRequestDrafts?.[task]?.trim() === expected.trim()) delete S.ui.pullRequestDrafts[task];
  },
  notifications(state) {
    S.ui.notificationDelivery = state.delivery;
    D().notifs = state.notifications.map(n => ({ ...n, by: n.actor, at: n.createdAt, read: n.readAt !== null, text: n.title, snippet: n.body }));
    D().notifPrefs = {
      mention_all: state.preferences.mentions,
      assign_self: state.preferences.assignments,
      comment_all: state.preferences.comments,
      assign_status: state.preferences.updates,
    };
    S.ui.notificationHasMore = state.hasMore;
    S.ui.notificationLoading = state.loading;
    if (S.ui.teamReady) render();
  },
  status,
  ready() {
    if (!S.ui.teamReady) {
      const [kind, key] = location.hash.slice(1).split('/');
      const task = kind === 'task' && D().tasks.find(t => t.key === key);
      const file = kind === 'file' && D().files.find(f => f.id === key);
      const project =
        task || file ? D().projects.find(p => p.id === (task || file).project) : kind === 'project' && D().projects.find(p => p.key.toLowerCase() === key);
      if (project) {
        S.ui.route = 'project';
        S.ui.params = { id: project.id, tab: file ? 'files' : S.prefs.defaultTab || 'board' };
      } else S.ui.route = ['home', 'mytasks', 'inbox'].includes(S.prefs.home) ? S.prefs.home : 'home';
      if (task) S.ui.drawer = task.id;
    }
    S.ui.teamReady = true;
    render();
  },
  bind(session) {
    setDrawerObserver(task => session.watchPullRequestLinks(task));
    setSaveHandler(() => {
      try {
        localStorage.setItem(
          'lux.prefs.' + D().me,
          JSON.stringify({
            prefs: S.prefs,
            views: S.views,
            collapsed: S.ui.collapsed,
            favorites: [...D().projects, ...D().tasks].filter(x => x.fav).map(x => x.id),
            order: D().projOrder,
          }),
        );
      } catch {
        /* Shared data still saves through Convex. */
      }
      session.save();
    });
    const run =
      fn =>
      (...args) => {
        Promise.resolve()
          .then(() => fn(...args))
          .catch(e => session.showError(e));
      };
    A.removeMember = run(el => session.removeMember(el.dataset.id));
    A.delWorkspace = () => A.confirmDeleteWorkspace(run(name => session.deleteWorkspace(name)));
    A.duplicateFile = run(el => session.duplicateFile(el.dataset.id));
    A.loadMoreNotifications = () => session.loadMoreNotifications();
    const selectNotification = (el, open) => {
      const n = D().notifs.find(item => item.id === el.dataset.id);
      if (!n) return;
      run(() => session.setNotificationRead(n.id, true))();
      if (open && n.task && D().tasks.some(t => t.id === n.task)) A.openTask({ dataset: { id: n.task } });
      else if (open && n.project && D().projects.some(p => p.id === n.project)) A.go({ dataset: { r: 'project', id: n.project, tab: 'overview' } });
      else {
        S.ui.inboxSel = n.id;
        render();
      }
    };
    A.selNotif = el => selectNotification(el, false);
    A.openNotif = el => selectNotification(el, true);
    A.toggleRead = run(el => {
      const n = D().notifs.find(item => item.id === el.dataset.id);
      if (n) return session.setNotificationRead(n.id, !n.read);
    });
    A.markAllRead = run(() => session.markAllNotificationsRead());
    A.retryNotificationDelivery = run(async () => {
      const result = await session.retryNotificationDelivery();
      if (!result) return;
      toast(
        result.configured
          ? `${result.count} event${result.count === 1 ? '' : 's'} queued${result.hasMore ? '. More events remain; retry again after this batch.' : '.'}`
          : 'The notification service needs server configuration.',
        { kind: 'info' },
      );
    });
    IN.npToggle = run(async el => {
      const key = { mention_all: 'mentions', assign_self: 'assignments', comment_all: 'comments', assign_status: 'updates' }[el.dataset.k];
      if (!key) return;
      await session.saveNotificationPreferences({ [key]: el.checked });
      toast('Notification preference saved', { ms: 1500 });
    });
    A.signOut = run(() => session.signOut());
    A.switchWs = run(el => session.switchWorkspace(el.dataset.v));
    A.newWorkspace = () => session.choose();
    A.manageAccount = () => session.manageAccount();
    A.requestAccess = el => {
      const project = D().projects.find(project => project.id === el.dataset.id);
      const owner = D().members.find(member => member.id === project?.lead) || D().members.find(member => member.role === 'Owner');
      if (owner?.email) copy(owner.email, 'Owner email copied. Contact them to request access.');
      else toast('Ask your workspace owner to add you to this project.', { kind: 'info' });
    };
    A.copyInviteLink = A.resendInvite = () => copy(location.origin, 'Workspace link copied. Share it with the invited person.');
    A.downloadFile = run(el => session.download(el.dataset.id || el.dataset.aid));
    A.filePreview = run(el => session.download(el.dataset.aid));
    A.previewFile = run(el => session.download(el.dataset.id));
    A.teamUpload = (files, ctx) => {
      void session.upload(files, ctx.project, ctx.task).catch(e => session.showError(e));
    };
    A.addPullRequestLink = run(form => {
      const value = new FormData(form).get('url');
      const urlValue = typeof value === 'string' ? value.trim() : '';
      return session.addPullRequestLink(form.dataset.task, urlValue);
    });
    A.removePullRequestLink = run(el => session.removePullRequestLink(el.dataset.task, el.dataset.link));
    IN.pullRequestDraft = el => {
      S.ui.pullRequestDrafts ??= {};
      S.ui.pullRequestDrafts[el.dataset.task] = el.value;
    };
    const unavailable = () => toast('This feature is not available in the team workspace yet.', { kind: 'info' });
    for (const name of [
      'resetDemo',
      'toggleOffline',
      'retryOnline',
      'startOnboarding',
      'changePlan',
      'demoToast',
      'demoConfirm',
      'demoLoad',
      'doLogin',
      'socialAuth',
      'doSignup',
      'doForgot',
      'doReset',
      'verified',
      'onbNext',
    ])
      A[name] = unavailable;
    for (const name of ['savePassword', 'revokeSession', 'revokeAll', 'setup2fa', 'verify2fa', 'disable2fa']) A[name] = () => session.manageAccount();
    IN.formFiles = () => toast('Create the task first, then upload attachments from its Files tab.', { kind: 'info' });
  },
};

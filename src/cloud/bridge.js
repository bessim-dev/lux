import { emptyData } from '../../shared/model.ts';
import { S, D, setSaveHandler } from '../core/store.js';
import { A, IN, copy } from '../actions/actions.js';
import { render } from '../shell/render.js';
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
function reset() {
  S.ui.teamReady = false;
  S.data = { ...emptyData(), workspaces: [], projOrder: [], notifs: [], sessions: [], invoices: [], notifPrefs: {}, recentSearches: [] };
  S.ui.auth = null;
  S.ui.modals = [];
  S.ui.drawer = null;
  S.ui.palette = null;
  S.ui.pop = null;
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
    notifs: [],
    sessions: [],
    invoices: [],
    notifPrefs: {},
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
  status,
  ready() {
    if (!S.ui.teamReady) {
      const [kind, key] = location.hash.slice(1).split('/');
      const task = kind === 'task' && D().tasks.find(t => t.key === key);
      const project = task ? D().projects.find(p => p.id === task.project) : kind === 'project' && D().projects.find(p => p.key.toLowerCase() === key);
      if (project) {
        S.ui.route = 'project';
        S.ui.params = { id: project.id, tab: 'board' };
      }
      if (task) S.ui.drawer = task.id;
    }
    S.ui.teamReady = true;
    render();
  },
  bind(session) {
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
    A.signOut = run(() => session.signOut());
    A.switchWs = A.newWorkspace = () => session.choose();
    A.manageAccount = () => session.manageAccount();
    A.copyInviteLink = A.resendInvite = () => copy(location.origin, 'Workspace link copied. Share it with the invited person.');
    A.downloadFile = run(el => session.download(el.dataset.id || el.dataset.aid));
    A.filePreview = run(el => session.download(el.dataset.aid));
    A.previewFile = run(el => session.download(el.dataset.id));
    A.teamUpload = (files, ctx) => {
      void session.upload(files, ctx.project, ctx.task).catch(e => session.showError(e));
    };
    const unavailable = () => toast('This feature is not available in the team workspace yet.', { kind: 'info' });
    for (const name of [
      'resetDemo',
      'toggleOffline',
      'retryOnline',
      'startOnboarding',
      'delWorkspace',
      'changePlan',
      'duplicateFile',
      'requestAccess',
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

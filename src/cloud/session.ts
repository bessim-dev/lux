import { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { changes, dataSchema, entities, equal, type Data } from '../../shared/model';
import { z } from 'zod';
import { ConvexError } from 'convex/values';
import type { PullRequestLinksState } from '../../shared/pull-requests';
import { defaultNotificationPreferences, type Notification, type NotificationPreferences, type NotificationPreferencePatch } from '../../shared/notifications';

export interface NotificationsState {
  notifications: Notification[];
  preferences: NotificationPreferences;
  hasMore: boolean;
  loading: boolean;
  delivery: { configured: boolean; pending: number; failed: number; sent: number; hasMore: boolean } | null;
}

export interface Workspace {
  id: Id<'workspaces'>;
  name: string;
  c: string;
  plan: string;
}
export interface Bridge {
  read(): unknown;
  apply(data: Data, workspaces: Workspace[]): void;
  reset(): void;
  ready(): void;
  status(message: string, busy: boolean, error?: boolean): void;
  bind(controller: TeamSession): void;
  pullRequests(state: PullRequestLinksState): void;
  clearPullRequestDraft(task: string, expected: string): void;
  notifications(state: NotificationsState): void;
}
const app = () => document.getElementById('app')!;
const message = (error: unknown) => (error instanceof Error ? error.message : 'The request failed. Please try again.');
const pullRequestMessage = (error: unknown) => (error instanceof ConvexError && typeof error.data === 'string' ? error.data : message(error));
const normalize = (raw: unknown): Data => {
  const data = dataSchema.parse(raw);
  for (const p of data.projects) {
    p.fav = false;
    delete p.seq;
  }
  for (const t of data.tasks) {
    t.fav = false;
    t.attachments = [];
  }
  return data;
};

export class TeamSession {
  private workspace: Id<'workspaces'> | null = null;
  private baseline: Data | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private failed = false;
  private generation = 0;
  private workspaces: Workspace[] = [];
  private pendingDraft: unknown = null;
  private unsubscribePullRequests: (() => void) | null = null;
  private pullRequestVersion = 0;
  private pullRequestState: PullRequestLinksState = { task: null, links: [], canEdit: false, loading: false, busy: false, error: null };
  private notificationSubscriptions: (() => void)[] = [];
  private notificationPageTokens: symbol[] = [];
  private notificationPages: { notifications: Notification[]; cursor: string | null; isDone: boolean }[] = [];
  private notificationPreferences: NotificationPreferences = defaultNotificationPreferences;
  private unsubscribePreferences: (() => void) | null = null;
  private unsubscribeDelivery: (() => void) | null = null;
  private notificationDelivery: NotificationsState['delivery'] = null;
  private notificationLoading = false;
  constructor(
    readonly client: ConvexClient,
    private bridge: Bridge,
    private logout: () => Promise<void>,
    private account: () => void,
  ) {
    bridge.bind(this);
    window.addEventListener('beforeunload', event => {
      if (this.saving || this.timer || this.failed) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }
  async start() {
    await this.client.mutation(api.workspaces.acceptInvitations, {});
    this.workspaces = await this.client.query(api.workspaces.list, {});
    if (this.workspaces.length === 1) await this.open(this.workspaces[0].id);
    else this.choose();
  }
  choose() {
    if (this.saving || this.timer || this.failed) {
      this.bridge.status('Save or reload your current changes before switching workspaces.', false, true);
      return;
    }
    this.generation++;
    this.stopNotifications();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.workspace = null;
    this.baseline = null;
    this.bridge.reset();
    app().replaceChildren();
    const section = document.createElement('section');
    section.className = 'team-gate';
    const heading = document.createElement('h1');
    heading.textContent = 'Your team workspaces';
    section.append(heading);
    const help = document.createElement('p');
    help.textContent = 'Choose a workspace or create one for your team. Invitations appear when you sign in with the invited email.';
    section.append(help);
    for (const workspace of this.workspaces) {
      const button = document.createElement('button');
      button.className = 'btn btn-secondary';
      button.textContent = workspace.name;
      button.onclick = () => {
        void this.open(workspace.id).catch(e => this.showError(e));
      };
      section.append(button);
    }
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = 'Workspace name';
    input.setAttribute('aria-label', 'Workspace name');
    input.required = true;
    input.maxLength = 200;
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = 'Create workspace';
    form.append(input, button);
    form.onsubmit = async event => {
      event.preventDefault();
      button.disabled = true;
      try {
        const id = await this.client.mutation(api.workspaces.create, { name: input.value });
        this.workspaces = await this.client.query(api.workspaces.list, {});
        await this.open(id);
      } catch (e) {
        this.showError(e);
        button.disabled = false;
      }
    };
    section.append(form);
    const signout = document.createElement('button');
    signout.className = 'btn btn-ghost';
    signout.textContent = 'Sign out';
    signout.onclick = () => {
      void this.signOut();
    };
    section.append(signout);
    app().append(section);
    this.bridge.status('', false);
  }
  async open(id: Id<'workspaces'>) {
    if (!this.workspaces.some(w => w.id === id)) throw new Error('Workspace unavailable.');
    this.unsubscribe?.();
    this.stopNotifications();
    this.workspace = id;
    this.baseline = null;
    this.failed = false;
    const generation = ++this.generation;
    this.bridge.reset();
    this.bridge.status('Loading workspace…', true);
    this.unsubscribe = this.client.onUpdate(
      api.workspaces.snapshot,
      { workspace: id },
      data => {
        if (generation !== this.generation || this.saving || this.timer || this.failed) return;
        this.accept(data);
      },
      error => {
        if (generation !== this.generation) return;
        this.bridge.reset();
        this.baseline = null;
        this.showError(error);
      },
    );
    this.watchNotificationPage(undefined, 0, generation);
    this.unsubscribePreferences = this.client.onUpdate(
      api.notifications.preferences,
      { workspace: id },
      preferences => {
        if (generation !== this.generation) return;
        this.notificationPreferences = preferences;
        this.publishNotifications();
      },
      error => {
        if (generation === this.generation) this.showError(error);
      },
    );
    this.unsubscribeDelivery = this.client.onUpdate(
      api.notificationDelivery.status,
      { workspace: id },
      delivery => {
        if (generation !== this.generation) return;
        this.notificationDelivery = delivery;
        this.publishNotifications();
      },
      error => {
        if (generation === this.generation) this.showError(error);
      },
    );
  }
  private stopNotifications() {
    for (const stop of this.notificationSubscriptions) stop();
    this.notificationSubscriptions = [];
    this.notificationPageTokens = [];
    this.notificationPages = [];
    this.unsubscribePreferences?.();
    this.unsubscribePreferences = null;
    this.unsubscribeDelivery?.();
    this.unsubscribeDelivery = null;
    this.notificationDelivery = null;
    this.notificationPreferences = defaultNotificationPreferences;
    this.notificationLoading = false;
  }
  private publishNotifications() {
    const byId = new Map(this.notificationPages.flatMap(page => page.notifications).map(notification => [notification.id, notification]));
    this.bridge.notifications({
      notifications: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt),
      preferences: this.notificationPreferences,
      hasMore: this.notificationPages.at(-1)?.isDone === false,
      loading: this.notificationLoading,
      delivery: this.notificationDelivery,
    });
  }
  private watchNotificationPage(cursor: string | undefined, index: number, generation: number) {
    if (!this.workspace) return;
    this.notificationLoading = true;
    this.publishNotifications();
    this.notificationSubscriptions[index] = () => {};
    const token = Symbol();
    this.notificationPageTokens[index] = token;
    const stop = this.client.onUpdate(
      api.notifications.list,
      { workspace: this.workspace, limit: 50, ...(cursor ? { cursor } : {}) },
      result => {
        if (generation !== this.generation || this.notificationPageTokens[index] !== token) return;
        // When a live page boundary shifts, discard later pages so no stale cursor can hide items.
        const previous = this.notificationPages[index];
        if (previous && previous.cursor !== result.page.cursor) {
          for (const unsubscribe of this.notificationSubscriptions.splice(index + 1)) unsubscribe();
          this.notificationPages.splice(index + 1);
          this.notificationPageTokens.splice(index + 1);
        }
        this.notificationPages[index] = { notifications: result.notifications, ...result.page };
        this.notificationLoading = false;
        this.publishNotifications();
      },
      error => {
        if (generation !== this.generation || this.notificationPageTokens[index] !== token) return;
        this.notificationLoading = false;
        this.publishNotifications();
        this.showError(error);
      },
    );
    if (generation === this.generation && this.notificationPageTokens[index] === token) this.notificationSubscriptions[index] = stop;
    else stop();
  }
  loadMoreNotifications() {
    const last = this.notificationPages.at(-1);
    if (!last?.cursor || last.isDone || this.notificationLoading) return;
    this.watchNotificationPage(last.cursor, this.notificationPages.length, this.generation);
  }
  async setNotificationRead(notification: string, read: boolean) {
    if (!this.workspace) return;
    await this.client.mutation(api.notifications.setRead, { workspace: this.workspace, notification, read });
  }
  async markAllNotificationsRead() {
    if (!this.workspace) return;
    const workspace = this.workspace;
    const generation = this.generation;
    const before = Date.now();
    while (workspace === this.workspace && generation === this.generation) {
      const result = await this.client.mutation(api.notifications.markAllRead, { workspace, before });
      if (!result.hasMore) return;
    }
  }
  async retryNotificationDelivery() {
    if (!this.workspace) return;
    return this.client.mutation(api.notificationDelivery.retryQueued, { workspace: this.workspace });
  }
  async saveNotificationPreferences(patch: NotificationPreferencePatch) {
    if (!this.workspace) return;
    await this.client.mutation(api.notifications.savePreferences, { workspace: this.workspace, ...patch });
  }
  private accept(raw: unknown) {
    const data = dataSchema.parse(raw);
    this.baseline = normalize(data);
    this.bridge.apply(data, this.workspaces);
    this.publishNotifications();
    this.bridge.ready();
    this.bridge.status('All changes saved', false);
  }
  save() {
    if (!this.workspace || !this.baseline || this.failed || this.saving) return;
    if (this.timer) clearTimeout(this.timer);
    this.bridge.status('Unsaved changes', false);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 400);
  }
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.workspace || !this.baseline || this.failed || this.saving) return;
    const workspace = this.workspace,
      generation = this.generation;
    this.saving = true;
    this.pendingDraft = structuredClone(this.bridge.read());
    this.bridge.status('Saving…', true);
    try {
      const next = normalize(this.pendingDraft),
        before = this.baseline;
      // Membership changes run first so newly invited people can be added to projects.
      for (const id of new Set([...before.members.map(m => m.id), ...next.members.map(m => m.id)])) {
        const a = before.members.find(m => m.id === id) ?? null,
          b = next.members.find(m => m.id === id) ?? null;
        if (!equal(a, b))
          await this.client.mutation(api.members.update, { workspace, before: a ? JSON.stringify(a) : null, after: b ? JSON.stringify(b) : null });
      }
      if (!equal(before.ws, next.ws))
        await this.client.mutation(api.workspaces.update, { workspace, before: JSON.stringify(before.ws), after: JSON.stringify(next.ws) });
      const delta = changes(entities(before), entities(next));
      if (delta.length)
        await this.client.mutation(api.entities.apply, {
          workspace,
          changes: delta.map(op => ({ before: op.before ? JSON.stringify(op.before) : null, after: op.after ? JSON.stringify(op.after) : null })),
        });
      const data = await this.client.query(api.workspaces.snapshot, { workspace });
      if (generation === this.generation) {
        this.accept(data);
        this.pendingDraft = null;
      }
    } catch (error) {
      this.failed = true;
      this.bridge.status(`${message(error)} Download your draft before reloading.`, true, true);
      this.recovery();
    } finally {
      this.saving = false;
    }
  }
  private recovery() {
    const host = document.getElementById('team-sync');
    if (!host) return;
    const download = document.createElement('button');
    download.textContent = 'Download unsaved draft';
    download.className = 'btn btn-secondary';
    download.onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.pendingDraft, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'lux-unsaved-draft.json';
      link.click();
      URL.revokeObjectURL(url);
    };
    const reload = document.createElement('button');
    reload.textContent = 'Reload saved data';
    reload.className = 'btn btn-secondary';
    reload.onclick = () => {
      if (confirm('Discard unsaved changes and reload the saved workspace?')) location.reload();
    };
    host.append(download, reload);
  }
  showError(error: unknown) {
    this.bridge.status(message(error), false, true);
  }
  private publishPullRequests(state: PullRequestLinksState) {
    this.pullRequestState = state;
    this.bridge.pullRequests(state);
  }
  watchPullRequestLinks(task: string | null) {
    if (task !== this.pullRequestState.task) {
      this.unsubscribePullRequests?.();
      this.unsubscribePullRequests = null;
      this.pullRequestVersion++;
      this.publishPullRequests({ task, links: [], canEdit: false, loading: !!task, busy: false, error: null });
    }
    if (!task || !this.workspace || !this.baseline || this.unsubscribePullRequests) return;
    // A newly created task must reach the backend before its links query starts.
    if (!this.baseline.tasks.some(t => t.id === task)) return;
    const version = this.pullRequestVersion;
    const generation = this.generation;
    // A cached query may notify synchronously and render again while subscribing.
    this.unsubscribePullRequests = () => {};
    const unsubscribe = this.client.onUpdate(
      api.pullRequestLinks.list,
      { workspace: this.workspace, task },
      result => {
        if (version !== this.pullRequestVersion || generation !== this.generation) return;
        this.publishPullRequests({ ...this.pullRequestState, ...result, loading: false, error: null });
      },
      error => {
        if (version !== this.pullRequestVersion || generation !== this.generation) return;
        this.publishPullRequests({ task, links: [], canEdit: false, loading: false, busy: false, error: pullRequestMessage(error) });
      },
    );
    if (version === this.pullRequestVersion && generation === this.generation) this.unsubscribePullRequests = unsubscribe;
    else unsubscribe();
  }
  async addPullRequestLink(task: string, url: string) {
    await this.changePullRequestLink(task, workspace => this.client.mutation(api.pullRequestLinks.add, { workspace, task, url }), url);
  }
  async removePullRequestLink(task: string, link: string) {
    await this.changePullRequestLink(task, workspace => this.client.mutation(api.pullRequestLinks.remove, { workspace, task, link }));
  }
  private async changePullRequestLink(task: string, change: (workspace: Id<'workspaces'>) => Promise<unknown>, draft?: string) {
    if (this.pullRequestState.task !== task || !this.pullRequestState.canEdit || this.pullRequestState.busy || this.pullRequestState.loading) return;
    const version = this.pullRequestVersion;
    const generation = this.generation;
    const current = () => version === this.pullRequestVersion && generation === this.generation;
    this.publishPullRequests({ ...this.pullRequestState, busy: true, error: null });
    try {
      if (this.timer) await this.flush();
      if (!current()) return;
      if (!this.workspace || this.failed || this.saving) throw new Error('Save or reload your task changes before editing pull request links.');
      await change(this.workspace);
      if (draft !== undefined && generation === this.generation) this.bridge.clearPullRequestDraft(task, draft);
      if (!current()) return;
      const result = await this.client.query(api.pullRequestLinks.list, { workspace: this.workspace, task });
      if (current()) this.publishPullRequests({ ...this.pullRequestState, ...result, error: null });
    } catch (error) {
      if (current()) this.publishPullRequests({ ...this.pullRequestState, error: pullRequestMessage(error) });
    } finally {
      if (current()) this.publishPullRequests({ ...this.pullRequestState, busy: false });
    }
  }
  async signOut() {
    if (this.timer) await this.flush();
    if (this.failed || this.saving) return;
    this.generation++;
    this.stopNotifications();
    this.unsubscribe?.();
    this.bridge.reset();
    await this.logout();
  }
  manageAccount() {
    this.account();
  }
  async deleteWorkspace(name: string) {
    await this.flush();
    if (!this.workspace || this.failed || this.saving) return;
    const workspace = this.workspace;
    await this.client.mutation(api.workspaces.deleteWorkspace, { workspace, name });
    this.workspaces = this.workspaces.filter(w => w.id !== workspace);
    this.choose();
  }
  async switchWorkspace(id: string) {
    await this.flush();
    if (this.failed || this.saving) return;
    const workspace = this.workspaces.find(w => w.id === id);
    if (!workspace) throw new Error('Workspace unavailable. Reload the workspace list.');
    await this.open(workspace.id);
  }
  async duplicateFile(file: string) {
    await this.flush();
    if (!this.workspace || this.failed || this.saving) return;
    await this.client.action(api.files.duplicate, { workspace: this.workspace, file });
  }
  async removeMember(id: string) {
    await this.flush();
    if (!this.workspace || !this.baseline || this.failed || this.saving) return;
    const member = this.baseline.members.find(m => m.id === id);
    if (!member || !confirm(`Remove ${member.name} from the workspace?`)) return;
    this.saving = true;
    this.bridge.status('Removing member…', true);
    try {
      await this.client.mutation(api.members.update, { workspace: this.workspace, before: JSON.stringify(member), after: null });
      this.accept(await this.client.query(api.workspaces.snapshot, { workspace: this.workspace }));
    } catch (error) {
      this.showError(error);
    } finally {
      this.saving = false;
    }
  }
  async download(file: string) {
    if (!this.workspace) return;
    const url = await this.client.query(api.files.download, { workspace: this.workspace, file });
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
  async upload(files: FileList | File[], project: string, task?: string) {
    const selected = Array.from(files);
    await this.flush();
    if (!this.workspace || this.failed || this.saving) return;
    const workspace = this.workspace;
    this.saving = true;
    this.bridge.status('Uploading…', true);
    try {
      for (const file of selected) {
        if (file.size > 25 * 1024 * 1024) throw new Error('Files must be 25 MB or smaller.');
        const url = await this.client.mutation(api.files.uploadUrl, { workspace, project });
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
        const { storageId } = z.object({ storageId: z.string() }).parse(await response.json());
        // Convex's generated ID validator validates the opaque storage ID on the server.
        await this.client.mutation(api.files.finish, {
          workspace,
          storage: storageId,
          file: JSON.stringify({
            id: crypto.randomUUID(),
            name: file.name,
            type: 'other',
            size: `${Math.ceil(file.size / 1024)} KB`,
            by: this.baseline!.me,
            at: Date.now(),
            project,
            task: task || null,
          }),
        });
      }
      this.accept(await this.client.query(api.workspaces.snapshot, { workspace }));
      this.bridge.status('Upload finished', false);
    } catch (error) {
      this.showError(error);
    } finally {
      this.saving = false;
    }
  }
}

export async function boot(bridge: Bridge) {
  const url = import.meta.env.VITE_CONVEX_URL,
    key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!url || !key) {
    bridge.reset();
    app().innerHTML =
      '<section class="team-gate"><h1>Connect your team workspace</h1><p>This app needs its Convex and Clerk configuration before anyone can sign in.</p><p>Set VITE_CONVEX_URL and VITE_CLERK_PUBLISHABLE_KEY, then follow the setup steps in the README.</p></section>';
    return;
  }
  try {
    bridge.status('Connecting…', true);
    const [{ Clerk }, { ui }] = await Promise.all([import('@clerk/clerk-js'), import('@clerk/ui')]);
    const clerk = new Clerk(key);
    await clerk.load({ ui });
    const client = new ConvexClient(url);
    const session = new TeamSession(
      client,
      bridge,
      async () => {
        await clerk.signOut();
        location.reload();
      },
      () => clerk.openUserProfile(),
    );
    let currentSession: string | null | undefined;
    clerk.addListener(({ session: auth }) => {
      if (currentSession === (auth?.id ?? null)) return;
      if (currentSession !== undefined) {
        location.reload();
        return;
      }
      currentSession = auth?.id ?? null;
      if (!auth) {
        bridge.reset();
        bridge.status('', false);
        app().innerHTML = '<section class="team-gate"><h1>Welcome to Lux</h1><p>Sign in to access your projects.</p><div id="team-sign-in"></div></section>';
        const signIn = document.getElementById('team-sign-in');
        if (!(signIn instanceof HTMLDivElement)) throw new Error('Sign-in container is missing.');
        clerk.mountSignIn(signIn, { routing: 'hash', forceRedirectUrl: location.origin });
        return;
      }
      let started = false;
      client.setAuth(
        async ({ forceRefreshToken }) => (await clerk.session?.getToken({ template: 'convex', skipCache: forceRefreshToken })) ?? null,
        authenticated => {
          if (!authenticated) {
            bridge.reset();
            bridge.status('Could not authenticate with the workspace server. Check your Clerk Convex integration.', false, true);
            return;
          }
          if (!started) {
            started = true;
            void session.start().catch(e => session.showError(e));
          }
        },
      );
    });
  } catch (error) {
    bridge.reset();
    bridge.status(message(error), false, true);
  }
}

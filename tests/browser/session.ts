import '../../src/app.js';
import { ConvexClient } from 'convex/browser';
import { TeamSession } from '../../src/cloud/session';
import { bridge } from '../../src/cloud/bridge.js';
import { z } from 'zod';
if (!import.meta.env.DEV || location.hostname !== '127.0.0.1') throw new Error('Local verification only');
const client = new ConvexClient('http://127.0.0.1:3210');
const session = new TeamSession(
  client,
  bridge,
  async () => {
    location.href = '/';
  },
  () => {},
);
let started = false;
client.setAuth(
  async () => {
    const user = new URLSearchParams(location.search).get('user') || 'owner';
    const result = await fetch('http://127.0.0.1:24102/token?user=' + encodeURIComponent(user));
    return z.object({ token: z.string() }).parse(await result.json()).token;
  },
  authenticated => {
    if (authenticated && !started) {
      started = true;
      void session.start().catch(error => session.showError(error));
    }
  },
);

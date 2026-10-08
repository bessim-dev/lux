import './app.js';
import { boot } from './cloud/session.ts';
import { bridge } from './cloud/bridge.js';
void boot(bridge);

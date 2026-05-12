# Pixel Agents Standalone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Pixel Agents from a VS Code extension to a standalone macOS app that runs in a browser tab, using a WebSocket bridge to replace `vscode.postMessage`.

**Architecture:** A single Node.js backend (`standalone/server.ts`) serves the built React UI over HTTP, exposes a WebSocket endpoint for bidirectional messages, runs the existing `AgentRunner` (SDK-based agents) and `PixelAgentsServer` (hook server), and loads pre-decoded assets from `dist/webview/assets/decoded/`. The webview gets two new files (`browserApi.ts`, modified `vscodeApi.ts`) — all other React code is untouched.

**Tech Stack:** Node.js `http`, `ws` (WebSocket), esbuild, existing React/Vite webview

---

## Task 1: Add `MessageSender` interface to HookEventHandler

**Files:**
- Modify: `server/src/hookEventHandler.ts`

This eliminates the `vscode.Webview` type dependency from `HookEventHandler`, letting the standalone backend pass a plain `{ postMessage }` object.

- [ ] **Step 1: Replace `vscode.Webview` with `MessageSender` interface**

```ts
// Add after the existing imports (after line 12), before the HookEvent interface:
/** Minimal interface for sending messages to the frontend.
 *  vscode.Webview satisfies this in the extension; the standalone
 *  backend passes a wrapper around its WebSocket broadcast. */
export interface MessageSender {
  postMessage(msg: unknown): void;
}
```

- [ ] **Step 2: Update constructor parameter type**

Change line 91 from:
```ts
private getWebview: () => vscode.Webview | undefined,
```
to:
```ts
private getWebview: () => MessageSender | undefined,
```

- [ ] **Step 3: Update all method parameter types**

Replace every `vscode.Webview | undefined` parameter type with `MessageSender | undefined` in the file. There are approximately 10 occurrences. Use a find-and-replace:

```
Find:    webview: vscode.Webview | undefined
Replace: webview: MessageSender | undefined
```

- [ ] **Step 4: Verify type-check passes**

```sh
npx tsc --noEmit -p server/tsconfig.json 2>&1 | head -20
```
Expected: no errors related to `hookEventHandler.ts`.

- [ ] **Step 5: Commit**

```sh
git add server/src/hookEventHandler.ts
git commit -m "refactor: replace vscode.Webview with MessageSender in HookEventHandler"
```

---

## Task 2: Create standalone settings persistence

**Files:**
- Create: `standalone/settings.ts`

Replaces VS Code's `globalState` for user preferences (sound, labels, hooks, watch-all, last-seen version, hooks info shown).

- [ ] **Step 1: Create the file**

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../src/constants.js';

export interface StandaloneSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  watchAllSessions: boolean;
}

const DEFAULTS: StandaloneSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  hooksEnabled: true,
  hooksInfoShown: false,
  watchAllSessions: false,
};

function getSettingsPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'settings.json');
}

export function readSettings(): StandaloneSettings {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const raw = fs.readFileSync(p, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(partial: Partial<StandaloneSettings>): StandaloneSettings {
  const current = readSettings();
  const next = { ...current, ...partial };
  const p = getSettingsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
  return next;
}
```

- [ ] **Step 2: Verify it compiles**

```sh
npx tsc --noEmit -p tsconfig.json standalone/settings.ts 2>&1 | head -10
```

- [ ] **Step 3: Commit**

```sh
git add standalone/settings.ts
git commit -m "feat: add standalone settings persistence"
```

---

## Task 3: Create WebSocket bridge

**Files:**
- Create: `standalone/wsBridge.ts`

Handles WebSocket message routing: browser→server dispatch and server→browser broadcast. This is the core piece that replaces VS Code's postMessage bridge.

- [ ] **Step 1: Create the file**

```ts
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export type WsHandler = (type: string, payload: Record<string, unknown>, ws: WebSocket) => void | Promise<void>;

const HEARTBEAT_MS = 30_000;

export function createWsBridge(
  httpServer: Parameters<typeof WebSocketServer>[0]['server'],
  onMessage: WsHandler,
  onConnect?: (ws: WebSocket) => void,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  // Heartbeat to detect dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if ((ws as WebSocket & { alive?: boolean }).alive === false) {
        ws.terminate();
        continue;
      }
      (ws as WebSocket & { alive?: boolean }).alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; [key: string]: unknown };
        const { type, ...payload } = msg;
        void onMessage(type, payload as Record<string, unknown>, ws);
      } catch {
        // ignore malformed JSON
      }
    });

    ws.on('error', () => { /* connection error, client will reconnect */ });

    onConnect?.(ws);
  });

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

/** Send a typed message to all connected clients. */
export function broadcast(wss: WebSocketServer, msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/** Send a typed message to a single client. */
export function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
```

- [ ] **Step 2: Verify ws package is available**

Check if `ws` is already a dependency:
```sh
node -e "require('ws')" && echo "ws exists" || echo "ws NOT found"
```
If NOT found, install it:
```sh
npm install --save ws
npm install --save-dev @types/ws
```

- [ ] **Step 3: Commit**

```sh
git add standalone/wsBridge.ts package.json package-lock.json
git commit -m "feat: add WebSocket bridge for standalone backend"
```

---

## Task 4: Create standalone server entry point

**Files:**
- Create: `standalone/server.ts`

The main entry point that ties everything together: HTTP server, WebSocket, AgentRunner, hook server, asset loading.

- [ ] **Step 1: Create the server file**

```ts
#!/usr/bin/env node
import * as fs from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

import { AgentRunner } from '../src/agentRunner.js';
import type { AgentRunnerEvent } from '../src/agentRunner.js';
import { allocateNextAgentId, readAgentsFile, removePersistedAgent, upsertAgent } from '../src/agentsPersistence.js';
import type { PersistedSDKAgent, SDKAgentState } from '../src/types.js';
import { AgentRole } from '../src/types.js';
import { HookEventHandler } from '../server/src/hookEventHandler.js';
import { installHooks, uninstallHooks } from '../server/src/providers/hook/claude/claudeHookInstaller.js';
import { claudeProvider, copyHookScript } from '../server/src/providers/index.js';
import { PixelAgentsServer } from '../server/src/server.js';
import { addWorkDirectory, readConfig, removeWorkDirectory, writeConfig } from '../src/configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../src/layoutPersistence.js';
import { getTranscriptPath, loadTranscript } from '../src/transcriptLoader.js';

import { broadcast, createWsBridge, send } from './wsBridge.js';
import type { StandaloneSettings } from './settings.js';
import { readSettings, writeSettings } from './settings.js';

const DEV = process.env.PIXEL_AGENTS_DEV === '1';
const PORT = parseInt(process.env.PIXEL_AGENTS_PORT ?? '4000', 10);
const DIST_DIR = path.resolve(__dirname, '..', 'webview');
const ASSETS_DIR = path.resolve(DIST_DIR, 'assets', 'decoded');
// copyHookScript expects the project root, then joins dist/hooks/claude-hook.js
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ── State ──────────────────────────────────────────────────────────────────────

const settings: StandaloneSettings = readSettings();
const legacyAgents = new Map<number, import('../src/types.js').AgentState>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const hookDeliveredAgents = new Set<number>();

// ── AgentRunner ────────────────────────────────────────────────────────────────

function pickDiversePalette(): { palette: number; hueShift: number } {
  const sdkAgents = agentRunner.getAllAgents();
  const counts = new Map<number, number>();
  for (const a of sdkAgents) {
    counts.set(a.palette, (counts.get(a.palette) ?? 0) + 1);
  }
  let bestPalette = 0;
  let bestCount = Infinity;
  for (let i = 0; i < 6; i++) {
    const c = counts.get(i) ?? 0;
    if (c < bestCount) { bestCount = c; bestPalette = i; }
  }
  const hueShift = sdkAgents.length >= 6 ? 45 + (Math.random() * 270) : 0;
  return { palette: bestPalette, hueShift };
}

let wss: ReturnType<typeof createWsBridge>;

const agentRunner = new AgentRunner((event: AgentRunnerEvent) => {
  // Buffer events are handled by the chat panel; just broadcast to all clients
  broadcast(wss, { type: 'agentRunnerEvent', event });
});

// ── Restore persisted agents ──────────────────────────────────────────────────

const file = readAgentsFile();
for (const persisted of file.agents) {
  const state = AgentRunner.fromPersistedAgent(persisted);
  agentRunner.addAgent(state);
}

// ── Hook server ────────────────────────────────────────────────────────────────

const hookEventHandler = new HookEventHandler(
  legacyAgents,
  waitingTimers,
  permissionTimers,
  // MessageSender: plain object wrapping WS broadcast
  () => ({ postMessage: (msg: unknown) => broadcast(wss, msg as Record<string, unknown>) }),
  claudeProvider,
  { current: settings.watchAllSessions },
);

hookEventHandler.setLifecycleCallbacks({
  onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
    // External sessions: hooks handle all tool state; no JSONL polling needed
    // Create a minimal AgentState so the existing hook infrastructure works
    const agentId = allocateNextAgentId();
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    legacyAgents.set(agentId, {
      id: agentId,
      sessionId,
      isExternal: true,
      projectDir,
      jsonlFile: transcriptPath ?? '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      hooksOnly: true,
    });
    broadcast(wss, { type: 'agentCreated', id: agentId, isExternal: true });
  },
  onSessionEnd: (agentId) => {
    legacyAgents.delete(agentId);
    broadcast(wss, { type: 'agentClosed', id: agentId });
  },
});

const hookServer = new PixelAgentsServer();
hookServer.onHookEvent((providerId, event) => {
  hookEventHandler.handleEvent(providerId, event);
});

// ── Asset loading ─────────────────────────────────────────────────────────────

function loadJsonAsset(filename: string): unknown {
  const p = path.join(ASSETS_DIR, filename);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function sendAllAssets(ws?: WebSocket): void {
  const sendFn = ws ? (msg: Record<string, unknown>) => send(ws, msg) : (msg: Record<string, unknown>) => broadcast(wss, msg);

  const characters = loadJsonAsset('characters.json');
  if (characters) sendFn({ type: 'characterSpritesLoaded', characters });

  const floors = loadJsonAsset('floors.json');
  if (floors) sendFn({ type: 'floorTilesLoaded', floors });

  const walls = loadJsonAsset('walls.json');
  if (walls) sendFn({ type: 'wallTilesLoaded', walls });

  const furniture = loadJsonAsset('furniture.json');
  if (furniture) sendFn({ type: 'furnitureAssetsLoaded', furniture });

  // Layout
  const layout = readLayoutFromFile();
  sendFn({ type: 'layoutLoaded', layout: layout ?? null, wasReset: false });
}

// ── Serve static HTML in production ────────────────────────────────────────────

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (DEV) return false;

  let url = req.url ?? '/';
  if (url === '/' || url === '') url = '/index.html';

  if (url === '/' || url === '/index.html') {
    const indexPath = path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(indexPath));
    return true;
  }

  // Serve other static files
  const filePath = path.join(DIST_DIR, url);
  if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
      '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
    return true;
  }

  // SPA fallback
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(indexPath));
    return true;
  }

  return false;
}

// ── WebSocket message dispatch ────────────────────────────────────────────────

async function handleMessage(type: string, payload: Record<string, unknown>, ws: WebSocket): Promise<void> {
  const reply = (msg: Record<string, unknown>) => send(ws, msg);

  switch (type) {
    case 'webviewReady': {
      // Send SDK agents
      const sdkAgents = agentRunner.getAllAgents().map(a => agentRunner.toPersistedAgent(a));
      reply({ type: 'sdkExistingAgents', agents: sdkAgents });
      // Send settings
      reply({ type: 'settingsLoaded',
        soundEnabled: settings.soundEnabled,
        lastSeenVersion: settings.lastSeenVersion,
        extensionVersion: '1.3.0',
        watchAllSessions: settings.watchAllSessions,
        alwaysShowLabels: settings.alwaysShowLabels,
        hooksEnabled: settings.hooksEnabled,
        hooksInfoShown: settings.hooksInfoShown,
        externalAssetDirectories: readConfig().externalAssetDirectories,
        workDirectories: readConfig().workDirectories,
        hasLegacyAgents: false,
        legacyAgentCount: 0,
      });
      // Send assets + layout
      sendAllAssets(ws);
      break;
    }

    case 'createAgent': {
      const { repoPath } = payload as { repoPath: string };
      const displayName = repoPath.split('/').pop() ?? repoPath;
      const id = allocateNextAgentId();
      const { palette, hueShift } = pickDiversePalette();
      const state: SDKAgentState = {
        id, repoPath, displayName, sessionId: null,
        role: 'generalist' as AgentRole, palette, hueShift, seatId: null,
        createdAt: Date.now(), currentModel: null, inputTokens: 0,
        sessionAllow: new Set(), errorCode: null, lastErrorMessage: null,
      };
      agentRunner.addAgent(state);
      upsertAgent(agentRunner.toPersistedAgent(state));
      const recentRepos = [...new Set(
        readAgentsFile().agents.map(a => a.repoPath).filter(Boolean)
      )].slice(0, 10);
      reply({ type: 'sdkAgentCreated', agent: agentRunner.toPersistedAgent(state), recentRepos });
      break;
    }

    case 'pickRecentRepo': {
      const { repoPath } = payload as { repoPath: string };
      const displayName = repoPath.split('/').pop() ?? repoPath;
      const id = allocateNextAgentId();
      const { palette, hueShift } = pickDiversePalette();
      const state: SDKAgentState = {
        id, repoPath, displayName, sessionId: null,
        role: 'generalist' as AgentRole, palette, hueShift, seatId: null,
        createdAt: Date.now(), currentModel: null, inputTokens: 0,
        sessionAllow: new Set(), errorCode: null, lastErrorMessage: null,
      };
      agentRunner.addAgent(state);
      upsertAgent(agentRunner.toPersistedAgent(state));
      reply({ type: 'sdkAgentCreated', agent: agentRunner.toPersistedAgent(state) });
      break;
    }

    case 'sendPrompt': {
      const { agentId, text } = payload as { agentId: number; text: string };
      void agentRunner.sendPrompt(agentId, text);
      break;
    }

    case 'interruptAgent': {
      const { agentId } = payload as { agentId: number };
      agentRunner.interrupt(agentId);
      break;
    }

    case 'permissionResponse': {
      const { requestId, allowed, always, agentId, toolName } = payload as {
        requestId: string; allowed: boolean; always: boolean; agentId: number; toolName: string;
      };
      if (always && allowed && toolName) agentRunner.addSessionAllow(agentId, toolName);
      agentRunner.resolvePermission(requestId, allowed);
      break;
    }

    case 'removeSdkAgent': {
      const { agentId } = payload as { agentId: number };
      agentRunner.removeAgent(agentId);
      removePersistedAgent(agentId);
      reply({ type: 'sdkAgentRemoved', agentId });
      break;
    }

    case 'agentRoleChanged': {
      const { agentId, role } = payload as { agentId: number; role: string };
      const agent = agentRunner.getAgent(agentId);
      if (agent) { agent.role = role as AgentRole; upsertAgent(agentRunner.toPersistedAgent(agent)); }
      break;
    }

    case 'openChatPanel': {
      const { agentId } = payload as { agentId: number };
      const agent = agentRunner.getAgent(agentId);
      if (agent?.sessionId) {
        const transcriptPath = getTranscriptPath(agent.repoPath, agent.sessionId);
        const { blocks, truncatedAt, error } = loadTranscript(transcriptPath);
        reply({ type: 'chatHistory', agentId, blocks, truncatedAt, error });
      } else {
        reply({ type: 'chatHistory', agentId, blocks: [] });
      }
      break;
    }

    case 'saveLayout': {
      writeLayoutToFile(payload.layout as Record<string, unknown>);
      break;
    }

    case 'saveAgentSeats': {
      // Seats persist via layout.json furniture placement — no separate storage needed
      break;
    }

    case 'setSoundEnabled': {
      writeSettings({ soundEnabled: payload.enabled as boolean });
      break;
    }

    case 'setLastSeenVersion': {
      writeSettings({ lastSeenVersion: payload.version as string });
      break;
    }

    case 'setAlwaysShowLabels': {
      writeSettings({ alwaysShowLabels: payload.enabled as boolean });
      break;
    }

    case 'setHooksEnabled': {
      const enabled = payload.enabled as boolean;
      writeSettings({ hooksEnabled: enabled });
      if (enabled) { installHooks(); copyHookScript(PROJECT_ROOT); }
      else { uninstallHooks(); }
      break;
    }

    case 'setHooksInfoShown': {
      writeSettings({ hooksInfoShown: true });
      break;
    }

    case 'setWatchAllSessions': {
      writeSettings({ watchAllSessions: payload.enabled as boolean });
      break;
    }

    case 'addExternalAssetDirectory': case 'removeExternalAssetDirectory': {
      // Not implemented in standalone MVP — asset dirs managed via config.json editing
      break;
    }

    case 'addWorkDirectory': {
      addWorkDirectory(payload.path as string);
      break;
    }

    case 'removeWorkDirectory': {
      removeWorkDirectory(payload.path as string);
      break;
    }

    case 'scanWorkDirectories': {
      const config = readConfig();
      const repos: string[] = [];
      for (const dir of config.workDirectories) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const subPath = path.join(dir, entry.name);
            if (fs.existsSync(path.join(subPath, '.git'))) repos.push(subPath);
          }
        } catch { /* skip unreadable dirs */ }
      }
      reply({ type: 'workDirectoriesScanned', repos });
      break;
    }

    case 'requestDiagnostics': {
      const diagnostics: Record<string, unknown>[] = [];
      for (const agent of agentRunner.getAllAgents()) {
        const jsonlFile = agent.sessionId ? getTranscriptPath(agent.repoPath, agent.sessionId) : '';
        let jsonlExists = false, fileSize = 0;
        try {
          if (jsonlFile) { const stat = fs.statSync(jsonlFile); jsonlExists = true; fileSize = stat.size; }
        } catch { /* file doesn't exist */ }
        diagnostics.push({ id: agent.id, repoPath: agent.repoPath, sessionId: agent.sessionId, jsonlFile, jsonlExists, fileSize });
      }
      reply({ type: 'agentDiagnostics', agents: diagnostics });
      break;
    }

    case 'openSessionsFolder': {
      // No-op in browser — user can browse ~/.claude/projects/ themselves
      break;
    }

    case 'exportDefaultLayout':
    case 'exportLayout':
    case 'importLayout':
    case 'browseRepo':
    case 'migrateLegacyAgents': {
      // No-ops for standalone (browser lacks native dialogs; no legacy agents to migrate)
      break;
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Start hook server
  await hookServer.start().then((config) => {
    if (settings.hooksEnabled) {
      installHooks();
      copyHookScript(PROJECT_ROOT);
    }
    console.log(`[Pixel Agents] Hook server ready on port ${config.port}`);
  }).catch(e => console.error('[Pixel Agents] Hook server start failed:', e));

  // Start HTTP server
  const httpServer = createServer((req, res) => {
    // CORS for dev mode
    if (DEV) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    if (!serveStatic(req, res)) {
      res.writeHead(404);
      res.end(DEV ? 'Dev mode: open http://localhost:5173 instead' : 'Not found');
    }
  });

  // Attach WebSocket
  wss = createWsBridge(httpServer, handleMessage, (ws) => {
    // On client connect: send current SDK agents
    const sdkAgents = agentRunner.getAllAgents().map(a => agentRunner.toPersistedAgent(a));
    send(ws, { type: 'sdkExistingAgents', agents: sdkAgents });
    // Send assets
    sendAllAssets(ws);
  });

  httpServer.listen(PORT, () => {
    console.log(`[Pixel Agents] Standalone server ready: http://localhost:${PORT}`);
    if (DEV) console.log('[Pixel Agents] Dev mode — open http://localhost:5173');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it compiles**

```sh
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "standalone/server" | head -10
```

- [ ] **Step 3: Commit**

```sh
git add standalone/server.ts
git commit -m "feat: add standalone server entry point"
```

---

## Task 5: Create browser WebSocket client

**Files:**
- Create: `webview-ui/src/browserApi.ts`

Replaces `acquireVsCodeApi()` when running in a browser. Connects WebSocket, buffers outgoing messages until the socket opens, dispatches incoming messages as `window 'message'` events.

- [ ] **Step 1: Create the file**

```ts
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${location.host}/ws`);
const sendQueue: unknown[] = [];

ws.onopen = () => {
  for (const msg of sendQueue) ws.send(JSON.stringify(msg));
  sendQueue.length = 0;
};

ws.onmessage = (event) => {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data as string) }));
};

ws.onerror = () => { /* connection error — client will retry on reload */ };
ws.onclose = () => { /* connection lost */ };

export const vscode = {
  postMessage: (msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      sendQueue.push(msg);
    }
  },
};
```

- [ ] **Step 2: Commit**

```sh
git add webview-ui/src/browserApi.ts
git commit -m "feat: add browser WebSocket client for standalone"
```

---

## Task 6: Modify vscodeApi.ts to delegate in browser

**Files:**
- Modify: `webview-ui/src/vscodeApi.ts`

When `isBrowserRuntime` is true, re-export from `browserApi.ts` instead of logging to console.

- [ ] **Step 1: Read the current file**

Current content:
```ts
import { isBrowserRuntime } from './runtime';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode: { postMessage(msg: unknown): void } = isBrowserRuntime
  ? { postMessage: (msg: unknown) => console.log('[vscode.postMessage]', msg) }
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });
```

- [ ] **Step 2: Replace with browserApi delegation**

```ts
import { isBrowserRuntime } from './runtime';
import { vscode as browserVscode } from './browserApi.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode: { postMessage(msg: unknown): void } = isBrowserRuntime
  ? browserVscode
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });
```

Vite dead-code-eliminates the `isBrowserRuntime` branch in VS Code builds (it's always false there). The static import means `browserApi.ts`'s WebSocket connects at app init; its internal send queue handles the timing gap before the socket opens.

- [ ] **Step 2: Verify the old behavior still works**

```sh
grep -r "from './vscodeApi" webview-ui/src/ --include="*.ts" --include="*.tsx"
```
Expected: imports all use `{ vscode }` — the export name and type haven't changed.

- [ ] **Step 3: Commit**

```sh
git add webview-ui/src/vscodeApi.ts
git commit -m "feat: delegate vscodeApi to WebSocket client in browser runtime"
```

---

## Task 7: Add Vite WebSocket proxy for dev mode

**Files:**
- Modify: `webview-ui/vite.config.ts`

In dev mode, Vite proxies `/ws` to the standalone backend so the browser WebSocket connects through Vite's dev server.

- [ ] **Step 1: Add server proxy to vite config**

Add inside the `defineConfig` return object, before `plugins`:

```ts
server: {
  proxy: {
    '/ws': {
      target: 'http://localhost:4000',
      ws: true,
    },
  },
},
```

The full config `defineConfig` call becomes:

```ts
export default defineConfig({
  plugins: [tailwindcss(), react(), browserMockAssetsPlugin()],
  server: {
    proxy: {
      '/ws': {
        target: 'http://localhost:4000',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
  },
  base: './',
});
```

- [ ] **Step 2: Commit**

```sh
git add webview-ui/vite.config.ts
git commit -m "feat: add WS proxy to Vite config for standalone dev mode"
```

---

## Task 8: Add standalone build to esbuild

**Files:**
- Modify: `esbuild.js`

Add a second build for the standalone backend entry point.

- [ ] **Step 1: Add standalone build to esbuild.js**

Add after the main extension build (after line 92), before `if (watch)`:

```js
// Standalone backend (separate entry point, no vscode external)
const standaloneCtx = await esbuild.context({
  entryPoints: ['standalone/server.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/standalone/server.js',
  external: ['@anthropic-ai/claude-agent-sdk'],
  logLevel: 'silent',
  plugins: [esbuildProblemMatcherPlugin],
});

if (watch) {
  await ctx.watch();
  await standaloneCtx.watch();
} else {
  await ctx.rebuild();
  await standaloneCtx.rebuild();
  await ctx.dispose();
  await standaloneCtx.dispose();
  copyAssets();
  buildHooks();
}
```

Note: the standalone build does NOT externalize `vscode` (since it doesn't import it). It DOES externalize `@anthropic-ai/claude-agent-sdk` (same as the extension) because the SDK relies on `import.meta.url` which breaks when bundled to CJS.

- [ ] **Step 2: Update the copyAssets path for hooks**

The hook script source for `copyHookScript` in standalone mode is `dist/hooks/claude-hook.js`. The `HOOK_SCRIPT_SRC` in `server.ts` points to `path.resolve(__dirname, '..', 'hooks', 'claude-hook.js')` which resolves correctly relative to `dist/standalone/server.js` → `dist/hooks/claude-hook.js`.

- [ ] **Step 3: Commit**

```sh
git add esbuild.js
git commit -m "feat: add standalone backend to esbuild pipeline"
```

---

## Task 9: Add scripts to package.json

**Files:**
- Modify: `package.json`

Add `build:backend` and `standalone` scripts.

- [ ] **Step 1: Add scripts**

In the `"scripts"` block, add:

```json
"build:backend": "node esbuild.js",
"standalone": "node dist/standalone/server.js"
```

- [ ] **Step 2: Commit**

```sh
git add package.json
git commit -m "feat: add standalone and build:backend scripts"
```

---

## Task 10: Create macOS launcher script

**Files:**
- Create: `scripts/start-standalone.sh`

Double-clickable `.command` file that starts the backend and opens the browser.

- [ ] **Step 1: Create the launcher**

```sh
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"
node dist/standalone/server.js &
sleep 1
open http://localhost:4000
wait
```

- [ ] **Step 2: Make it executable**

```sh
chmod +x scripts/start-standalone.sh
```

- [ ] **Step 3: Create a double-clickable .command file**

```sh
cp scripts/start-standalone.sh ~/Desktop/Pixel\ Agents.command
chmod +x ~/Desktop/Pixel\ Agents.command
```

- [ ] **Step 4: Commit**

```sh
git add scripts/start-standalone.sh
git commit -m "feat: add macOS launcher script for standalone"
```

---

## Task 11: Build and verify

- [ ] **Step 1: Full build**

```sh
npm run build
```
Expected: builds extension, webview, and standalone backend without errors.

- [ ] **Step 2: Verify output files exist**

```sh
ls -la dist/standalone/server.js dist/webview/index.html dist/webview/assets/decoded/characters.json
```
Expected: all three files exist.

- [ ] **Step 3: Start standalone backend**

```sh
node dist/standalone/server.js &
sleep 2
curl -s http://localhost:4000 | head -5
```
Expected: HTML content from the built webview.

- [ ] **Step 4: Open in browser and verify**

```sh
open http://localhost:4000
```

Manual verification checklist:
- [ ] Page loads without console errors
- [ ] WebSocket connects (no "Connection lost" in console)
- [ ] Office renders with default layout
- [ ] "+" button / Agent creation UI is visible
- [ ] Layout editor works

- [ ] **Step 5: Stop the backend**

```sh
kill %1
```

- [ ] **Step 6: Commit any final fixes**

```sh
git add -A
git commit -m "chore: final build verification fixes"
```

---

## Task 12: E2E smoke test

**Files:**
- Create: `standalone/__tests__/server.test.ts`

Basic smoke test that the server starts and WebSocket accepts connections.

- [ ] **Step 1: Create the test file**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';

const PORT = 14000; // test port, different from default
const URL = `ws://localhost:${PORT}`;

describe('standalone server', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn>;

  beforeAll(async () => {
    const { spawn } = await import('child_process');
    serverProcess = spawn('node', ['dist/standalone/server.js'], {
      env: { ...process.env, PIXEL_AGENTS_PORT: String(PORT) },
      stdio: 'pipe',
    });
    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10_000);
      serverProcess.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('ready')) { clearTimeout(timeout); resolve(); }
      });
      serverProcess.stderr?.on('data', (data: Buffer) => {
        console.error(data.toString());
      });
    });
  }, 15_000);

  afterAll(() => {
    serverProcess?.kill();
  });

  it('accepts WebSocket connections', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(URL);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connection timeout')); }, 5000);
      ws.on('open', () => { clearTimeout(timeout); ws.close(); resolve(); });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  });

  it('receives sdkExistingAgents on connect', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(URL);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('No message received')); }, 5000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'sdkExistingAgents') {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  });
});
```

- [ ] **Step 2: Run the smoke test**

```sh
cd standalone && npx vitest run --reporter=verbose
```
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```sh
git add standalone/__tests__/server.test.ts
git commit -m "test: add standalone server smoke test"
```

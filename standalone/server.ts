#!/usr/bin/env node
import * as fs from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { WebSocket } from 'ws';

import { AgentRunner } from '../src/agentRunner.js';
import type { AgentRunnerEvent } from '../src/agentRunner.js';
import { allocateNextAgentId, readAgentsFile, removePersistedAgent, upsertAgent } from '../src/agentsPersistence.js';
import type { AgentRole, SDKAgentState } from '../src/types.js';
import { HookEventHandler } from '../server/src/hookEventHandler.js';
import { installHooks, uninstallHooks } from '../server/src/providers/hook/claude/claudeHookInstaller.js';
import { claudeProvider, copyHookScript } from '../server/src/providers/index.js';
import { PixelAgentsServer } from '../server/src/server.js';
import { addWorkDirectory, readConfig, removeWorkDirectory } from '../src/configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../src/layoutPersistence.js';
import { getTranscriptPath, loadTranscript } from '../src/transcriptLoader.js';

import { broadcast, createWsBridge, send } from './wsBridge.js';
import type { StandaloneSettings } from './settings.js';
import { readSettings, writeSettings } from './settings.js';

const DEV = process.env.PIXEL_AGENTS_DEV === '1';
const PORT = parseInt(process.env.PIXEL_AGENTS_PORT ?? '4000', 10);
const DIST_DIR = path.resolve(__dirname, '..', 'webview');
const ASSETS_DIR = path.resolve(DIST_DIR, 'assets', 'decoded');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ── State ──────────────────────────────────────────────────────────────────────

const settings: StandaloneSettings = readSettings();
const legacyAgents = new Map<number, import('../src/types.js').AgentState>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

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
  () => ({ postMessage: (msg: unknown) => broadcast(wss, msg as Record<string, unknown>) }),
  claudeProvider,
  { current: settings.watchAllSessions },
);

hookEventHandler.setLifecycleCallbacks({
  onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
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
      inputTokens: 0,
      outputTokens: 0,
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
  hookEventHandler.handleEvent(providerId, event as import('../server/src/hookEventHandler.js').HookEvent);
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
  if (floors) sendFn({ type: 'floorTilesLoaded', sprites: floors });

  const walls = loadJsonAsset('walls.json');
  if (walls) sendFn({ type: 'wallTilesLoaded', sets: walls });

  const furnitureSprites = loadJsonAsset('furniture.json');
  const furnitureCatalog = loadJsonAsset('furniture-catalog.json');
  if (furnitureSprites && furnitureCatalog) {
    sendFn({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  }

  const layout = readLayoutFromFile();
  sendFn({ type: 'layoutLoaded', layout: layout ?? null, wasReset: false });
}

// ── Serve static HTML in production ────────────────────────────────────────────

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (DEV) return false;

  let url = req.url ?? '/';
  if (url === '/' || url === '') url = '/index.html';

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

  // SPA fallback: serve index.html for unknown paths
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
      const sdkAgents = agentRunner.getAllAgents().map(a => agentRunner.toPersistedAgent(a));
      reply({ type: 'sdkExistingAgents', agents: sdkAgents });
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

    case 'addExternalAssetDirectory':
    case 'removeExternalAssetDirectory': {
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

    case 'openSessionsFolder':
    case 'exportDefaultLayout':
    case 'exportLayout':
    case 'importLayout':
    case 'browseRepo':
    case 'migrateLegacyAgents': {
      break;
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await hookServer.start().then((config) => {
    if (settings.hooksEnabled) {
      installHooks();
      copyHookScript(PROJECT_ROOT);
    }
    console.log(`[Pixel Agents] Hook server ready on port ${config.port}`);
  }).catch(e => console.error('[Pixel Agents] Hook server start failed:', e));

  const httpServer = createServer((req, res) => {
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

  wss = createWsBridge(httpServer, handleMessage, (ws) => {
    const sdkAgents = agentRunner.getAllAgents().map(a => agentRunner.toPersistedAgent(a));
    send(ws, { type: 'sdkExistingAgents', agents: sdkAgents });
    sendAllAssets(ws);
  });

  httpServer.listen(PORT, () => {
    console.log(`[Pixel Agents] Standalone server ready: http://localhost:${PORT}`);
    if (DEV) console.log('[Pixel Agents] Dev mode — open http://localhost:5173');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

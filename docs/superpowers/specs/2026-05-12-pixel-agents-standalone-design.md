# Pixel Agents Standalone — Design Spec

Turn the VS Code extension into a standalone desktop app usable on macOS. The React
UI opens in a browser tab, a local Node.js process manages SDK-based agents + hook
server + WebSocket bridge, and a simple desktop launcher starts everything.

## Architecture

```
Browser tab (http://localhost:PORT)
     │
     │  WebSocket (replaces vscode.Webview.postMessage)
     │
     ▼
Standalone backend — single Node.js process
     │
     ├── AgentRunner (unchanged)       — SDK-based agent lifecycle
     ├── Hook server  (unchanged)      — HTTP server for Claude Code hook events
     ├── Transcript loader (unchanged) — chat history from JSONL files
     ├── Config/layout persistence (unchanged) — flat files in ~/.pixel-agents/
     └── Asset serving (simplified)    — pre-decoded JSON sent over WebSocket
```

**What the standalone backend uses:** `agentRunner.ts`, `server/`, `transcriptLoader.ts`,
`timerManager.ts`, `configPersistence.ts`, `layoutPersistence.ts`, `shared/assets/`,
entire `webview-ui/`.

**What the standalone backend does NOT use** (but stays in the repo — the VS Code
extension still needs them): `agentManager.ts` (terminal creation), `fileWatcher.ts`
(terminal adoption / JSONL polling / /clear heuristics), `transcriptParser.ts`
(JSONL line parsing for heuristic mode), `PixelAgentsViewProvider.ts`
(WebviewViewProvider), `extension.ts` (activate/deactivate), `repoPicker.ts`
(VS Code open dialog), `assetLoader.ts` (PNG decoding — backend sends pre-decoded
JSON over WebSocket instead).

**What's new:** Backend entry point, WebSocket message bridge, HTTP asset/UI server,
browser-side `postMessage` replacement, simple macOS launcher.

## Event Pipelines

Two parallel pipelines feed the webview. The webview doesn't know or care which
pipeline an event came from.

### Pipeline 1: SDK agents (created in-app)

```
User types prompt in browser
  → WebSocket → backend → agentRunner.sendPrompt()
  → SDK async generator yields messages
  → backend formats agentRunnerEvent → WebSocket → browser
```

Real-time. No polling. No timers. Permissions handled via SDK's `canUseTool` callback.

### Pipeline 2: External sessions (started in terminal elsewhere)

```
User runs `claude` in a terminal
  → claude-hook.js POSTs events to hook server
  → HookEventHandler creates agent on SessionStart
  → PreToolUse/PostToolUse hooks drive agentToolStart/agentToolDone
  → Notification hooks drive agentStatus (waiting bubbles)
  → backend posts all events → WebSocket → browser
```

No JSONL polling needed for character animations — hooks provide all 11 event types
including tool start/stop and notifications. JSONL polling (via a slimmed
`externalScanner.ts`) is only needed later for rich tool status text shown in the
hover overlay; this is deferred past MVP.

## New Components

### 1. Backend entry point (`standalone/server.ts`, ~200 lines)

```
- Start HTTP server (Express or bare Node http)
  - Serve webview-ui/dist/ as static files
  - Serve /assets/decoded/*.json from shared/assets/
- Start WebSocket server on same port
- Instantiate AgentRunner with callback that sends events over WS
- Start hook server (unchanged PixelAgentsServer)
- Instantiate HookEventHandler for external session lifecycle
  (hooks provide PreToolUse/PostToolUse/Notification — enough for character
  animations on external sessions; no JSONL polling needed for MVP)
- Accept these WS messages from browser:
  - createAgent, browseRepo, pickRecentRepo, sendPrompt, interruptAgent,
    permissionResponse, removeAgent, agentRoleChanged, openChatPanel,
    saveAgentSeats, saveLayout, exportLayout, importLayout,
    addExternalAssetDirectory, removeExternalAssetDirectory,
    addWorkDirectory, removeWorkDirectory, scanWorkDirectories,
    setSoundEnabled, setLastSeenVersion, setAlwaysShowLabels,
    setHooksEnabled, setHooksInfoShown, setWatchAllSessions,
    requestDiagnostics, openSessionsFolder, exportDefaultLayout,
    migrateLegacyAgents
- Settings/state stored as JSON files in ~/.pixel-agents/:
  - settings.json — sound, labels, hooks, watch-all, last-seen version
  - agents.json — persisted SDK agents (already implemented)
  - layout.json — office layout (already implemented)
  - config.json — external asset directories, work directories (already implemented)
- Port: default 4000, overridable via PIXEL_AGENTS_PORT env var
- The server injects the WebSocket port into the HTML page via a `<meta>` tag
  (`<meta name="ws-port" content="4000">`) so `browserApi.ts` can read it at
  connect time without hardcoding.
- In dev mode (`PIXEL_AGENTS_DEV=1`), the backend does NOT serve any static files or
  HTML. It only exposes the WebSocket endpoint on `/ws`. The Vite dev server is the
  sole HTTP server. This preserves HMR and avoids port conflicts.
- In production mode, the backend serves `dist/webview/` directly.
- WebSocket messages use the same JSON shape as today's postMessage protocol:
  `{ type: string, ... }`. Browser → server messages match the existing `message.type`
  cases in PixelAgentsViewProvider.ts. Server → browser messages match the existing
  `webview.postMessage(...)` calls. No format change — only transport changes.
- **Repo/folder picking in browser:** There is no native OS folder picker from a
  browser tab. Three options, all kept simple:
  1. **Work directory scanning** (primary) — the user configures work directories
     in Settings, the backend scans them for `.git` repos, results shown in the
     RepoPicker UI. Already implemented via `scanWorkDirectories`.
  2. **Recent repos** — repos the agent has used before, stored in agents.json.
     Already implemented via `pickRecentRepo`.
  3. **Manual path input** — a text field in the RepoPicker where the user types
     or pastes a repo path. Simple fallback, ~20 lines in the React UI.
  No OS folder picker. The three options above cover the use cases without
  requiring browser APIs or native shell integration.
```

### 2. WebSocket bridge (`standalone/wsBridge.ts`, ~100 lines)

```
Server side:
- ws.Server attached to HTTP server
- On connection: send current agent states (replay buffer)
- On message: route to appropriate handler (AgentRunner, config, layout, etc.)
- Broadcast agent events to all connected clients

Browser side (replaces webview-ui/src/vscodeApi.ts):
- When isBrowserRuntime: connect WebSocket to ws://localhost:PORT
- Export { postMessage } that calls ws.send(JSON.stringify(msg))
- Handle incoming messages: dispatch to same handlers that currently process
  window.addEventListener('message', ...) in useExtensionMessages.ts
```

### 3. Browser `postMessage` replacement (`webview-ui/src/browserApi.ts`)

```
Current flow:
  React → vscode.postMessage(msg) → VS Code → handler → webview.postMessage(msg')
  → window 'message' event → React state update

New flow (browser):
  React → ws.send(msg) → backend handler → ws.send(msg') → React state update

The webview already has isBrowserRuntime detection. Currently the fallback is
console.log. We replace that with a WebSocket client:

  const port = document.querySelector('meta[name="ws-port"]')?.getAttribute('content') ?? '4000';
  const ws = new WebSocket(`ws://localhost:${port}`);
  const sendQueue: unknown[] = [];

  ws.onopen = () => {
    // Flush any messages the app tried to send before the socket opened
    for (const msg of sendQueue) ws.send(JSON.stringify(msg));
    sendQueue.length = 0;
  };
  ws.onmessage = (event) => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
  };

  export const api = {
    postMessage: (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        sendQueue.push(msg);  // buffer until onopen fires
      }
    },
  };

All React components import { vscode } from './vscodeApi.js'. The import stays the
same; only the implementation changes. The existing window 'message' event listener
in useExtensionMessages.ts keeps working.

This buffer handles the timing gap: the React app renders and may call postMessage
(including `webviewReady`) before the WebSocket handshake completes. Messages are
queued and flushed when the socket opens. No React changes needed.
```

### 4. macOS launcher

Two approaches, pick one:

**A. Automator app / shell script** (simplest):
```
#!/bin/bash
cd /path/to/pixel-agents
node dist/standalone/server.js &
sleep 1
open http://localhost:4000
```
Saved as Pixel Agents.app via Automator or a `.command` file on the desktop.

**B. DMG with a proper .app bundle** (nicer):
Use `pkg` or `electron-builder` to wrap the Node.js server + build artifacts into
a `.app` that starts the server when double-clicked, opens the browser, and quits
the server when the browser tab closes. More work, nicer result.

Recommend starting with A and graduating to B.

### 5. Asset serving changes

Currently `assetLoader.ts` reads PNGs from disk using `pngjs` in the extension host,
decodes them to `SpriteData`, and sends them as base64 over postMessage. This was
necessary because VS Code webviews can't load local files directly.

In the standalone version, the Vite build already outputs pre-decoded sprites as JSON
to `dist/webview/assets/decoded/`. Instead of the browser fetching these over HTTP,
the backend reads them at startup and sends them over WebSocket using the exact same
message types the extension uses today:
- `characterSpritesLoaded` — character sprite data
- `floorTilesLoaded` — floor tile sprite data
- `wallTilesLoaded` — wall tile sprite data
- `furnitureAssetsLoaded` — furniture catalog + sprite data
- `layoutLoaded` — the saved office layout

This means **no changes to `useExtensionMessages.ts` or any React message handler.**
The webview receives assets through the same code path regardless of VS Code or
standalone. The only difference is transport (postMessage vs WebSocket), which is
fully contained in `vscodeApi.ts` / `browserApi.ts`.

Files to update: none for asset loading. Only `vscodeApi.ts` and `browserApi.ts`
change in the webview.

## Files to Keep, Drop, Create, and Modify

### Keep (unchanged)
| File | Reason |
|------|--------|
| `src/agentRunner.ts` | SDK agent lifecycle — zero VS Code deps |
| `src/agentsPersistence.ts` | Agent JSON file persistence — pure Node.js |
| `src/transcriptLoader.ts` | JSONL chat history — pure Node.js |
| `src/timerManager.ts` | Timer helpers imported by HookEventHandler |
| `src/types.ts` | Shared types, only type-imports vscode |
| `src/configPersistence.ts` | Flat-file config — pure Node.js |
| `src/layoutPersistence.ts` | Flat-file layout — pure Node.js, imports `ExtensionContext` only as type |
| `src/constants.ts` | All constants — pure |
| `server/` | Entire hook server — no VS Code deps |
| `shared/assets/` | Asset decode/build utilities — no VS Code deps |
| `webview-ui/src/office/` | Game engine, renderer, editor — no VS Code deps |
| `webview-ui/src/components/` | React components — no VS Code deps |
| `webview-ui/src/hooks/` | React hooks — no VS Code deps |
| `webview-ui/src/constants.ts` | Webview constants — pure |

### Drop
| File | Reason |
|------|--------|
| `src/agentManager.ts` | Terminal creation, terminal restoration — all VS Code |
| `src/fileWatcher.ts` | Terminal adoption, heuristic /clear scanning — hooks replace it |
| `src/extension.ts` | Extension activate/deactivate |
| `src/PixelAgentsViewProvider.ts` | VS Code WebviewViewProvider, message dispatch — new backend replaces it |
| `src/repoPicker.ts` | VS Code Open Dialog for folder picking |
| `src/preflight.ts` | VS Code output channel for diagnostics |

### Create
| File | Lines | Purpose |
|------|-------|---------|
| `standalone/server.ts` | ~200 | Entry point: HTTP, WS, AgentRunner, hook server, asset loading |
| `standalone/wsBridge.ts` | ~80 | WebSocket message routing: browser→server dispatch, server→browser broadcast |
| `webview-ui/src/browserApi.ts` | ~25 | WebSocket client replacing acquireVsCodeApi |
| `scripts/start-standalone.sh` | ~15 | Shell launcher: start backend, open browser |
| `standalone/settings.ts` | ~50 | JSON file read/write for user settings (replaces globalState) |

Deferred past MVP:
| `standalone/externalScanner.ts` | ~80 | JSONL scanner for rich tool status text on external sessions |

### Modify (minor)
| File | Change |
|------|--------|
| `webview-ui/src/vscodeApi.ts` | When `isBrowserRuntime`, import and re-export from `browserApi.ts` |
| `webview-ui/vite.config.ts` | Add proxy for WS in dev mode |
| `package.json` | Add `"standalone": "..."` and `"build:backend": "..."` scripts |
| `esbuild.js` | Add entry point for standalone backend bundle |
| `server/src/hookEventHandler.ts` | Replace `vscode.Webview` with `MessageSender` interface (already has a TODO for this). The `MessageSender` is just `{ postMessage(msg: unknown): void }`. The extension passes `vscode.Webview` (which satisfies this shape); the standalone passes a wrapper around `wsBroadcast`. No runtime change. |

Note: `timerManager.ts` and `types.ts` currently live in `src/` and are imported by
`server/src/hookEventHandler.ts` via `../../src/`. This cross-boundary import works
for the standalone esbuild bundle; no file moves needed for MVP. The existing TODOs
in that file suggest moving them to `server/src/` eventually, which can happen when
the terminal agent path is deleted.

## Build & Run

### Development
```
npm install && npm run build:backend   # esbuild standalone + server, skip Vite
cd webview-ui && npm run dev           # Vite with HMR on :5173
# In separate terminal:
PIXEL_AGENTS_DEV=1 node dist/standalone/server.js  # backend WS on :4000
open http://localhost:5173             # Vite proxies /ws to :4000
```
A `build:backend` script is added to `package.json` that runs esbuild for
`standalone/server.ts`, `standalone/wsBridge.ts`, etc. without touching the webview.

### Production
```
npm run build
npm run standalone           # starts backend on :4000, serves built webview
open http://localhost:4000
```

In dev mode (`PIXEL_AGENTS_DEV=1`), the backend skips static file serving and adds
CORS headers. The Vite dev server is the primary HTTP server, and Vite's dev proxy
(forwards `/ws` to the backend) is configured in `vite.config.ts`. This preserves
HMR for the React UI during development.

In production mode, the backend serves `dist/webview/` directly — no Vite needed.
The WebSocket and HTTP share the same port (browsers allow this; the WS upgrade
happens on the same connection).

## Migration Path

This doesn't break the VS Code extension. The new files live in `standalone/` and
`browserApi.ts` is only loaded in browser runtime. The extension continues to work
via the existing code paths.

Once standalone is stable, the legacy terminal agent path can be fully deleted
(`agentManager.ts`, `fileWatcher.ts`), and `PixelAgentsViewProvider.ts` can be
simplified to only handle VS Code-specific concerns (webview hosting, workspace state).
The shared logic (AgentRunner, hook handling, external scanning) moves to the
standalone backend and the extension imports it from there.

## Platform Notes (macOS)

- Hook script (`claude-hook.js`) already works on macOS via the existing install path
- File watching for external sessions uses `fs.watch` + polling fallback (already
  implemented for cross-platform support)
- Port 4000 is not privileged on macOS — no special permissions needed
- `.command` files are double-clickable in Finder and auto-execute in Terminal

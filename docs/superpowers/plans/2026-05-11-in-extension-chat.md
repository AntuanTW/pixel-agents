# In-Extension Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the terminal-based agent system with an in-extension chat panel powered by `@anthropic-ai/claude-agent-sdk`, enabling multi-repo Claude agents with streaming chat, history, and permission control — all inside the pixel office.

**Architecture:** `AgentRunner` (extension host) owns the SDK lifecycle. Each `sendPrompt()` call drives a `for await` loop over the SDK's `Query` AsyncGenerator, forwarding SDK events as postMessages to the React webview. `agents.json` (user-level, atomic writes) replaces `workspaceState`. `ChatPanel` React component renders blocks streamed from the extension. Permission requests pause `canUseTool` via stored Promise resolvers until the user responds in the panel.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` v0.2.x (wraps local `claude` CLI, inherits MAX subscription), VS Code extension API (`showOpenDialog`, `postMessage`), React + TypeScript webview, Vitest (server `__tests__`), Extension Dev Host (manual testing for VS Code API code).

---

## File Map

**New files:**
- `src/utils/execFileNoThrow.ts` — safe `execFile` wrapper (no shell expansion)
- `src/agentsPersistence.ts` — `agents.json` I/O with atomic writes
- `src/preflight.ts` — `claude --version` check + hook installer on activation
- `src/agentRunner.ts` — SDK wrapper: per-agent turn queues, event dispatch, error classification
- `src/repoPicker.ts` — VS Code dialog wrapper + recent-repos logic
- `src/transcriptLoader.ts` — parse existing JSONL file into ChatBlock array for panel open
- `webview-ui/src/components/ChatPanel.tsx` — slide-in panel (~420px), full webview height
- `webview-ui/src/components/ChatBlocks.tsx` — individual block renderers (text/tool/thinking/error/queued)
- `webview-ui/src/hooks/useChatState.ts` — accumulates SDK events per agent into render state
- `scripts/phase0-sdk-validate.ts` — throwaway Phase 0 smoke test

**Modified files:**
- `package.json` — add `@anthropic-ai/claude-agent-sdk` dependency
- `src/types.ts` — add `SDKAgentState`, `PersistedSDKAgent`, `AgentsFile`, `AgentRole`, `SDKAgentErrorCode`
- `src/constants.ts` — add `AGENTS_FILE_NAME`, `RECENT_REPOS_LIMIT`, `SAFE_TOOLS`, `MODEL_CONTEXT_LIMITS`, `DEFAULT_CONTEXT_LIMIT`, `ROLE_PROMPTS`, `CHAT_EVENT_BUFFER_MAX`
- `src/configPersistence.ts` — add `recentRepos: string[]` field
- `src/PixelAgentsViewProvider.ts` — integrate `AgentRunner`, route new webview messages
- `server/src/providers/hook/claude/hooks/claude-hook.ts` — forward `PIXEL_AGENTS_ID` env var in POST body
- `server/src/hookEventHandler.ts` — prefer `pixel_agents_id` routing over `session_id`
- `webview-ui/src/hooks/useExtensionMessages.ts` — handle new `chatEvent`, `agentError`, `permissionRequest`, `chatHistory`, `repoBrowseResult` messages
- `webview-ui/src/App.tsx` — add `ChatPanel`, `RepoPicker` overlay, migration banner
- `webview-ui/src/office/engine/officeState.ts` — add `errorCode`, `inputTokens` per-agent for token bar + error overlay

**Phase 3 cleanup (slim/delete):**
- `src/agentManager.ts` — remove terminal-lifecycle exports (keep file for any retained helpers)
- `src/fileWatcher.ts` — remove heuristic polling; keep `readTranscriptLines` helper only

---

## Task 1: Phase 0 — SDK validation (throwaway script)

**Files:**
- Create: `scripts/phase0-sdk-validate.ts`

Run this BEFORE writing any Phase 1 code. It validates five SDK capabilities the rest of the plan depends on. If anything fails, stop and reassess.

- [ ] **Step 1: Install the SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk
```

Expected: package added to `node_modules/`, `package.json` updated with `dependencies` entry.

- [ ] **Step 2: Write the validation script**

```typescript
// scripts/phase0-sdk-validate.ts
// Run: npx tsx scripts/phase0-sdk-validate.ts
// Purpose: validate SDK assumptions before building Phase 1.
// DELETE this file after Phase 0 passes.
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as os from 'os';

const tmpDir = os.tmpdir();
let pass = 0;
let fail = 0;

function ok(label: string): void { console.log(`✅ ${label}`); pass++; }
function err(label: string, e: unknown): void { console.error(`❌ ${label}:`, e); fail++; }

// ── Test 1: auth (no env vars → uses MAX subscription) ──────────
try {
  console.log('\n[1] Auth: query with no env vars (should use MAX subscription)...');
  let session = '';
  const q1 = query({ prompt: 'respond with the single word OK', options: { cwd: tmpDir } });
  for await (const msg of q1) {
    if (msg.type === 'system' && 'session_id' in msg) {
      session = (msg as { session_id: string }).session_id;
    }
    if (msg.type === 'result' && msg.subtype === 'success') {
      ok(`Auth: got result, session_id=${session.slice(0, 8)}...`);
    }
  }

  // ── Test 2: resume ───────────────────────────────────────────
  if (session) {
    console.log('\n[2] Resume: second query with resume session_id...');
    const q2 = query({ prompt: 'respond with the word RESUMED', options: { cwd: tmpDir, resume: session } });
    for await (const msg of q2) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        ok('Resume: completed second turn');
      }
    }
  }
} catch (e) { err('Auth/Resume', e); }

// ── Test 3: env propagation ──────────────────────────────────────
try {
  console.log('\n[3] Env: PIXEL_AGENTS_ID should reach hook script env...');
  const q3 = query({
    prompt: 'respond with the word ENVTEST',
    options: { cwd: tmpDir, env: { PIXEL_AGENTS_ID: 'test-42' } },
  });
  for await (const msg of q3) {
    if (msg.type === 'result' && msg.subtype === 'success') {
      ok('Env: query with env completed (verify PIXEL_AGENTS_ID in server logs)');
    }
  }
} catch (e) { err('Env propagation', e); }

// ── Test 4: interrupt ────────────────────────────────────────────
try {
  console.log('\n[4] Interrupt: call q.interrupt() mid-stream...');
  const q4 = query({ prompt: 'count from 1 to 1000 slowly', options: { cwd: tmpDir } });
  let events = 0;
  for await (const msg of q4) {
    events++;
    if (events === 2) {
      q4.interrupt();
      break;
    }
  }
  ok(`Interrupt: stopped after ${events} events`);
} catch (e) { err('Interrupt', e); }

// ── Test 5: async canUseTool ─────────────────────────────────────
try {
  console.log('\n[5] canUseTool: async callback should resolve before tool runs...');
  let callbackFired = false;
  const q5 = query({
    prompt: 'list files in the current directory using the LS tool',
    options: {
      cwd: tmpDir,
      canUseTool: async (toolName: string) => {
        callbackFired = true;
        console.log(`   canUseTool called for: ${toolName}`);
        return true; // approve
      },
    },
  });
  for await (const msg of q5) {
    if (msg.type === 'result') break;
  }
  if (callbackFired) ok('canUseTool: async callback fired');
  else err('canUseTool', 'callback never fired — tool may not have been called');
} catch (e) { err('canUseTool', e); }

console.log(`\n── Phase 0 result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 3: Run it**

```bash
npx tsx scripts/phase0-sdk-validate.ts
```

Expected output: 5 green ✅ lines. If any ❌ appears, stop and fix the assumption before continuing.

- [ ] **Step 4: Record any surprises**

Note: if `systemPrompt` field was missing from `Options`, roles fall back to generalist (no behavior change). Log that finding in a comment in `src/agentRunner.ts`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/phase0-sdk-validate.ts
git commit -m "chore: add claude-agent-sdk, phase 0 validation script"
```

---

## Task 2: Types and constants scaffold

**Files:**
- Modify: `src/types.ts`
- Modify: `src/constants.ts`

- [ ] **Step 1: Add new types to `src/types.ts`**

Append at the bottom of the file (after existing `PersistedAgent`):

```typescript
// ── SDK-based agents (in-extension chat) ─────────────────────────

export type AgentRole = 'generalist' | 'coder' | 'designer' | 'writer' | 'reviewer';

export type SDKAgentErrorCode =
  | 'auth_failed'
  | 'binary_missing'
  | 'cwd_missing'
  | 'process_crash'
  | 'session_not_found'
  | 'unknown';

/** Runtime state (in-memory only, not persisted). */
export interface SDKAgentState {
  id: number;
  repoPath: string;
  displayName: string;
  sessionId: string | null;
  role: AgentRole;
  palette: number;
  hueShift: number;
  seatId: string | null;
  createdAt: number;
  // Runtime fields:
  currentModel: string | null;
  inputTokens: number;        // from most recent ResultMessage
  sessionAllow: Set<string>;  // per-session tool allowlist (cleared on new session)
  errorCode: SDKAgentErrorCode | null;
  lastErrorMessage: string | null;
}

/** What gets written to agents.json. */
export interface PersistedSDKAgent {
  id: number;
  repoPath: string;
  displayName: string;
  sessionId: string | null;
  role: AgentRole;
  palette: number;
  hueShift: number;
  seatId: string | null;
  createdAt: number;
}

/** Root structure of agents.json. */
export interface AgentsFile {
  version: 1;
  agents: PersistedSDKAgent[];
  nextAgentId: number;
}

/** Chat block types for the webview panel. */
export type ChatBlock =
  | { blockType: 'user-text'; id: string; text: string }
  | { blockType: 'assistant-text'; id: string; text: string }
  | { blockType: 'thinking'; id: string; text: string }
  | { blockType: 'tool-use'; id: string; toolId: string; toolName: string; input: unknown; result?: unknown; isError?: boolean }
  | { blockType: 'error'; id: string; code: SDKAgentErrorCode; message: string }
  | { blockType: 'queued'; id: string; text: string };
```

- [ ] **Step 2: Add new constants to `src/constants.ts`**

Append at the bottom of the file:

```typescript
// ── SDK Agent persistence ────────────────────────────────────────
export const AGENTS_FILE_NAME = 'agents.json';
export const RECENT_REPOS_LIMIT = 10;

// ── Tool permission ──────────────────────────────────────────────
export const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead',
]);

// ── Model context limits (inputTokens divisor for token bar) ─────
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-7': 200_000,
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};
export const DEFAULT_CONTEXT_LIMIT = 200_000;

// ── Role system prompts ──────────────────────────────────────────
export const ROLE_PROMPTS: Record<string, string | null> = {
  generalist: null,
  coder: 'Focus on code changes and tests. Prefer small focused diffs. Run tests after edits.',
  designer: 'Focus on UI/UX. Read existing components before proposing changes. Match existing styles.',
  writer: 'Focus on prose: docs, copy, READMEs. No code changes unless asked. Match the project\'s voice.',
  reviewer: 'Read first, propose changes second. Identify risks, missing tests, edge cases. Default to suggesting, not editing.',
};

// ── Chat event buffer (max events held when panel is closed) ─────
export const CHAT_EVENT_BUFFER_MAX = 500;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run check-types
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/constants.ts
git commit -m "feat: add SDK agent types and constants"
```

---

## Task 3: execFileNoThrow utility

**Files:**
- Create: `src/utils/execFileNoThrow.ts`

This is a safe wrapper around Node's `execFile` that never throws. Using `execFile` (not `exec` or `execSync`) prevents shell injection because arguments are passed as an array, not interpolated into a shell command.

- [ ] **Step 1: Create the utility**

First create the directory:
```bash
mkdir -p /Users/antoine/Documents/Work/pixel-agents/src/utils
```

Then create `src/utils/execFileNoThrow.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ExecFileResult {
  status: 0 | 1;
  stdout: string;
  stderr: string;
}

/**
 * Runs `file` with `args` (no shell expansion). Never throws.
 * Returns status 0 on success, 1 on any failure.
 */
export async function execFileNoThrow(
  file: string,
  args: string[],
): Promise<ExecFileResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 5000 });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { status: 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run check-types
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/execFileNoThrow.ts
git commit -m "feat: add execFileNoThrow utility"
```

---

## Task 4: agents.json persistence

**Files:**
- Create: `src/agentsPersistence.ts`

Follows the same atomic tmp+rename pattern as `configPersistence.ts` and `layoutPersistence.ts`.

- [ ] **Step 1: Create `src/agentsPersistence.ts`**

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AGENTS_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';
import type { AgentsFile, PersistedSDKAgent } from './types.js';

const EMPTY_FILE: AgentsFile = { version: 1, agents: [], nextAgentId: 1 };

function getAgentsFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, AGENTS_FILE_NAME);
}

export function readAgentsFile(): AgentsFile {
  const filePath = getAgentsFilePath();
  try {
    if (!fs.existsSync(filePath)) return { ...EMPTY_FILE };
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as AgentsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
      return { ...EMPTY_FILE };
    }
    return parsed;
  } catch {
    return { ...EMPTY_FILE };
  }
}

export function writeAgentsFile(data: AgentsFile): void {
  const filePath = getAgentsFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Upsert an agent entry and write atomically. */
export function upsertAgent(agent: PersistedSDKAgent): void {
  const data = readAgentsFile();
  const idx = data.agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) {
    data.agents[idx] = agent;
  } else {
    data.agents.push(agent);
  }
  writeAgentsFile(data);
}

/** Remove an agent entry and write atomically. */
export function removePersistedAgent(agentId: number): void {
  const data = readAgentsFile();
  data.agents = data.agents.filter((a) => a.id !== agentId);
  writeAgentsFile(data);
}

/** Allocate and persist the next agent ID, return it. */
export function allocateNextAgentId(): number {
  const data = readAgentsFile();
  const id = data.nextAgentId;
  data.nextAgentId = id + 1;
  writeAgentsFile(data);
  return id;
}

/** Update only the sessionId for an agent (called when SDK emits init SystemMessage). */
export function updateAgentSessionId(agentId: number, sessionId: string | null): void {
  const data = readAgentsFile();
  const agent = data.agents.find((a) => a.id === agentId);
  if (agent) {
    agent.sessionId = sessionId;
    writeAgentsFile(data);
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run check-types
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test (optional)**

```bash
npx tsx -e "
import { readAgentsFile, upsertAgent, removePersistedAgent } from './src/agentsPersistence.js';
console.log('empty:', readAgentsFile());
upsertAgent({ id:1, repoPath:'/tmp', displayName:'test', sessionId:null, role:'generalist', palette:0, hueShift:0, seatId:null, createdAt:Date.now() });
console.log('after upsert:', readAgentsFile());
removePersistedAgent(1);
console.log('after remove:', readAgentsFile());
"
```

- [ ] **Step 4: Commit**

```bash
git add src/agentsPersistence.ts
git commit -m "feat: add agents.json persistence"
```

---

## Task 5: Config — add recentRepos

**Files:**
- Modify: `src/configPersistence.ts`

- [ ] **Step 1: Extend the config interface and read/write**

```typescript
// src/configPersistence.ts — full replacement
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR, RECENT_REPOS_LIMIT } from './constants.js';

interface PixelAgentsConfig {
  externalAssetDirectories: string[];
  recentRepos: string[];
}

const DEFAULT_CONFIG: PixelAgentsConfig = {
  externalAssetDirectories: [],
  recentRepos: [],
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return {
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      recentRepos: Array.isArray(parsed.recentRepos)
        ? parsed.recentRepos.filter((r): r is string => typeof r === 'string')
        : [],
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config: PixelAgentsConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}

/** Push repoPath to the top of recentRepos, cap at RECENT_REPOS_LIMIT. */
export function addRecentRepo(repoPath: string): void {
  const config = readConfig();
  const filtered = config.recentRepos.filter((r) => r !== repoPath);
  config.recentRepos = [repoPath, ...filtered].slice(0, RECENT_REPOS_LIMIT);
  writeConfig(config);
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npm run check-types
```

Expected: no errors. Check that all existing callers of `readConfig`/`writeConfig` still work (they don't use `recentRepos` yet, so no changes needed).

- [ ] **Step 3: Commit**

```bash
git add src/configPersistence.ts
git commit -m "feat: add recentRepos to config"
```

---

## Task 6: Preflight check

**Files:**
- Create: `src/preflight.ts`

Runs once on activation. Uses `execFileNoThrow` (no shell expansion, safe). Result cached in memory.

- [ ] **Step 1: Create `src/preflight.ts`**

```typescript
import { claudeHookInstaller } from '../server/src/providers/hook/claude/claudeHookInstaller.js';
import { execFileNoThrow } from './utils/execFileNoThrow.js';

export interface PreflightResult {
  binaryOk: boolean;
  hooksOk: boolean;
  errors: string[];    // error codes: 'binary_missing' | 'binary_error' | 'hooks_failed'
}

let cached: PreflightResult | null = null;

export async function runPreflight(
  outputChannel: { appendLine(s: string): void },
): Promise<PreflightResult> {
  if (cached) return cached;
  const errors: string[] = [];

  // Check 1: claude binary present
  const versionResult = await execFileNoThrow('claude', ['--version']);
  if (versionResult.status !== 0) {
    errors.push(versionResult.stderr.includes('not found') ? 'binary_missing' : 'binary_error');
    outputChannel.appendLine(
      `[Pixel Agents] Preflight: claude binary check failed: ${versionResult.stderr}`,
    );
  }

  // Check 2: hook installer (idempotent, best-effort)
  let hooksOk = true;
  try {
    await claudeHookInstaller.installHook();
  } catch (err) {
    hooksOk = false;
    errors.push('hooks_failed');
    outputChannel.appendLine(`[Pixel Agents] Preflight: hook installer failed: ${String(err)}`);
  }

  cached = { binaryOk: errors.every((e) => e !== 'binary_missing' && e !== 'binary_error'), hooksOk, errors };
  return cached;
}

export function clearPreflightCache(): void {
  cached = null;
}
```

> **Note on import path:** Check the actual import path for `claudeHookInstaller` in the extension. It may be `'../server/src/providers/hook/claude/claudeHookInstaller.js'` or the server may expose it differently. Adjust if needed — the installer already exists and is used in `PixelAgentsViewProvider.ts`.

- [ ] **Step 2: Verify the import path**

```bash
grep -r "claudeHookInstaller" /Users/antoine/Documents/Work/pixel-agents/src/ --include="*.ts"
```

Copy the import path from `PixelAgentsViewProvider.ts` and use it in `preflight.ts`.

- [ ] **Step 3: Verify TypeScript**

```bash
npm run check-types
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/preflight.ts
git commit -m "feat: add preflight check"
```

---

## Task 7: AgentRunner

**Files:**
- Create: `src/agentRunner.ts`

The heart of the system. Note: in Phase 1, `canUseTool` is **not set** — the SDK uses the user's own Claude Code permission settings. Phase 2 wires up the full permission flow.

- [ ] **Step 1: Create `src/agentRunner.ts`**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

import { ROLE_PROMPTS } from './constants.js';
import { updateAgentSessionId, upsertAgent } from './agentsPersistence.js';
import type { AgentRole, AgentsFile, PersistedSDKAgent, SDKAgentErrorCode, SDKAgentState } from './types.js';

// SDK message types (inferred from sdk.d.ts)
interface SDKSystemMessage { type: 'system'; subtype: string; session_id?: string; model?: string }
interface SDKAssistantMessage { type: 'assistant'; message: { content: ContentBlock[]; model?: string } }
interface SDKUserMessage { type: 'user'; message: unknown }
interface SDKResultSuccess {
  type: 'result'; subtype: 'success';
  usage: { inputTokens: number; outputTokens: number };
  model?: string;
}
interface SDKResultError { type: 'result'; subtype: 'error_max_turns' | string }
type SDKMessage = SDKSystemMessage | SDKAssistantMessage | SDKUserMessage | SDKResultSuccess | SDKResultError;

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

// Events emitted by AgentRunner to be forwarded to the webview
export type AgentRunnerEvent =
  | { kind: 'sdkMessage'; agentId: number; msg: SDKMessage }
  | { kind: 'turnDone'; agentId: number; inputTokens: number; outputTokens: number; model: string }
  | { kind: 'error'; agentId: number; code: SDKAgentErrorCode; message: string; retryable: boolean }
  | { kind: 'queued'; agentId: number; queueLength: number }
  | { kind: 'sessionId'; agentId: number; sessionId: string };

type EventCallback = (event: AgentRunnerEvent) => void;

// Query type from SDK (AsyncGenerator with interrupt)
type SDKQuery = AsyncGenerator<SDKMessage, void> & { interrupt(): void };

export class AgentRunner {
  private agents = new Map<number, SDKAgentState>();
  private inflight = new Map<number, SDKQuery>();
  private queues = new Map<number, string[]>();

  constructor(private onEvent: EventCallback) {}

  /** Add a newly created agent. */
  addAgent(state: SDKAgentState): void {
    this.agents.set(state.id, state);
  }

  /** Get agent state by id. */
  getAgent(id: number): SDKAgentState | undefined {
    return this.agents.get(id);
  }

  /** Get all agents. */
  getAllAgents(): SDKAgentState[] {
    return [...this.agents.values()];
  }

  /** Interrupt the in-flight turn for an agent (cancels queue too). */
  interrupt(agentId: number): void {
    const q = this.inflight.get(agentId);
    if (q) {
      q.interrupt();
      this.inflight.delete(agentId);
    }
    this.queues.delete(agentId);
  }

  /** Remove agent from runtime. Interrupts any in-flight turn first. */
  removeAgent(agentId: number): void {
    this.interrupt(agentId);
    this.agents.delete(agentId);
  }

  /**
   * Send a prompt to an agent. If a turn is in flight, queues the prompt.
   * In Phase 2, `canUseTool` will be wired here.
   */
  async sendPrompt(agentId: number, text: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (this.inflight.has(agentId)) {
      const queue = this.queues.get(agentId) ?? [];
      queue.push(text);
      this.queues.set(agentId, queue);
      this.onEvent({ kind: 'queued', agentId, queueLength: queue.length });
      return;
    }

    void this.runTurn(agentId, text);
  }

  private async runTurn(agentId: number, prompt: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const rolePrompt = ROLE_PROMPTS[agent.role];
    const options: Record<string, unknown> = {
      cwd: agent.repoPath,
      env: { PIXEL_AGENTS_ID: String(agentId) },
    };
    if (agent.sessionId) options.resume = agent.sessionId;
    if (rolePrompt) options.systemPrompt = rolePrompt;
    // NOTE: canUseTool is added in Phase 2

    const q = query({ prompt, options }) as SDKQuery;
    this.inflight.set(agentId, q);

    try {
      for await (const msg of q) {
        if (!this.inflight.has(agentId)) break; // interrupted
        this.dispatchSDKMessage(agentId, agent, msg);
      }
    } catch (err) {
      const code = this.classifyError(err);
      const message = String(err);
      this.onEvent({ kind: 'error', agentId, code, message, retryable: code !== 'binary_missing' });

      if (code === 'session_not_found') {
        agent.sessionId = null;
        updateAgentSessionId(agentId, null);
      }
    } finally {
      this.inflight.delete(agentId);
      agent.errorCode = null; // clear error on any successful completion

      const queue = this.queues.get(agentId) ?? [];
      if (queue.length > 0) {
        const next = queue.shift()!;
        this.queues.set(agentId, queue);
        void this.runTurn(agentId, next);
      }
    }
  }

  private dispatchSDKMessage(agentId: number, agent: SDKAgentState, msg: SDKMessage): void {
    // Capture session_id from init SystemMessage
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      if (agent.sessionId !== msg.session_id) {
        agent.sessionId = msg.session_id;
        updateAgentSessionId(agentId, msg.session_id);
        this.onEvent({ kind: 'sessionId', agentId, sessionId: msg.session_id });
      }
    }

    // Capture token usage and model from ResultMessage
    if (msg.type === 'result' && msg.subtype === 'success') {
      const r = msg as SDKResultSuccess;
      agent.inputTokens = r.usage.inputTokens;
      if (r.model) agent.currentModel = r.model;
      this.onEvent({
        kind: 'turnDone',
        agentId,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        model: r.model ?? agent.currentModel ?? '',
      });
    }

    // Forward all messages to webview
    this.onEvent({ kind: 'sdkMessage', agentId, msg });
  }

  private classifyError(err: unknown): SDKAgentErrorCode {
    const msg = String(err).toLowerCase();
    if (msg.includes('unauthorized') || msg.includes('auth') || msg.includes('subscription')) {
      return 'auth_failed';
    }
    if (msg.includes('session') && msg.includes('not found')) return 'session_not_found';
    if (msg.includes('enoent') || msg.includes('no such file or directory')) return 'cwd_missing';
    if (msg.includes('exit code') || msg.includes('process') || msg.includes('spawn')) return 'process_crash';
    return 'unknown';
  }

  /** Convert runtime state to persisted shape. */
  toPersistedAgent(agent: SDKAgentState): PersistedSDKAgent {
    return {
      id: agent.id,
      repoPath: agent.repoPath,
      displayName: agent.displayName,
      sessionId: agent.sessionId,
      role: agent.role,
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: agent.seatId,
      createdAt: agent.createdAt,
    };
  }

  /** Build runtime state from persisted shape. */
  static fromPersistedAgent(p: PersistedSDKAgent): SDKAgentState {
    return {
      ...p,
      currentModel: null,
      inputTokens: 0,
      sessionAllow: new Set(),
      errorCode: null,
      lastErrorMessage: null,
    };
  }
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npm run check-types
```

Expected: no type errors. If the SDK's `query()` types don't match exactly (e.g., options type is stricter), add `as unknown` casts where needed and note in a comment.

- [ ] **Step 3: Commit**

```bash
git add src/agentRunner.ts
git commit -m "feat: add AgentRunner SDK wrapper"
```

---

## Task 8: RepoPicker

**Files:**
- Create: `src/repoPicker.ts`

Wraps `vscode.window.showOpenDialog` and manages `recentRepos` in config.

- [ ] **Step 1: Create `src/repoPicker.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { addRecentRepo, readConfig } from './configPersistence.js';

export interface RepoPickResult {
  repoPath: string;
  displayName: string;
  recentRepos: string[];
}

/** Returns the picked repo path, or undefined if cancelled. */
export async function pickRepo(): Promise<RepoPickResult | undefined> {
  const config = readConfig();
  const recent = config.recentRepos;

  // If no recent repos, go straight to browse dialog
  // If there are recent repos, webview handles showing them (sent via settingsLoaded).
  // This function is called when the user clicks Browse in the webview RepoPicker.
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use this folder',
    title: 'Pick a repo for your agent',
  });

  if (!uris || uris.length === 0) return undefined;

  const repoPath = uris[0].fsPath;
  const displayName = path.basename(repoPath);

  // Warn if .git is missing, but allow
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    void vscode.window.showWarningMessage(
      `[Pixel Agents] "${displayName}" has no .git folder. The agent will still work but git features (branch detection) will be unavailable.`,
    );
  }

  addRecentRepo(repoPath);
  const updatedConfig = readConfig();

  return { repoPath, displayName, recentRepos: updatedConfig.recentRepos };
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npm run check-types
```

- [ ] **Step 3: Commit**

```bash
git add src/repoPicker.ts
git commit -m "feat: add RepoPicker"
```

---

## Task 9: Transcript loader

**Files:**
- Create: `src/transcriptLoader.ts`

Reads existing JSONL transcripts to populate chat history when the panel opens. Reuses the project-hash algorithm already in `agentManager.ts`.

- [ ] **Step 1: Understand the project hash algorithm**

```bash
grep -n "projectDir\|project-hash\|replace" /Users/antoine/Documents/Work/pixel-agents/src/agentManager.ts | head -20
```

The algorithm: replace every `:`, `\`, `/` in the absolute repo path with `-`. Example: `/Users/antoine/Documents/Work/celerity` → `-Users-antoine-Documents-Work-celerity`.

- [ ] **Step 2: Create `src/transcriptLoader.ts`**

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatBlock } from './types.js';

/** Convert absolute repo path to Claude Code's project hash directory name. */
export function repoPathToProjectHash(repoPath: string): string {
  return repoPath.replace(/[:/\\]/g, '-');
}

/** Return path to the JSONL file for a given session. */
export function getTranscriptPath(repoPath: string, sessionId: string): string {
  const hash = repoPathToProjectHash(repoPath);
  return path.join(os.homedir(), '.claude', 'projects', hash, `${sessionId}.jsonl`);
}

interface RawJSONLRecord {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
  };
  content?: unknown;
}

function parseContent(content: unknown): { text?: string; toolUse?: { id: string; name: string; input: unknown } } {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return {};
  for (const block of content as { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
    if (block.type === 'text' && block.text) return { text: block.text };
    if (block.type === 'tool_use' && block.id && block.name) {
      return { toolUse: { id: block.id, name: block.name, input: block.input } };
    }
  }
  return {};
}

export interface TranscriptLoadResult {
  blocks: ChatBlock[];
  truncatedAt?: number;
  error?: 'missing' | 'corrupt';
}

/**
 * Parse a JSONL transcript into ChatBlock array.
 * Permissive: skips unknown lines, truncates on parse error.
 */
export function loadTranscript(transcriptPath: string): TranscriptLoadResult {
  if (!fs.existsSync(transcriptPath)) {
    return { blocks: [], error: 'missing' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { blocks: [], error: 'corrupt' };
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  const blocks: ChatBlock[] = [];
  const toolResultMap = new Map<string, ChatBlock & { blockType: 'tool-use' }>();
  let truncatedAt: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    let record: RawJSONLRecord;
    try {
      record = JSON.parse(lines[i]) as RawJSONLRecord;
    } catch {
      if (i === 0) return { blocks: [], error: 'corrupt' };
      truncatedAt = i;
      break;
    }

    if (!record.type) continue;

    // User text prompt
    if (record.type === 'user' && record.message?.role === 'user') {
      const parsed = parseContent(record.message.content);
      if (parsed.text) {
        blocks.push({ blockType: 'user-text', id: `h-${i}`, text: parsed.text });
      }
      // tool_result: find and update the matching tool_use block
      if (Array.isArray(record.message.content)) {
        for (const c of record.message.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (c.type === 'tool_result' && c.tool_use_id) {
            const target = toolResultMap.get(c.tool_use_id);
            if (target) {
              target.result = c.content;
              target.isError = c.is_error;
            }
          }
        }
      }
    }

    // Assistant message
    if (record.type === 'assistant' && record.message?.role === 'assistant') {
      if (Array.isArray(record.message.content)) {
        for (const block of record.message.content as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text) {
            blocks.push({ blockType: 'assistant-text', id: `h-${i}-txt`, text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            blocks.push({ blockType: 'thinking', id: `h-${i}-thk`, text: block.thinking });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const toolBlock: ChatBlock & { blockType: 'tool-use' } = {
              blockType: 'tool-use',
              id: `h-${i}-tu-${block.id}`,
              toolId: block.id,
              toolName: block.name,
              input: block.input,
            };
            blocks.push(toolBlock);
            toolResultMap.set(block.id, toolBlock);
          }
        }
      }
    }
  }

  return { blocks, truncatedAt };
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
npm run check-types
```

- [ ] **Step 4: Commit**

```bash
git add src/transcriptLoader.ts
git commit -m "feat: add transcript loader for chat history"
```

---

## Task 10: ChatPanel webview component

**Files:**
- Create: `webview-ui/src/hooks/useChatState.ts`
- Create: `webview-ui/src/components/ChatBlocks.tsx`
- Create: `webview-ui/src/components/ChatPanel.tsx`

The ChatPanel slides in from the right when a character is selected.

- [ ] **Step 1: Create `webview-ui/src/hooks/useChatState.ts`**

This hook accumulates SDK events per-agent into a render-ready state.

```typescript
import { useCallback, useRef, useState } from 'react';
import type { ChatBlock, SDKAgentErrorCode } from '../../../src/types.js';

export interface AgentChatState {
  blocks: ChatBlock[];
  isStreaming: boolean;
  pendingPermission: { requestId: string; toolName: string; toolInput: unknown } | null;
  errorCode: SDKAgentErrorCode | null;
  errorMessage: string | null;
  inputTokens: number;
  currentModel: string | null;
}

function emptyState(): AgentChatState {
  return { blocks: [], isStreaming: false, pendingPermission: null, errorCode: null, errorMessage: null, inputTokens: 0, currentModel: null };
}

type AgentChatMap = Map<number, AgentChatState>;

export function useChatState() {
  const [chatMap, setChatMap] = useState<AgentChatMap>(new Map());
  // Ref to current map for use in callbacks without stale closure
  const chatMapRef = useRef(chatMap);
  chatMapRef.current = chatMap;

  const updateAgent = useCallback((agentId: number, updater: (s: AgentChatState) => AgentChatState) => {
    setChatMap((prev) => {
      const next = new Map(prev);
      const current = next.get(agentId) ?? emptyState();
      next.set(agentId, updater(current));
      return next;
    });
  }, []);

  const initAgent = useCallback((agentId: number, historyBlocks: ChatBlock[]) => {
    setChatMap((prev) => {
      const next = new Map(prev);
      const existing = next.get(agentId) ?? emptyState();
      next.set(agentId, { ...existing, blocks: historyBlocks });
      return next;
    });
  }, []);

  const appendUserPrompt = useCallback((agentId: number, text: string) => {
    updateAgent(agentId, (s) => ({
      ...s,
      isStreaming: true,
      errorCode: null,
      errorMessage: null,
      blocks: [...s.blocks, { blockType: 'user-text', id: `u-${Date.now()}`, text }],
    }));
  }, [updateAgent]);

  const handleSDKMessage = useCallback((agentId: number, msg: Record<string, unknown>) => {
    updateAgent(agentId, (s) => {
      const blocks = [...s.blocks];

      if (msg.type === 'assistant' && msg.message) {
        const content = (msg.message as { content?: unknown[] }).content ?? [];
        for (const block of content as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text) {
            // Merge into last assistant-text block if exists, else create
            const last = blocks[blocks.length - 1];
            if (last?.blockType === 'assistant-text') {
              blocks[blocks.length - 1] = { ...last, text: last.text + block.text };
            } else {
              blocks.push({ blockType: 'assistant-text', id: `a-${Date.now()}`, text: block.text });
            }
          } else if (block.type === 'thinking' && block.thinking) {
            blocks.push({ blockType: 'thinking', id: `thk-${Date.now()}`, text: block.thinking });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            blocks.push({ blockType: 'tool-use', id: `tu-${block.id}`, toolId: block.id, toolName: block.name, input: block.input });
          }
        }
      }

      if (msg.type === 'user' && msg.message) {
        // Tool results
        const content = (msg.message as { content?: unknown[] }).content ?? [];
        for (const c of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (c.type === 'tool_result' && c.tool_use_id) {
            const idx = blocks.findIndex((b) => b.blockType === 'tool-use' && b.toolId === c.tool_use_id);
            if (idx >= 0) {
              blocks[idx] = { ...(blocks[idx] as ChatBlock & { blockType: 'tool-use' }), result: c.content, isError: c.is_error };
            }
          }
        }
      }

      return { ...s, blocks };
    });
  }, [updateAgent]);

  const handleTurnDone = useCallback((agentId: number, inputTokens: number, model: string) => {
    updateAgent(agentId, (s) => ({ ...s, isStreaming: false, inputTokens, currentModel: model }));
  }, [updateAgent]);

  const handleError = useCallback((agentId: number, code: SDKAgentErrorCode, message: string) => {
    updateAgent(agentId, (s) => ({
      ...s,
      isStreaming: false,
      errorCode: code,
      errorMessage: message,
      blocks: [...s.blocks, { blockType: 'error', id: `err-${Date.now()}`, code, message }],
    }));
  }, [updateAgent]);

  const handleQueued = useCallback((agentId: number, text: string) => {
    updateAgent(agentId, (s) => ({
      ...s,
      blocks: [...s.blocks, { blockType: 'queued', id: `q-${Date.now()}`, text }],
    }));
  }, [updateAgent]);

  const handlePermissionRequest = useCallback((
    agentId: number,
    requestId: string,
    toolName: string,
    toolInput: unknown,
  ) => {
    updateAgent(agentId, (s) => ({ ...s, pendingPermission: { requestId, toolName, toolInput } }));
  }, [updateAgent]);

  const clearPermission = useCallback((agentId: number) => {
    updateAgent(agentId, (s) => ({ ...s, pendingPermission: null }));
  }, [updateAgent]);

  const removeAgent = useCallback((agentId: number) => {
    setChatMap((prev) => {
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
  }, []);

  return {
    chatMap,
    initAgent,
    appendUserPrompt,
    handleSDKMessage,
    handleTurnDone,
    handleError,
    handleQueued,
    handlePermissionRequest,
    clearPermission,
    removeAgent,
  };
}
```

- [ ] **Step 2: Create `webview-ui/src/components/ChatBlocks.tsx`**

```tsx
import React, { useState } from 'react';
import type { ChatBlock, SDKAgentErrorCode } from '../../../src/types.js';

// Inline pixel-style CSS (matches existing UI: sharp corners, hard offset shadow, FS Pixel Sans)
const styles = {
  bubble: (role: 'user' | 'assistant'): React.CSSProperties => ({
    background: role === 'user' ? 'var(--pixel-accent)' : 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border)',
    padding: '6px 8px',
    marginBottom: 4,
    fontSize: 12,
    lineHeight: 1.5,
    maxWidth: '90%',
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    boxShadow: '2px 2px 0 var(--pixel-shadow)',
    wordBreak: 'break-word' as const,
  }),
  tag: (role: 'user' | 'assistant'): React.CSSProperties => ({
    fontSize: 10,
    color: 'var(--pixel-dim)',
    marginBottom: 2,
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  }),
  toolPill: (expanded: boolean): React.CSSProperties => ({
    background: expanded ? 'var(--pixel-bg-alt)' : 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border)',
    padding: '4px 8px',
    fontSize: 11,
    cursor: 'pointer',
    marginBottom: 4,
    alignSelf: 'flex-start',
    boxShadow: '2px 2px 0 var(--pixel-shadow)',
  }),
  toolDetail: {
    fontSize: 10,
    color: 'var(--pixel-dim)',
    marginTop: 4,
    fontFamily: 'monospace',
    maxHeight: 120,
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
  } as React.CSSProperties,
  thinkingChip: {
    background: '#2a2a3a',
    border: '1px solid var(--pixel-dim)',
    padding: '3px 6px',
    fontSize: 10,
    color: 'var(--pixel-dim)',
    cursor: 'pointer',
    marginBottom: 4,
    alignSelf: 'flex-start' as const,
  } as React.CSSProperties,
  errorBlock: {
    background: '#3a1a1a',
    border: '2px solid #cc3333',
    padding: '6px 8px',
    fontSize: 11,
    color: '#ff6666',
    marginBottom: 4,
    boxShadow: '2px 2px 0 #1a0000',
  } as React.CSSProperties,
  queuedBubble: {
    background: 'var(--pixel-bg)',
    border: '2px dashed var(--pixel-dim)',
    padding: '6px 8px',
    fontSize: 11,
    color: 'var(--pixel-dim)',
    marginBottom: 4,
    alignSelf: 'flex-end' as const,
  } as React.CSSProperties,
};

function ToolBlock({ block }: { block: ChatBlock & { blockType: 'tool-use' } }) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = block.result !== undefined;
  return (
    <div style={styles.toolPill(expanded)} onClick={() => setExpanded((e) => !e)}>
      <span>{expanded ? '▾' : '▸'} {block.toolName}</span>
      {block.isError && <span style={{ color: '#ff6666', marginLeft: 6 }}>✗</span>}
      {hasResult && !expanded && <span style={{ color: 'var(--pixel-dim)', marginLeft: 6 }}>✓</span>}
      {expanded && (
        <div style={styles.toolDetail}>
          <div>Input: {JSON.stringify(block.input, null, 2)}</div>
          {hasResult && <div>Result: {JSON.stringify(block.result, null, 2)}</div>}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ block }: { block: ChatBlock & { blockType: 'thinking' } }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={styles.thinkingChip} onClick={() => setExpanded((e) => !e)}>
      {expanded ? '▾' : '▸'} thinking…
      {expanded && <div style={{ ...styles.toolDetail, color: 'var(--pixel-dim)' }}>{block.text}</div>}
    </div>
  );
}

const ERROR_MESSAGES: Record<SDKAgentErrorCode, string> = {
  auth_failed: 'Authentication failed. Open Claude Code and verify your subscription.',
  binary_missing: 'Claude Code CLI not found. Install it from docs.anthropic.com/claude-code.',
  cwd_missing: 'Repo path not found on disk.',
  process_crash: 'Claude process crashed unexpectedly.',
  session_not_found: 'Session expired. Starting fresh on next message.',
  unknown: 'Unexpected error.',
};

export function ChatBlockList({ blocks }: { blocks: ChatBlock[] }) {
  return (
    <>
      {blocks.map((block) => {
        switch (block.blockType) {
          case 'user-text':
            return (
              <React.Fragment key={block.id}>
                <div style={styles.tag('user')}>[you]</div>
                <div style={styles.bubble('user')}>{block.text}</div>
              </React.Fragment>
            );
          case 'assistant-text':
            return (
              <React.Fragment key={block.id}>
                <div style={styles.tag('assistant')}>[agent]</div>
                <div style={styles.bubble('assistant')}>{block.text}</div>
              </React.Fragment>
            );
          case 'thinking':
            return <ThinkingBlock key={block.id} block={block} />;
          case 'tool-use':
            return <ToolBlock key={block.id} block={block} />;
          case 'error':
            return (
              <div key={block.id} style={styles.errorBlock}>
                ⚠ {ERROR_MESSAGES[block.code] ?? block.message}
              </div>
            );
          case 'queued':
            return (
              <div key={block.id} style={styles.queuedBubble}>
                [queued] {block.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
```

- [ ] **Step 3: Create `webview-ui/src/components/ChatPanel.tsx`**

```tsx
import React, { useEffect, useRef, useState } from 'react';
import type { AgentChatState } from '../hooks/useChatState.js';
import { ChatBlockList } from './ChatBlocks.js';

interface ChatPanelProps {
  agentId: number;
  displayName: string;
  repoPath: string;
  chatState: AgentChatState;
  onSend: (agentId: number, text: string) => void;
  onInterrupt: (agentId: number) => void;
  onPermissionAllow: (requestId: string, always: boolean) => void;
  onPermissionDeny: (requestId: string) => void;
  onClose: () => void;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  width: 420,
  height: '100%',
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRight: 'none',
  borderTop: 'none',
  borderBottom: 'none',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--pixel-font)',
  fontSize: 12,
  zIndex: 100,
  boxShadow: '-4px 0 0 var(--pixel-shadow)',
};

export function ChatPanel({
  agentId,
  displayName,
  repoPath,
  chatState,
  onSend,
  onInterrupt,
  onPermissionAllow,
  onPermissionDeny,
  onClose,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatState.blocks.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text || chatState.isStreaming) return;
    setInput('');
    onSend(agentId, text);
  }

  const basename = repoPath.split('/').pop() ?? displayName;

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{ padding: '8px 10px', borderBottom: '2px solid var(--pixel-border)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 'bold', fontSize: 13 }}>▸ {basename}</div>
          <div style={{ fontSize: 10, color: 'var(--pixel-dim)', marginTop: 2 }}>{repoPath}</div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pixel-dim)', fontSize: 16, padding: 0, lineHeight: 1 }}
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {chatState.blocks.length === 0 && !chatState.isStreaming && (
          <div style={{ color: 'var(--pixel-dim)', fontSize: 11, textAlign: 'center', marginTop: 20 }}>
            No messages yet. Send a prompt to get started.
          </div>
        )}
        <ChatBlockList blocks={chatState.blocks} />
        {chatState.isStreaming && (
          <div style={{ color: 'var(--pixel-dim)', fontSize: 11, alignSelf: 'flex-start', marginTop: 4 }}>• • •</div>
        )}
      </div>

      {/* Permission prompt (Phase 2 wires this up; rendered but non-functional in Phase 1) */}
      {chatState.pendingPermission && (
        <div style={{ padding: '8px 10px', borderTop: '2px solid #cc3333', background: '#2a1a1a', fontSize: 11 }}>
          <div style={{ marginBottom: 6 }}>
            Allow <strong>{chatState.pendingPermission.toolName}</strong>?
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onPermissionAllow(chatState.pendingPermission!.requestId, false)}
              style={{ border: '2px solid var(--pixel-border)', padding: '3px 8px', cursor: 'pointer', background: 'var(--pixel-bg)', color: 'var(--pixel-fg)', fontFamily: 'inherit' }}>
              Allow
            </button>
            <button onClick={() => onPermissionAllow(chatState.pendingPermission!.requestId, true)}
              style={{ border: '2px solid var(--pixel-border)', padding: '3px 8px', cursor: 'pointer', background: 'var(--pixel-bg)', color: 'var(--pixel-fg)', fontFamily: 'inherit' }}>
              Always (session)
            </button>
            <button onClick={() => onPermissionDeny(chatState.pendingPermission!.requestId)}
              style={{ border: '2px solid #cc3333', padding: '3px 8px', cursor: 'pointer', background: '#3a1a1a', color: '#ff6666', fontFamily: 'inherit' }}>
              Deny
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '8px 10px', borderTop: '2px solid var(--pixel-border)' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type something… (Enter to send, Shift+Enter for newline)"
          disabled={chatState.isStreaming}
          style={{
            width: '100%',
            minHeight: 60,
            resize: 'vertical',
            background: 'var(--pixel-bg)',
            color: 'var(--pixel-fg)',
            border: '2px solid var(--pixel-border)',
            padding: '4px 6px',
            fontFamily: 'inherit',
            fontSize: 12,
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            onClick={handleSend}
            disabled={chatState.isStreaming || !input.trim()}
            style={{
              flex: 1,
              border: '2px solid var(--pixel-border)',
              padding: '4px 8px',
              cursor: chatState.isStreaming || !input.trim() ? 'default' : 'pointer',
              background: 'var(--pixel-bg)',
              color: chatState.isStreaming || !input.trim() ? 'var(--pixel-dim)' : 'var(--pixel-fg)',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            ↵ Send
          </button>
          <button
            onClick={() => onInterrupt(agentId)}
            disabled={!chatState.isStreaming}
            style={{
              border: '2px solid var(--pixel-border)',
              padding: '4px 8px',
              cursor: chatState.isStreaming ? 'pointer' : 'default',
              background: chatState.isStreaming ? '#3a1a1a' : 'var(--pixel-bg)',
              color: chatState.isStreaming ? '#ff6666' : 'var(--pixel-dim)',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            ⏹ Interrupt
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify TypeScript in webview**

```bash
cd webview-ui && npm run build 2>&1 | head -40
```

Fix any type errors before proceeding. Common ones: import paths (use `../../../src/types.js` relative to webview-ui), missing CSS variables.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/hooks/useChatState.ts webview-ui/src/components/ChatBlocks.tsx webview-ui/src/components/ChatPanel.tsx
git commit -m "feat: add ChatPanel, ChatBlocks, useChatState webview components"
```

---

## Task 11: RepoPicker webview overlay

**Files:**
- Create: `webview-ui/src/components/RepoPicker.tsx`

This is a modal-style overlay in the webview. It shows recent repos and a Browse button. Browse sends a message to the extension host, which opens `showOpenDialog` and replies with the chosen path.

- [ ] **Step 1: Create `webview-ui/src/components/RepoPicker.tsx`**

```tsx
import React from 'react';

interface RepoPickerProps {
  recentRepos: string[];
  onPickRecent: (repoPath: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(10,10,20,0.8)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
};

const boxStyle: React.CSSProperties = {
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  boxShadow: '4px 4px 0 var(--pixel-shadow)',
  padding: '12px 14px',
  minWidth: 280,
  fontFamily: 'var(--pixel-font)',
};

export function RepoPicker({ recentRepos, onPickRecent, onBrowse, onClose }: RepoPickerProps) {
  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={boxStyle}>
        <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 10 }}>Pick a repo:</div>
        {recentRepos.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: 'var(--pixel-dim)', marginBottom: 4 }}>Recent:</div>
            {recentRepos.map((repo) => {
              const name = repo.split('/').pop() ?? repo;
              return (
                <div
                  key={repo}
                  onClick={() => onPickRecent(repo)}
                  style={{
                    padding: '4px 6px',
                    cursor: 'pointer',
                    fontSize: 12,
                    borderBottom: '1px solid var(--pixel-border)',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--pixel-bg-alt)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
                >
                  • {name}
                  <span style={{ fontSize: 10, color: 'var(--pixel-dim)', marginLeft: 6 }}>{repo}</span>
                </div>
              );
            })}
          </div>
        )}
        <button
          onClick={onBrowse}
          style={{
            width: '100%',
            border: '2px solid var(--pixel-border)',
            padding: '5px 10px',
            background: 'var(--pixel-bg)',
            color: 'var(--pixel-fg)',
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
            boxShadow: '2px 2px 0 var(--pixel-shadow)',
          }}
        >
          📁 Browse…
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd webview-ui && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add webview-ui/src/components/RepoPicker.tsx
git commit -m "feat: add RepoPicker webview overlay"
```

---

## Task 12: Wire into extension (PixelAgentsViewProvider)

**Files:**
- Modify: `src/PixelAgentsViewProvider.ts`

This is the largest integration task. Read the current file in full first, then apply the changes below.

- [ ] **Step 1: Read the current file**

```bash
grep -n "class PixelAgentsViewProvider\|constructor\|private _\|async _\|openClaude\|agentCreated\|existingAgents\|settingsLoaded" /Users/antoine/Documents/Work/pixel-agents/src/PixelAgentsViewProvider.ts | head -60
```

- [ ] **Step 2: Add AgentRunner import and field**

Near the top of the file, add imports for the new modules:
```typescript
import { AgentRunner } from './agentRunner.js';
import { allocateNextAgentId, readAgentsFile, removePersistedAgent, upsertAgent } from './agentsPersistence.js';
import { runPreflight } from './preflight.js';
import { pickRepo } from './repoPicker.js';
import { getTranscriptPath, loadTranscript } from './transcriptLoader.js';
import type { SDKAgentState } from './types.js';
import { CHAT_EVENT_BUFFER_MAX } from './constants.js';
```

Add a private field to the class:
```typescript
private _agentRunner: AgentRunner;
private _chatEventBuffers = new Map<number, unknown[]>(); // agentId → buffered events (panel closed)
```

- [ ] **Step 3: Initialize AgentRunner in constructor or `resolveWebviewView`**

In the `resolveWebviewView` method (or constructor), after the webview is initialized:

```typescript
this._agentRunner = new AgentRunner((event) => {
  // Buffer events when webview panel is not visible
  if (event.kind === 'sdkMessage' || event.kind === 'turnDone' || event.kind === 'error' || event.kind === 'queued') {
    const buffer = this._chatEventBuffers.get(event.agentId) ?? [];
    if (buffer.length < CHAT_EVENT_BUFFER_MAX) buffer.push(event);
    this._chatEventBuffers.set(event.agentId, buffer);
  }
  // Always forward to webview (it handles missing panel gracefully)
  this._view?.webview.postMessage({ type: 'agentRunnerEvent', event });
});

// Restore persisted agents on activation
const file = readAgentsFile();
for (const persisted of file.agents) {
  const state = AgentRunner.fromPersistedAgent(persisted);
  this._agentRunner.addAgent(state);
  // Send to webview once it's ready (handled in onDidReceiveMessage 'webviewReady')
}
```

- [ ] **Step 4: Run preflight on activation**

In the `activate` function in `extension.ts`, after the provider is registered, call:
```typescript
void runPreflight(outputChannel).then((result) => {
  if (result.errors.includes('binary_missing')) {
    void vscode.window.showErrorMessage(
      '[Pixel Agents] Claude Code CLI not found. Install from https://docs.anthropic.com/claude-code/quickstart',
      'Open Quickstart',
    ).then((choice) => {
      if (choice === 'Open Quickstart') {
        void vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/claude-code/quickstart'));
      }
    });
  }
});
```

- [ ] **Step 5: Handle new webview messages**

In the `onDidReceiveMessage` handler, add cases for the new message types:

```typescript
case 'browseRepo': {
  // User clicked "Browse…" in RepoPicker
  const result = await pickRepo();
  if (result) {
    // Create agent with the picked repo
    const id = allocateNextAgentId();
    const palette = this._pickDiversePalette(); // existing method
    const state: SDKAgentState = {
      id,
      repoPath: result.repoPath,
      displayName: result.displayName,
      sessionId: null,
      role: 'generalist',
      palette,
      hueShift: 0,
      seatId: null,
      createdAt: Date.now(),
      currentModel: null,
      inputTokens: 0,
      sessionAllow: new Set(),
      errorCode: null,
      lastErrorMessage: null,
    };
    this._agentRunner.addAgent(state);
    upsertAgent(this._agentRunner.toPersistedAgent(state));
    this._view?.webview.postMessage({
      type: 'sdkAgentCreated',
      agent: this._agentRunner.toPersistedAgent(state),
      recentRepos: result.recentRepos,
    });
  }
  break;
}
case 'pickRecentRepo': {
  // User selected a recent repo from the list
  const { repoPath } = message as { repoPath: string };
  const displayName = repoPath.split('/').pop() ?? repoPath;
  const id = allocateNextAgentId();
  const palette = this._pickDiversePalette();
  const state: SDKAgentState = {
    id,
    repoPath,
    displayName,
    sessionId: null,
    role: 'generalist',
    palette,
    hueShift: 0,
    seatId: null,
    createdAt: Date.now(),
    currentModel: null,
    inputTokens: 0,
    sessionAllow: new Set(),
    errorCode: null,
    lastErrorMessage: null,
  };
  this._agentRunner.addAgent(state);
  upsertAgent(this._agentRunner.toPersistedAgent(state));
  this._view?.webview.postMessage({
    type: 'sdkAgentCreated',
    agent: this._agentRunner.toPersistedAgent(state),
  });
  break;
}
case 'sendPrompt': {
  const { agentId, text } = message as { agentId: number; text: string };
  void this._agentRunner.sendPrompt(agentId, text);
  break;
}
case 'interruptAgent': {
  const { agentId } = message as { agentId: number };
  this._agentRunner.interrupt(agentId);
  break;
}
case 'removeSdkAgent': {
  const { agentId } = message as { agentId: number };
  this._agentRunner.removeAgent(agentId);
  removePersistedAgent(agentId);
  this._chatEventBuffers.delete(agentId);
  this._view?.webview.postMessage({ type: 'sdkAgentRemoved', agentId });
  break;
}
case 'openChatPanel': {
  // Webview signals panel open — flush buffered events for that agent
  const { agentId } = message as { agentId: number };
  const agent = this._agentRunner.getAgent(agentId);
  if (agent) {
    // Load transcript history
    if (agent.sessionId) {
      const transcriptPath = getTranscriptPath(agent.repoPath, agent.sessionId);
      const { blocks, truncatedAt, error } = loadTranscript(transcriptPath);
      this._view?.webview.postMessage({ type: 'chatHistory', agentId, blocks, truncatedAt, error });
    } else {
      this._view?.webview.postMessage({ type: 'chatHistory', agentId, blocks: [] });
    }
    // Flush buffered events
    const buffer = this._chatEventBuffers.get(agentId) ?? [];
    this._chatEventBuffers.delete(agentId);
    for (const ev of buffer) {
      this._view?.webview.postMessage({ type: 'agentRunnerEvent', event: ev });
    }
  }
  break;
}
```

- [ ] **Step 6: Send existing agents and recentRepos to webview on ready**

In the `webviewReady` handler (or wherever `existingAgents` / `settingsLoaded` is sent), also send the SDK agents and recent repos:

```typescript
case 'webviewReady': {
  // ... existing code to send layout, assets, settings ...
  // Also send SDK agents
  const allAgents = this._agentRunner.getAllAgents().map((a) => this._agentRunner.toPersistedAgent(a));
  this._view?.webview.postMessage({ type: 'sdkExistingAgents', agents: allAgents });
  // recentRepos already included in settingsLoaded if we extend that message
  break;
}
```

- [ ] **Step 7: Verify TypeScript**

```bash
npm run check-types
```

Fix any errors. Common issue: `_pickDiversePalette` may have a different name in the existing provider — search for it:
```bash
grep -n "palette\|pickDiverse" /Users/antoine/Documents/Work/pixel-agents/src/PixelAgentsViewProvider.ts | head -20
```

Adapt the palette assignment call accordingly (it may come from `agentManager.ts` or be inline in the provider).

- [ ] **Step 8: Build and test in Extension Dev Host**

```bash
npm run build
```

Then press F5 in VS Code to open Extension Dev Host. Verify:
- Extension activates without errors (check Output → Pixel Agents channel)
- `+ Agent` button sends `browseRepo` message (check devtools console in webview)

- [ ] **Step 9: Commit**

```bash
git add src/PixelAgentsViewProvider.ts src/extension.ts
git commit -m "feat: integrate AgentRunner into extension provider"
```

---

## Task 13: Wire webview (useExtensionMessages + App.tsx)

**Files:**
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts`
- Modify: `webview-ui/src/App.tsx`

- [ ] **Step 1: Read current useExtensionMessages structure**

```bash
grep -n "case '\|addListener\|postMessage" /Users/antoine/Documents/Work/pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts | head -40
```

- [ ] **Step 2: Add new message handlers in useExtensionMessages**

Add to the existing message switch/dispatch:

```typescript
// In the message handler switch
case 'agentRunnerEvent': {
  const ev = msg.event as { kind: string; agentId: number; [key: string]: unknown };
  switch (ev.kind) {
    case 'sdkMessage':
      handleSDKMessage(ev.agentId, ev.msg as Record<string, unknown>);
      break;
    case 'turnDone':
      handleTurnDone(ev.agentId, ev.inputTokens as number, ev.model as string);
      break;
    case 'error':
      handleError(ev.agentId, ev.code as SDKAgentErrorCode, ev.message as string);
      break;
    case 'queued':
      // Find the queued text from the blocks — it was already added by appendUserPrompt
      // Nothing to do here; the webview already shows the queued bubble
      break;
    case 'sessionId':
      // session_id assigned — no UI change needed
      break;
  }
  break;
}
case 'chatHistory': {
  const { agentId, blocks } = msg as { agentId: number; blocks: ChatBlock[]; truncatedAt?: number; error?: string };
  initAgent(agentId, blocks ?? []);
  break;
}
case 'sdkAgentCreated': {
  const { agent, recentRepos: repos } = msg as { agent: PersistedSDKAgent; recentRepos?: string[] };
  // Add to office state (character spawn)
  officeState.addSDKAgent(agent);
  if (repos) setRecentRepos(repos);
  setShowRepoPicker(false);
  setOpenPanelAgentId(agent.id);
  break;
}
case 'sdkExistingAgents': {
  const { agents } = msg as { agents: PersistedSDKAgent[] };
  for (const a of agents) {
    officeState.addSDKAgent(a);
  }
  break;
}
case 'sdkAgentRemoved': {
  const { agentId } = msg as { agentId: number };
  officeState.removeSDKAgent(agentId);
  removeAgent(agentId);
  if (openPanelAgentId === agentId) setOpenPanelAgentId(null);
  break;
}
case 'repoBrowseResult': {
  // Not used — pickRepo is handled entirely in the extension host
  break;
}
```

The hook should export these new state values:
```typescript
// Additional state to expose from the hook:
const [recentRepos, setRecentRepos] = useState<string[]>([]);
const [openPanelAgentId, setOpenPanelAgentId] = useState<number | null>(null);
const [showRepoPicker, setShowRepoPicker] = useState(false);
```

- [ ] **Step 3: Add OfficeState methods for SDK agents**

In `webview-ui/src/office/engine/officeState.ts`, add:

```typescript
addSDKAgent(persisted: PersistedSDKAgent): void {
  // Create a Character entry similar to how existingAgents works
  // Reuse the existing addCharacter/spawnCharacter logic
  // The character's id maps to persisted.id
  // On click → sends openChatPanel + sets openPanelAgentId
  // ... follow the existing pattern for agentCreated
}

removeSDKAgent(agentId: number): void {
  // Trigger matrix despawn, then remove character
  // Follow existing removeAgent logic
}
```

Read the existing `agentCreated` handler path in `officeState.ts` to follow the exact same pattern.

- [ ] **Step 4: Update App.tsx to include ChatPanel and RepoPicker**

```tsx
// In App.tsx, add to the render:
import { ChatPanel } from './components/ChatPanel.js';
import { RepoPicker } from './components/RepoPicker.js';
import { useChatState } from './hooks/useChatState.js';

// Inside the component:
const chatState = useChatState();
// (wire chatState methods into useExtensionMessages)

// Callbacks:
function handleSend(agentId: number, text: string) {
  chatState.appendUserPrompt(agentId, text);
  vscode.postMessage({ type: 'sendPrompt', agentId, text });
}
function handleInterrupt(agentId: number) {
  vscode.postMessage({ type: 'interruptAgent', agentId });
}
function handlePermissionAllow(requestId: string, always: boolean) {
  chatState.clearPermission(openPanelAgentId!);
  vscode.postMessage({ type: 'permissionResponse', requestId, allowed: true, always });
}
function handlePermissionDeny(requestId: string) {
  chatState.clearPermission(openPanelAgentId!);
  vscode.postMessage({ type: 'permissionResponse', requestId, allowed: false, always: false });
}

// When panel opens, notify extension to flush buffer + load history:
useEffect(() => {
  if (openPanelAgentId !== null) {
    vscode.postMessage({ type: 'openChatPanel', agentId: openPanelAgentId });
  }
}, [openPanelAgentId]);

// In JSX (after existing canvas):
{openPanelAgentId !== null && (() => {
  const agent = officeState.getSDKAgent(openPanelAgentId);
  const state = chatState.chatMap.get(openPanelAgentId);
  if (!agent || !state) return null;
  return (
    <ChatPanel
      agentId={openPanelAgentId}
      displayName={agent.displayName}
      repoPath={agent.repoPath}
      chatState={state}
      onSend={handleSend}
      onInterrupt={handleInterrupt}
      onPermissionAllow={handlePermissionAllow}
      onPermissionDeny={handlePermissionDeny}
      onClose={() => setOpenPanelAgentId(null)}
    />
  );
})()}

{showRepoPicker && (
  <RepoPicker
    recentRepos={recentRepos}
    onPickRecent={(path) => vscode.postMessage({ type: 'pickRecentRepo', repoPath: path })}
    onBrowse={() => vscode.postMessage({ type: 'browseRepo' })}
    onClose={() => setShowRepoPicker(false)}
  />
)}
```

Also wire `+ Agent` button to `setShowRepoPicker(true)` instead of the old `openClaude` message.

- [ ] **Step 5: Verify TypeScript and build**

```bash
npm run build
```

Expected: no type errors, build succeeds.

- [ ] **Step 6: Manual test in Extension Dev Host**

1. Open Extension Dev Host (F5)
2. Click `+ Agent`
3. RepoPicker overlay should appear
4. Browse → pick a folder → agent appears in office (matrix spawn)
5. Click the agent character → ChatPanel slides in
6. Type a message, press Enter → extension sends prompt to SDK → response streams in

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/App.tsx webview-ui/src/office/engine/officeState.ts
git commit -m "feat: wire SDK agents into webview (ChatPanel, RepoPicker, office)"
```

---

## Task 14: First-launch migration banner

**Files:**
- Modify: `src/PixelAgentsViewProvider.ts` (add banner logic)
- Modify: `src/constants.ts` (add `GLOBAL_KEY_LAST_SDK_MIGRATION`)

The spec says: on first launch after upgrade, show a one-time banner if old workspaceState agents exist.

- [ ] **Step 1: Add constant for the migration flag**

In `src/constants.ts`:
```typescript
export const GLOBAL_KEY_LAST_SDK_MIGRATION = 'pixel-agents.lastSDKMigration';
export const SDK_MIGRATION_VERSION = 1;
```

- [ ] **Step 2: Add migration check in extension activation**

In `extension.ts` (or in `PixelAgentsViewProvider.resolveWebviewView`), after agents are restored:

```typescript
const migrationDone = context.globalState.get<number>(GLOBAL_KEY_LAST_SDK_MIGRATION) ?? 0;
if (migrationDone < SDK_MIGRATION_VERSION) {
  // Check if old workspaceState agents exist
  const oldAgents = context.workspaceState.get<unknown[]>(WORKSPACE_KEY_AGENTS);
  if (oldAgents && oldAgents.length > 0) {
    // Clear old state, show banner
    await context.workspaceState.update(WORKSPACE_KEY_AGENTS, undefined);
    this._view?.webview.postMessage({ type: 'migrationBanner' });
  }
  await context.globalState.update(GLOBAL_KEY_LAST_SDK_MIGRATION, SDK_MIGRATION_VERSION);
}
```

- [ ] **Step 3: Handle in webview — show a dismissible banner**

In `App.tsx`, add:
```tsx
const [showMigrationBanner, setShowMigrationBanner] = useState(false);
// In message handler: case 'migrationBanner': setShowMigrationBanner(true); break;

// In JSX:
{showMigrationBanner && (
  <div style={{
    position: 'absolute', top: 8, left: 8, right: 8, zIndex: 300,
    background: 'var(--pixel-bg)', border: '2px solid var(--pixel-border)',
    padding: '8px 10px', fontSize: 11, boxShadow: '2px 2px 0 var(--pixel-shadow)',
    display: 'flex', alignItems: 'center', gap: 8,
  }}>
    <span style={{ flex: 1 }}>
      Pixel Agents upgraded! Previous terminal-based agents were not migrated. Create a new agent to get started.
    </span>
    <button onClick={() => setShowMigrationBanner(false)}
      style={{ border: '2px solid var(--pixel-border)', padding: '2px 6px', cursor: 'pointer', background: 'var(--pixel-bg)', fontFamily: 'inherit', fontSize: 11 }}>
      ✕
    </button>
  </div>
)}
```

- [ ] **Step 4: Verify and commit**

```bash
npm run build
git add src/constants.ts src/PixelAgentsViewProvider.ts webview-ui/src/App.tsx
git commit -m "feat: one-time migration banner for terminal-to-SDK upgrade"
```

---

## Task 15 (Phase 2): Permission flow — canUseTool

**Files:**
- Modify: `src/agentRunner.ts` (add canUseTool callback)
- Modify: `src/PixelAgentsViewProvider.ts` (route permissionResponse from webview)

In Phase 1, `canUseTool` was omitted. Now we wire up the full flow: safe tools auto-approve, unsafe tools pause the SDK callback and wait for user input.

- [ ] **Step 1: Add pending permission tracking to AgentRunner**

In `src/agentRunner.ts`, add:
```typescript
private pendingPermissions = new Map<string, (allowed: boolean) => void>();
```

Add a method to resolve:
```typescript
resolvePermission(requestId: string, allowed: boolean, always: boolean): void {
  const resolve = this.pendingPermissions.get(requestId);
  if (!resolve) return;
  this.pendingPermissions.delete(requestId);
  if (always) {
    // Find agent by current inflight turn (tricky — we need agentId in the closure)
    // For simplicity, store agentId alongside the resolver
  }
  resolve(allowed);
}
```

- [ ] **Step 2: Update AgentRunner.runTurn to set canUseTool**

Replace the placeholder comment in `runTurn`:
```typescript
canUseTool: async (toolName: string, toolInput: unknown): Promise<boolean> => {
  if (SAFE_TOOLS.has(toolName)) return true;
  if (agent.sessionAllow.has(toolName)) return true;

  const requestId = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    this.pendingPermissions.set(requestId, resolve);
    this.onEvent({ kind: 'permissionRequest', agentId, toolName, toolInput, requestId });
  });
},
```

Update `AgentRunnerEvent` to include:
```typescript
| { kind: 'permissionRequest'; agentId: number; toolName: string; toolInput: unknown; requestId: string }
```

- [ ] **Step 3: Route permissionResponse in PixelAgentsViewProvider**

Add to `onDidReceiveMessage`:
```typescript
case 'permissionResponse': {
  const { requestId, allowed, always, agentId } = message as {
    requestId: string; allowed: boolean; always: boolean; agentId: number;
  };
  if (always && allowed) {
    const agent = this._agentRunner.getAgent(agentId);
    if (agent) {
      const toolName = /* store toolName alongside resolver */ '';
      // We need to know which tool this was — add toolName to the stored resolver
      agent.sessionAllow.add(toolName);
    }
  }
  this._agentRunner.resolvePermission(requestId, allowed);
  break;
}
```

**Note:** To pass `toolName` to the `permissionResponse` handler, the webview must include it in its `permissionResponse` message. Update `ChatPanel`'s Allow/Allow Always buttons to include `toolName` in the message.

- [ ] **Step 4: Show permission speech bubble on character**

In `PixelAgentsViewProvider`, when a `permissionRequest` event arrives from AgentRunner, also send the existing `agentToolPermission` message to the webview (which triggers the `...` amber bubble on the character):

```typescript
case 'permissionRequest': {
  // Forward to webview for ChatPanel rendering
  this._view?.webview.postMessage({ type: 'agentRunnerEvent', event });
  // Also show character speech bubble
  this._view?.webview.postMessage({ type: 'agentToolPermission', id: event.agentId });
  break;
}
```

- [ ] **Step 5: Verify and commit**

```bash
npm run build
git add src/agentRunner.ts src/PixelAgentsViewProvider.ts webview-ui/src/components/ChatPanel.tsx
git commit -m "feat: wire canUseTool permission flow (Phase 2)"
```

---

## Task 16 (Phase 3a): Hook script — PIXEL_AGENTS_ID

**Files:**
- Modify: `server/src/providers/hook/claude/hooks/claude-hook.ts`

The hook script already fires for all claude invocations. We need to forward the `PIXEL_AGENTS_ID` env var (set by AgentRunner per `query()` call) in the POST body so the server can route events by agent ID.

- [ ] **Step 1: Read the current hook script**

```bash
cat /Users/antoine/Documents/Work/pixel-agents/server/src/providers/hook/claude/hooks/claude-hook.ts
```

- [ ] **Step 2: Add PIXEL_AGENTS_ID to POST body**

In the hook script, where the POST body is constructed, add:

```typescript
const body = JSON.stringify({
  ...parsed,                                      // existing fields from stdin
  pixel_agents_id: process.env.PIXEL_AGENTS_ID   // may be undefined for non-SDK sessions
    ? Number(process.env.PIXEL_AGENTS_ID)
    : undefined,
});
```

If the existing body construction is different (e.g., using spread or specific fields), add `pixel_agents_id` to whatever object is serialized. The value is `undefined` (and thus omitted from JSON) for non-SDK sessions.

- [ ] **Step 3: Update HookEvent type in hookEventHandler.ts**

```typescript
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  pixel_agents_id?: number;  // NEW
  [key: string]: unknown;
}
```

- [ ] **Step 4: Rebuild the hook script**

```bash
npm run build
```

The `buildHooks()` step in `esbuild.js` bundles `claude-hook.ts` → `dist/hooks/claude-hook.js`. Verify it ran:
```bash
grep -l "pixel_agents_id" /Users/antoine/Documents/Work/pixel-agents/dist/hooks/claude-hook.js
```

- [ ] **Step 5: Commit**

```bash
git add server/src/providers/hook/claude/hooks/claude-hook.ts server/src/hookEventHandler.ts
git commit -m "feat(hooks): forward PIXEL_AGENTS_ID env var in hook POST body"
```

---

## Task 17 (Phase 3b): Server routing — prefer PIXEL_AGENTS_ID

**Files:**
- Modify: `server/src/hookEventHandler.ts`

When `pixel_agents_id` is present, route directly to that agent ID — skipping the session_id lookup. Fall back to session_id matching if absent.

- [ ] **Step 1: Update handleEvent to prefer pixel_agents_id**

In `HookEventHandler.handleEvent`, before the existing `session_id` lookup:

```typescript
// Prefer pixel_agents_id routing (SDK-managed agents)
if (event.pixel_agents_id !== undefined) {
  const agentId = event.pixel_agents_id as number;
  const agent = this.agents.get(agentId);
  if (agent) {
    agent.hookDelivered = true;
    // Ensure session_id is registered for this agent (for future lookups)
    if (event.session_id && !this.sessionToAgentId.has(event.session_id)) {
      this.sessionToAgentId.set(event.session_id, agentId);
    }
    const webview = this.getWebview();
    const normalized = this.provider.normalizeHookEvent(event);
    if (!normalized) return;
    // dispatch via existing switch
    this.dispatchNormalized(agentId, agent, normalized.event, event, webview);
    return;
  }
}
// ... existing session_id lookup fallback ...
```

This requires extracting the dispatch switch into a `dispatchNormalized` helper, or duplicating the call — follow whichever keeps the diff smallest.

- [ ] **Step 2: Write a test for the new routing path**

In `server/__tests__/hookEventHandler.test.ts`, add:

```typescript
it('routes by pixel_agents_id when present, ignoring session_id mismatch', () => {
  // Register agent with id=42, session_id='aaa'
  handler.registerAgent('aaa', 42);
  
  // Send event with pixel_agents_id=42 but session_id='bbb' (would not match by session)
  const event = {
    hook_event_name: 'Stop',
    session_id: 'bbb',
    pixel_agents_id: 42,
  };
  
  handler.handleEvent('claude', event);
  
  // Verify agent 42 received the event (check agentStatus 'waiting' was posted)
  expect(mockWebview.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'agentStatus', id: 42, status: 'waiting' }),
  );
});
```

Run:
```bash
cd server && npm test -- --reporter verbose 2>&1 | grep -A5 "pixel_agents_id"
```

Expected: test passes.

- [ ] **Step 3: Commit**

```bash
git add server/src/hookEventHandler.ts server/__tests__/hookEventHandler.test.ts
git commit -m "feat(server): prefer pixel_agents_id for hook event routing"
```

---

## Task 18 (Phase 3c): Cleanup — remove terminal machinery

**Files:**
- Modify: `src/agentManager.ts` — remove terminal-lifecycle code
- Modify: `src/fileWatcher.ts` — remove heuristic scanning, keep `readTranscriptLines`
- Modify: `src/PixelAgentsViewProvider.ts` — remove imports of deleted functions

This task should only be done after Tasks 1-17 are working end-to-end in Extension Dev Host.

- [ ] **Step 1: Identify what to remove**

```bash
grep -n "export function\|export async function\|export const" /Users/antoine/Documents/Work/pixel-agents/src/agentManager.ts
grep -n "export function\|export async function\|export const" /Users/antoine/Documents/Work/pixel-agents/src/fileWatcher.ts
```

Functions to remove from `agentManager.ts`:
- `createTerminal` / `launchNewTerminal`
- `restoreAgents`
- Terminal-adoption scanning (`startTerminalAdoptionScan`, etc.)
- `getAgentByTerminal`, `findOrAdoptTerminal`, etc.

Functions to keep in `fileWatcher.ts`:
- `readNewLines` — still used by `transcriptLoader.ts` for partial-line buffering
- Any pure utility that isn't tied to heuristic polling

Functions to remove from `fileWatcher.ts`:
- `startMainScanner`, `startExternalScanner`, `startStaleScanner`
- Content-based `/clear` detection
- Any 1s / 3s / 30s interval setups

- [ ] **Step 2: Remove terminal-related code**

For each function: check if it's still imported anywhere before deleting.
```bash
grep -rn "launchNewTerminal\|createTerminal\|restoreAgents" /Users/antoine/Documents/Work/pixel-agents/src/ --include="*.ts"
```

Remove callers first, then the exports.

- [ ] **Step 3: Verify TypeScript**

```bash
npm run check-types
```

Fix any import errors.

- [ ] **Step 4: Run full build and manual test**

```bash
npm run build
```

Open Extension Dev Host, verify agents still work without the terminal machinery.

- [ ] **Step 5: Commit**

```bash
git add src/agentManager.ts src/fileWatcher.ts src/PixelAgentsViewProvider.ts
git commit -m "refactor: remove terminal-based agent machinery (Phase 3 cleanup)"
```

---

## Task 19 (Phase 4a): Queue indicator + AgentInspector

**Files:**
- Modify: `webview-ui/src/components/ChatPanel.tsx` (add Inspector section)

AgentInspector is a collapsible section in the chat panel header showing model, branch, session ID, tokens, and interrupt button.

- [ ] **Step 1: Add branch detection in extension**

In `PixelAgentsViewProvider.ts`, when the panel opens (`openChatPanel` message), also send branch info:

```typescript
import { execFileNoThrow } from './utils/execFileNoThrow.js';

// In openChatPanel handler:
const branchResult = await execFileNoThrow('git', ['-C', agent.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '(unknown)';
this._view?.webview.postMessage({ type: 'agentBranch', agentId, branch });
```

- [ ] **Step 2: Add Inspector component to ChatPanel**

Add a collapsible inspector section in `ChatPanel.tsx` between the header and the message list:

```tsx
function Inspector({ agent, chatState, branch, onInterrupt }: {
  agent: { sessionId: string | null; role: string };
  chatState: AgentChatState;
  branch: string;
  onInterrupt: () => void;
}) {
  const [open, setOpen] = useState(false);
  const contextPct = chatState.inputTokens > 0 && chatState.currentModel
    ? Math.round((chatState.inputTokens / (MODEL_CONTEXT_LIMITS[chatState.currentModel] ?? DEFAULT_CONTEXT_LIMIT)) * 100)
    : null;
  return (
    <div style={{ borderBottom: '2px solid var(--pixel-border)' }}>
      <div onClick={() => setOpen((o) => !o)} style={{ padding: '4px 10px', cursor: 'pointer', fontSize: 11, color: 'var(--pixel-dim)' }}>
        {open ? '▾' : '▸'} Inspector
      </div>
      {open && (
        <div style={{ padding: '4px 10px 8px', fontSize: 10, color: 'var(--pixel-dim)', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div>Model: {chatState.currentModel ?? '(pending first turn)'}</div>
          <div>Branch: {branch}</div>
          <div>Session: {agent.sessionId ? agent.sessionId.slice(0, 8) + '…' : '(none)'}</div>
          {contextPct !== null && <div>Context: {contextPct}%</div>}
          <button onClick={onInterrupt} disabled={!chatState.isStreaming}
            style={{ marginTop: 4, border: '2px solid var(--pixel-border)', padding: '2px 6px', cursor: chatState.isStreaming ? 'pointer' : 'default', background: 'var(--pixel-bg)', color: chatState.isStreaming ? '#ff6666' : 'var(--pixel-dim)', fontFamily: 'inherit', fontSize: 10, alignSelf: 'flex-start' }}>
            ⏹ Interrupt
          </button>
        </div>
      )}
    </div>
  );
}
```

Add `MODEL_CONTEXT_LIMITS` and `DEFAULT_CONTEXT_LIMIT` imports from constants (either re-export them from the extension constants file or duplicate in a webview constants file).

- [ ] **Step 3: Verify and commit**

```bash
npm run build
git add webview-ui/src/components/ChatPanel.tsx src/PixelAgentsViewProvider.ts
git commit -m "feat: AgentInspector section in chat panel"
```

---

## Task 20 (Phase 4b): Roles + token bar

**Files:**
- Modify: `webview-ui/src/office/engine/renderer.ts` — add 1px token bar above character
- Modify: `webview-ui/src/components/ChatPanel.tsx` — add role selector in Inspector

- [ ] **Step 1: Add role selector to Inspector**

In the `Inspector` component from Task 19:
```tsx
<div>
  Role:
  <select value={role} onChange={(e) => onRoleChange(e.target.value as AgentRole)}
    style={{ marginLeft: 6, background: 'var(--pixel-bg)', color: 'var(--pixel-fg)', border: '1px solid var(--pixel-dim)', fontFamily: 'inherit', fontSize: 10 }}>
    {(['generalist', 'coder', 'designer', 'writer', 'reviewer'] as AgentRole[]).map((r) => (
      <option key={r} value={r}>{r}</option>
    ))}
  </select>
</div>
```

Wire `onRoleChange` → `vscode.postMessage({ type: 'agentRoleChanged', agentId, role })`. In the extension, handle this message to update `agent.role` in AgentRunner and persist to agents.json.

- [ ] **Step 2: Add role icon overlay on character**

In `webview-ui/src/office/engine/renderer.ts`, after drawing the character sprite, draw a small role icon above the head:

```typescript
const ROLE_ICONS: Record<string, string> = {
  coder: '⌨', designer: '🎨', writer: '✍', reviewer: '🔍',
};
const icon = ROLE_ICONS[agent.role ?? 'generalist'];
if (icon) {
  ctx.font = `${zoom * 6}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(icon, screenX + spriteW / 2, screenY - zoom * 2);
}
```

(Use actual pixel coordinates from the existing renderer — adapt to match the renderer's coordinate system.)

- [ ] **Step 3: Add token bar above character**

In `renderer.ts`, after drawing the character, if `agent.inputTokens > 0` and `zoom >= 2`:

```typescript
const limit = MODEL_CONTEXT_LIMITS[agent.currentModel ?? ''] ?? DEFAULT_CONTEXT_LIMIT;
const pct = Math.min(1, agent.inputTokens / limit);
const barW = spriteW;
const barH = Math.max(1, zoom);
const barY = screenY - barH - zoom; // above character head
const color = pct < 0.5 ? '#44cc44' : pct < 0.8 ? '#ccaa22' : '#cc3333';
// Background
ctx.fillStyle = '#222';
ctx.fillRect(screenX, barY, barW, barH);
// Fill
ctx.fillStyle = color;
ctx.fillRect(screenX, barY, Math.round(barW * pct), barH);
```

`agent.inputTokens` and `agent.currentModel` should be available from the `agentTurnDone` message that updates the office state.

- [ ] **Step 4: Handle role and token state in office**

In `officeState.ts`, track `role`, `inputTokens`, and `currentModel` per character. Update on:
- `agentRoleChanged` → update role in character state
- `agentTurnDone` → update inputTokens + currentModel

- [ ] **Step 5: Verify visuals in Extension Dev Host**

1. Run a prompt on an agent
2. After turn completes, token bar should appear above character (if zoom ≥ 2x)
3. Selecting a non-generalist role should show the icon above the character's head

- [ ] **Step 6: Commit**

```bash
npm run build
git add webview-ui/src/office/engine/renderer.ts webview-ui/src/office/engine/officeState.ts webview-ui/src/components/ChatPanel.tsx src/PixelAgentsViewProvider.ts
git commit -m "feat: roles system + token bar above character (Phase 4)"
```

---

## Post-plan checklist

After all 20 tasks:

- [ ] All `npm run check-types` pass
- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] Manual test in Extension Dev Host: create agent, send prompt, see response stream in ChatPanel, permission bubble appears on unsafe tool, interrupt works
- [ ] Delete `scripts/phase0-sdk-validate.ts` (was throwaway)
- [ ] Final commit: `git commit -m "chore: remove phase 0 throwaway script"`

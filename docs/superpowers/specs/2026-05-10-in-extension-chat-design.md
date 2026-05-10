# In-extension chat — design

**Date:** 2026-05-10
**Author:** Antoine
**Status:** Design (not yet implemented)

## Summary

Replace the current "1 agent = 1 VS Code terminal" architecture with an in-extension chat experience. Each agent is a Claude conversation owned by the extension, runnable in any local repo (not just the open VS Code workspace). The pixel-art office becomes the multi-repo dashboard, and clicking a character opens a slide-in chat panel for that agent.

Includes the small-cost additions from the project vision that fit naturally on the chat panel: roles, token/context stats, and deep inspection (model, branch, system prompt, interrupt). Defers larger ideas (desks-as-directories, Kanban autonomous pickup, custom asset wiring) to their own specs.

## Goals

1. Send prompts to a Claude agent without leaving the extension webview.
2. Show streamed assistant text + tool activity in a chat panel.
3. Spawn agents in any local repo, not just the open VS Code workspace.
4. Use the user's existing Claude Code MAX subscription — no separate API key.
5. Reduce architectural complexity by removing the terminal-adoption + heuristic-detection machinery (no longer needed once we own the process).
6. Add lightweight role/stats/inspection features that lean on data we already collect.

## Non-goals

- Multi-window / multi-VS-Code-instance sync (single window for now).
- Daemonized agents that survive VS Code closing.
- SQLite or any database (JSONL transcripts on disk are persistence).
- Provider abstraction (Claude Code only).
- Kanban / autonomous task pickup (future spec).
- Drag desks-as-directories (future spec).
- Custom characters / furniture (future spec).
- 3D / VR rendering (out of scope, ever).
- **Migrating existing terminal-based agents.** First run on the new version wipes the agent registry. Personal fork, low cost; avoids a class of migration bugs. The chat panel will list "no agents — create one" on first launch.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ VS Code Extension Host                                      │
│  - PixelAgentsViewProvider          (existing, slimmed)     │
│  - AgentRunner                      (NEW)                   │
│      wraps @anthropic-ai/claude-agent-sdk:                  │
│        for await (const ev of query({                       │
│          prompt, options: {                                 │
│            cwd: <repo path>,                                │
│            resume: <session_id>,                            │
│            canUseTool: <permission cb>,                     │
│            env: { PIXEL_AGENTS_ID: <agent id> },            │
│          }})) { dispatch ev → webview }                     │
│  - RepoPicker                       (NEW, vscode dialog)    │
│  - agents.json persistence          (NEW, ~/.pixel-agents)  │
│  - Server                           (existing, unchanged)   │
│  - Hook script                      (small extension: read  │
│                                      PIXEL_AGENTS_ID env)   │
└─────────────────────────────────────────────────────────────┘
                         ▲
                         │ postMessage (existing channel)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Webview (React)                                             │
│  - Office canvas                    (existing)              │
│  - ChatPanel                        (NEW, slide-in right)   │
│  - AgentInspector                   (NEW, panel section)    │
│  - "+ Agent" + RepoPicker UI        (NEW)                   │
│  - Roles overlay on character       (NEW)                   │
│  - Token bar above character        (NEW)                   │
└─────────────────────────────────────────────────────────────┘
```

**Why SDK over CLI subprocess:** the TS Agent SDK wraps the local `claude` binary, so it inherits the user's MAX subscription auth. It also handles process spawning, stdin piping, and gives us a structured async event stream — less code than parsing stream-json manually. Confirmed working in the `ultimate-assistant` repo via Python SDK with empty env.

**Phase 0 validates three SDK capabilities before any Phase 1 code is written:**
1. Auth: `query()` with no env vars uses the user's MAX subscription (confirmed by UA Python SDK pattern).
2. System prompt: `ClaudeAgentOptions` accepts a `systemPrompt` field (needed for role presets; verify TS SDK supports this — UA Python SDK uses `system_prompt=...`).
3. Env propagation: env vars set in `query({ env })` reach the hook script process.

**What we DON'T build:** WebSocket protocol, SQLite, multi-window sync, process daemon, provider abstraction.

## Components

### AgentRunner

One instance per extension activation. Tracks active agents and their in-flight queries.

```ts
class AgentRunner {
  private agents: Map<number, AgentState>
  private inflight: Map<number, AbortController>
  private queues: Map<number, string[]>  // agentId → queued prompt texts

  async sendPrompt(agentId: number, text: string): Promise<void>
  // interrupt cancels the in-flight turn AND clears the queue
  async interrupt(agentId: number): Promise<void>
  async removeAgent(agentId: number): Promise<void>

  // emits events to extension which forwards to webview:
  //   'agentEvent'    { agentId, type: 'text'|'thinking'|'tool_use'|'tool_result'|'system', ...payload }
  //   'agentTurnDone' { agentId, inputTokens, outputTokens }
  //   'agentError'    { agentId, code, message, retryable }
  //   'agentQueued'   { agentId, queueLength }  // sent when a prompt is queued, not started
}
```

Per-agent serialization: a simple per-agent async queue ensures only one turn runs per agent at a time. A second prompt while one is in flight is queued, not interleaved (pattern from UA `turn_queue.py`).

**Error handling.** AgentRunner wraps every SDK call in try/catch. SDK exceptions become `agentError` events with one of:

| `code` | When | UI |
|---|---|---|
| `auth_failed` | SDK reports auth/subscription error | Inline error block + "Open Claude Code login" button |
| `binary_missing` | `claude` CLI not on PATH | Inline error block + install instructions link |
| `cwd_missing` | Repo path doesn't exist on disk | Inline error block + "Browse new path" / "Remove agent" buttons |
| `process_crash` | SDK process exits unexpectedly | Inline error block + "Retry" button |
| `unknown` | Anything else | Inline error block with raw message + "Retry" |

Errors are non-terminal: the agent stays in the registry and can be retried. The character shows a small red `!` overlay until the next successful turn.

### Preflight check

Runs once on extension activation, before any agent can be spawned:

1. `which claude` (or equivalent) → if missing, banner: "Claude Code CLI not found. Install from https://docs.anthropic.com/claude-code/quickstart". Disable "+ Agent" button until present.
2. `claude --version` → if non-zero exit, banner: "Claude Code CLI returned an error. Try `claude` in a terminal to verify."
3. Hook script install: call existing `claudeHookInstaller.installHook()` unconditionally on every activation. This already exists at `server/src/providers/file/claudeHookInstaller.ts` — it (re)writes the bundled hook script to `~/.pixel-agents/hooks/claude-hook.js` and registers it in `~/.claude/settings.json`. Idempotent. Guarantees the script is always present and up to date. If the installer fails (permissions, disk error), log to the output channel and show a dismissible banner warning that hook-based tool routing may be degraded (non-blocking).

No SDK smoke test runs on activation. Auth issues will surface on the first real user prompt as an `agentError(auth_failed)` event. Activation must stay fast (< 500ms in the extension host).

Preflight results are cached in extension memory until next activation.

### Chat panel

Slide-in from the right, ~420px wide, full webview height. Pixel-art styled (sharp corners, hard offset shadows, FS Pixel Sans).

```
┌─────────────────────────────────────┐
│ ▸ celerity                       ✕  │  header: repo basename, close
│   ~/Documents/Work/celerity         │  full path on second line
├─────────────────────────────────────┤
│ [Inspector ▾]                       │  collapsible: model, branch,
│                                     │  context %, system prompt
├─────────────────────────────────────┤
│ [you]  add a button to the homepage │
│ [agent] sure, let me check...       │
│ ▸ Read  src/app/Home.tsx            │
│ ▸ Edit  src/app/Home.tsx            │
│ [agent] Done. Added a primary cta…  │
│ • • •                               │  streaming indicator
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ Type something...               │ │  Enter = send
│ │                              ↵  │ │  Shift+Enter = newline
│ └─────────────────────────────────┘ │
│ [⏹ Interrupt]  (disabled when idle) │  cancels in-flight turn + clears queue
└─────────────────────────────────────┘
```

**Block rendering rules** (concept ported from UA `ToolBlock.tsx`, restyled fresh in pixel aesthetic — not copied):
- **Text block** → bubble with `[agent]` / `[you]` tag.
- **Thinking block** → collapsed grey chip "thinking…", expandable.
- **Tool_use** → single-line pill `▸ ToolName brief-args`. Click expands full input + paired result. Matched to tool_result by the `id` field from the SDK event — never by position. Two concurrent tool_use events render as two pills stacked; each resolves independently when its result arrives.
- **Tool_result** → folded inside its tool_use, never a top-level block.
- **Errors / system messages** → small italic inline notice.
- **Queue indicator** → when a prompt is queued behind an in-flight turn, it appears in the scrollback as a faded bubble with a "queued" chip. Interrupt cancels both the active turn and all queued prompts.

**Webview reconnect.** If the chat panel is closed while a turn is in-flight, events are buffered in the extension host (plain array, max 500 events, then overflow is dropped). On panel reopen, the buffered events are replayed in order before live streaming resumes.

**Streaming behavior:**
- Send → input disables, spinner appears, character animation switches to "typing" (existing FSM).
- Each SDK event appends a block live.
- `ResultMessage` → re-enable input, drop spinner, update token stats.

**Selection coupling:**
- Click character → panel slides in (or swaps content) for that agent.
- Click another character → panel content swaps; scroll position remembered per agent.
- Click empty office tile → panel stays open.
- Esc / ✕ → close panel.
- Spawning a new agent auto-opens its panel.

### AgentInspector (collapsible section in chat panel header)

Shows derived data for the selected agent. All fields read-only except where noted.

| Field | Source |
|---|---|
| Model | SDK `ResultMessage` / per-call config |
| Repo path | agents.json |
| Branch | `git -C <repoPath> rev-parse --abbrev-ref HEAD` (cached, refreshed on focus) |
| Session ID | agents.json |
| System prompt | SDK call config (defaults to Claude Code default; editable per-agent later) |
| Tokens used / context % | sum of `ResultMessage.usage` across this session |
| Tools used (count) | parsed from session JSONL transcript |

Action buttons: **Interrupt** (calls AbortController on inflight query), **Open transcript file** (reveals JSONL in OS file manager), **Remove agent** (with confirm).

### RepoPicker

Triggered by the existing "+ Agent" button.

```
┌──────────────────────────┐
│ Pick a repo:              │
│ ┌───────────────────────┐ │
│ │ Recent:                │ │   from ~/.pixel-agents/config.json
│ │ • celerity            │ │   "recentRepos": [path, ...]
│ │ • ultimate-assistant   │ │
│ │ • pixel-agents         │ │
│ ├───────────────────────┤ │
│ │ [📁 Browse…]          │ │   vscode.window.showOpenDialog
│ └───────────────────────┘ │   { canSelectFolders: true }
└──────────────────────────┘
```

Newly-picked repos move to the top of `recentRepos`, capped at 10. Validation: must be a real directory; if `.git` is missing, show a warning but allow.

### Permission handling

Use SDK `canUseTool` callback.

- Safe tools (`Read`, `Glob`, `Grep`, `LS`, `WebSearch`, `WebFetch`, `NotebookRead`) → auto-approve, no UI.
- Unsafe tools (`Edit`, `Write`, `Bash`, `NotebookEdit`, `MultiEdit`, MCP write tools) →
  - Show existing `...` permission speech bubble on the character.
  - Show inline prompt in chat panel: `Allow Bash: <command preview>?` with [Allow] [Allow always (this session)] [Deny].
  - Resolve `canUseTool` based on click.
- Per-session allowlist held in `AgentState.sessionAllow: Set<string>` (cleared on next session start).

Replaces the existing 7s permission-detection heuristic.

### Roles + stats + token bar (the small additions)

**Role:** `AgentState.role: 'designer'|'coder'|'writer'|'reviewer'|'generalist' = 'generalist'`. Settable per-agent in the inspector.

Affects only:
- A small icon overlay on the character's head (existing sprite cache supports overlays).
- A default system-prompt preset, defined in a hardcoded `ROLE_PROMPTS` const in the extension. User-edited system prompts override the preset.

```ts
const ROLE_PROMPTS = {
  generalist: null,  // use Claude Code default
  coder: "Focus on code changes and tests. Prefer small focused diffs. Run tests after edits.",
  designer: "Focus on UI/UX. Read existing components before proposing changes. Match existing styles.",
  writer: "Focus on prose: docs, copy, READMEs. No code changes unless asked. Match the project's voice.",
  reviewer: "Read first, propose changes second. Identify risks, missing tests, edge cases. Default to suggesting, not editing.",
}
```

Role preset is passed as the `systemPrompt` (TS) / `system_prompt` (Python) option in `ClaudeAgentOptions`. Verify during Phase 0 that the TS SDK accepts this option — UA's Python SDK uses it confirmed. If the TS SDK does not expose system prompt injection, role presets are silently dropped (character shows the role icon but behavior is not affected) and a follow-up spec addresses it when the SDK adds support.

Updating presets later = code change + extension reload. Acceptable for a personal project.

**Stats / token bar:**
- A 1×16px bar above each character's head, showing context usage as % of model limit.
- Color: green (<50%), yellow (50–80%), red (>80%).
- Token total: summed from `ResultMessage.usage.inputTokens + outputTokens` across turns **in the current session**. Kept in-memory only; resets to 0 on new `sessionId` (new session or `/clear`). Not persisted to disk — approximate display only. If the extension restarts, bar shows 0% until the next turn completes.
- Hides at zoom < 2x to avoid clutter.

**Model context limit source.** Hardcoded `MODEL_CONTEXT_LIMITS` map in the extension:

```ts
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-7": 200_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
}
const DEFAULT_CONTEXT_LIMIT = 200_000  // for unknown model ids
```

If a future model id isn't in the map, fall back to `DEFAULT_CONTEXT_LIMIT` and log a warning. Updating limits = code change + reload.

**Tools used overlay:**
- The existing tool-overlay component already shows the active tool name.
- Extend to show a small badge with the count of tool calls in the current turn.

## Persistence

Three files in `~/.pixel-agents/`:

### `agents.json` (NEW — replaces workspaceState)

```jsonc
{
  "version": 1,
  "agents": [
    {
      "id": 1,
      "repoPath": "/Users/antoine/Documents/Work/celerity",
      "displayName": "celerity",
      "sessionId": "uuid-or-null",
      "role": "coder",
      "palette": 0,
      "hueShift": 0,
      "seatId": "chair-uid",
      "createdAt": 1715300000000
    }
  ],
  "nextAgentId": 2
}
```

User-level → multi-window safe → survives VS Code restart. Writes use the existing atomic tmp+rename pattern (same as `layoutPersistence.ts` and `configPersistence.ts`) so concurrent writes from accidentally-opened second windows don't corrupt the file. Last write wins; we don't try to merge concurrent edits (fine for a single-user, single-window-by-design tool).

### `config.json` (existing, extend)

Add:
```jsonc
{
  "externalAssetDirectories": [...],
  "recentRepos": ["/path/...", ...]   // NEW, capped at 10
}
```

### Chat history

Read directly from the existing Claude Code transcript at
`~/.claude/projects/<project-hash>/<session-id>.jsonl`. We do NOT duplicate it. On chat panel open: parse the file once, render existing blocks; live SDK events append on top.

**Project hash derivation** (already used in the existing codebase): replace every `:`, `\`, and `/` in the absolute repo path with `-`. Example: `/Users/antoine/Documents/Work/celerity` → `-Users-antoine-Documents-Work-celerity`. This is the same algorithm the existing `fileWatcher.ts` and `transcriptParser.ts` use; we reuse it unchanged.

**sessionId** is captured from the first `SystemMessage` with `subtype: "init"` that the SDK stream emits. It is written atomically to `agents.json` immediately after capture (see Persistence). If `sessionId` is null (agent never sent a prompt), there is no JSONL file to read — render empty chat.

**Loading state.** While parsing, show a skeleton/spinner in the message area (input box stays disabled). Parsing happens off the main render path (chunked reads).

**Missing or corrupt transcript.** Defined fallbacks:

| Situation | Behavior |
|---|---|
| `sessionId` is null (agent never sent a prompt) | Render empty chat with placeholder "No messages yet." |
| Transcript file missing on disk | Render empty chat. Log warning to extension output channel. Treat next user prompt as turn 1. |
| Transcript file exists but parse fails partway | Render successfully-parsed blocks + inline notice "Transcript truncated at line N" |
| Transcript file corrupt from the start | Render empty chat + inline notice "Could not load transcript history" |

`/clear` creates a new JSONL → SDK returns a new `session_id` on next turn → we update `AgentState.sessionId`.

**Long transcripts.** Phase 1 reads the entire file. The skeleton spinner masks the parse cost. If a session ever has thousands of blocks and parsing exceeds ~1s, virtualize the message list and lazy-parse on scroll. Defer until measured.

## Hook coexistence

Hooks fire for ALL local `claude` invocations including the user's own terminal sessions outside the extension. To filter:

- AgentRunner sets `env: { PIXEL_AGENTS_ID: String(agent.id) }` on every SDK call.
- The hook script (`~/.pixel-agents/hooks/claude-hook.js`) reads `process.env.PIXEL_AGENTS_ID` and includes it in the POST to the local server.
- The server uses `PIXEL_AGENTS_ID` as the primary routing key when present.
- **Fallback for safety:** if a hook event arrives WITHOUT `PIXEL_AGENTS_ID` but with a `session_id` matching a known agent's session, the server still routes it. This guards against env-var propagation failing in some edge case (e.g., the SDK spawning a sub-process that strips env). The session_id matching path is kept; it's a few lines of code and prevents silent regressions.

**Hook installer:** `claudeHookInstaller.installHook()` runs as part of the preflight check on every extension activation. It's already idempotent (writes the bundled hook script atomically + registers in `~/.claude/settings.json` only if not already registered). This guarantees the script is always present and up to date.

## What gets removed

- `agentManager.ts` terminal lifecycle: `createTerminal`, `restoreAgents`, terminal-to-agent matching.
- Terminal adoption scanning loop.
- Heuristic mode polling: 1s main scanner, 3s external scanner, 30s stale check.
- Filesystem-based `/clear` detection (content scan of first 8KB).
- Permission timer (7s) and text-idle timer (`TEXT_IDLE_DELAY_MS`, 5s).
- All "dual-mode" branches in `fileWatcher.ts` (heuristic vs hooks). Only the transcript-read path remains.

What stays for safety:
- Session_id-based hook routing (kept as fallback to env-var routing — see Hook coexistence).

Net effect: meaningful reduction in extension complexity. The remaining code is what the SDK doesn't already handle.

## Build phases

Each phase ships an independently usable improvement.

### Phase 0 — Validate SDK (½ day)
Throwaway script: `npm i @anthropic-ai/claude-agent-sdk`, run `query({ prompt: "say hi", options: { cwd: "/tmp" }})`, no env vars.

Confirm:
- Uses MAX subscription (no API key prompt, no charge to API account).
- `cwd` works for an arbitrary subfolder.
- Second `query` with `resume: <captured session_id>` continues the conversation.
- `canUseTool` callback fires before unsafe tools.

If any of these fails: stop, regroup before building anything else.

### Phase 1 — Core MVP
- Preflight check (claude binary present, hook installer runs, SDK smoke test).
- AgentRunner class with full error-event surface (auth/binary/cwd/crash).
- RepoPicker UI + recent-repos persistence.
- Chat panel with text + tool block rendering, skeleton-loading for transcript parse, fallbacks for missing/corrupt transcript.
- agents.json persistence (atomic tmp+rename). On first launch with no file: empty registry. No migration from old workspaceState — clean slate.
- "+ Agent" replaces terminal flow end-to-end.
- Dead-agent flow: when a turn fails with `cwd_missing`, character shows red `!` overlay; chat panel offers Browse / Remove.

Outcome: extension fully replaces VS Code terminals for the happy path AND the common failure paths.

### Phase 2 — Permissions
- `canUseTool` wired up.
- Inline allow/deny in chat panel.
- Existing `...` speech bubble triggered from `canUseTool`, not the heuristic timer.
- Per-session allowlist.

### Phase 3 — Cleanup
- Delete `agentManager.ts` terminal code.
- Delete heuristic scanners (1s/3s/30s polling, content-based /clear detection).
- Slim `fileWatcher.ts` to "read transcript on panel open" only.
- Wire `PIXEL_AGENTS_ID` env var through the hook script (extend bundled `claude-hook.ts` to read it and include in POST body).
- Update server's hook event handler to prefer `PIXEL_AGENTS_ID` for routing, fall back to session_id matching if absent.

**Do NOT remove** the session_id matching path. It's the fallback if env-var propagation fails.

### Phase 4 — Polish + small additions
- Queue indicator when sending while in-flight.
- Repo basename label below characters at zoom ≥ 3x.
- Right-click → Remove Agent with matrix-rain despawn.
- AgentInspector section in chat panel (model, branch, session ID, system prompt, tokens, interrupt button).
- Roles: per-agent role field, head-icon overlay, default system-prompt preset.
- Token bar above character.
- Tool-count badge on existing tool overlay.

## Risks & open questions

1. **TS SDK auth confirmation** — Phase 0 explicitly validates this. If the TS SDK behaves differently from the Python SDK and demands `ANTHROPIC_API_KEY`, we revert to plan B: spawn the `claude` CLI directly with `--output-format stream-json --input-format stream-json`. Same architecture otherwise; AgentRunner internals change.
2. **Long transcripts** — for sessions with thousands of blocks, the initial parse + render could be slow. Phase 1 reads the whole file with a skeleton spinner masking the cost; pagination/virtualization deferred to Phase 4 only if measured to be a problem.
3. **Multiple inflight tools** — the SDK can run tools in parallel within a turn (Anthropic supports this). Block rendering must not assume strict tool_use → tool_result ordering. Use IDs to pair them.
4. **Hook env propagation** — Phase 0 confirms env vars set via `query({ env })` reach the hook script. Mitigated regardless: session_id matching is kept as a fallback (see Hook coexistence). If env propagation breaks in some future SDK version, hook routing degrades gracefully instead of breaking.
5. **Branch detection latency** — `git rev-parse` is fast (<10ms) but should not block the chat panel render. Cache + refresh async on focus.
6. **JSONL transcript format drift** — we read Claude Code's transcript files directly. If upstream changes the JSONL schema, our parser breaks. Existing `transcriptParser.ts` already handles this brittleness; we accept the same risk. Mitigation: parser is permissive (unknown record types are ignored, partially-malformed lines are skipped with a warning).
7. **MAX subscription unavailable** — preflight catches missing binary. If the user has the binary but their subscription is expired/invalid, the SDK call returns an auth error → AgentRunner emits `agentError(auth_failed)` → chat panel shows actionable error. No silent failure path.

## Future specs (referenced from project vision, not in this spec)

- `custom-characters-and-furniture.md` — wiring user-supplied PNGs into the asset pipeline. Source assets at `dbz_assets/` (DBZ Legacy of Goku II rips: 6 character sheets + 1 furniture tileset). Characters need a preprocessing tool to map source frames → the 112×96 / 7-frame × 3-direction layout the loader expects, plus green-screen → transparent and credit-text stripping. Furniture runs through the existing `scripts/0-import-tileset.ts` pipeline as-is.
- `desks-as-directories.md` — drag-to-assign agent to desk's repo.
- `kanban-autonomous-pickup.md` — wall-placeable board, idle agents take tasks. Has safety / concurrency design questions.

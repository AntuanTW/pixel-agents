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

**What we DON'T build:** WebSocket protocol, SQLite, multi-window sync, process daemon, provider abstraction.

## Components

### AgentRunner

One instance per extension activation. Tracks active agents and their in-flight queries.

```ts
class AgentRunner {
  private agents: Map<number, AgentState>
  private inflight: Map<number, AbortController>

  async sendPrompt(agentId: number, text: string): Promise<void>
  async interrupt(agentId: number): Promise<void>
  async removeAgent(agentId: number): Promise<void>

  // emits events to extension which forwards to webview:
  //   'agentEvent' { agentId, event: SDKEvent }
  //   'agentTurnDone' { agentId, tokens, cost }
}
```

Per-agent serialization: a simple per-agent async queue ensures only one turn runs per agent at a time. A second prompt while one is in flight is queued, not interleaved (pattern from UA `turn_queue.py`).

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
│ │ Type something...               │ │  multiline; ⌘/Ctrl+Enter
│ │                              ↵  │ │  to send
│ └─────────────────────────────────┘ │
│ [⏹ Interrupt]                       │  shown only while in-flight
└─────────────────────────────────────┘
```

**Block rendering rules** (concept ported from UA `ToolBlock.tsx`, restyled fresh in pixel aesthetic — not copied):
- **Text block** → bubble with `[agent]` / `[you]` tag.
- **Thinking block** → collapsed grey chip "thinking…", expandable.
- **Tool_use** → single-line pill `▸ ToolName brief-args`. Click expands full input + paired result.
- **Tool_result** → folded inside its tool_use, never a top-level block.
- **Errors / system messages** → small italic inline notice.

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

**Role:** `AgentState.role: 'designer'|'coder'|'writer'|'reviewer'|'generalist' = 'generalist'`. Settable per-agent in the inspector. Affects only:
- A small icon overlay on the character's head (existing sprite cache supports overlays).
- A default system prompt preset (e.g., "You are acting as a code reviewer for this repo.") — the user can override.

**Stats / token bar:**
- A 1×16px bar above each character's head, showing context usage as % of model limit.
- Color: green (<50%), yellow (50–80%), red (>80%).
- Updated on every `ResultMessage` from any turn.
- Hides at zoom < 2x to avoid clutter.

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

User-level → multi-window safe → survives VS Code restart.

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

`/clear` creates a new JSONL → SDK returns a new `session_id` on next turn → we update `AgentState.sessionId`.

## Hook coexistence

Hooks fire for ALL local `claude` invocations including the user's own terminal sessions outside the extension. To filter:

- AgentRunner sets `env: { PIXEL_AGENTS_ID: String(agent.id) }` on every SDK call.
- The hook script (`~/.pixel-agents/hooks/claude-hook.js`) reads `process.env.PIXEL_AGENTS_ID` and includes it in the POST to the local server.
- The server only forwards events that carry a known `PIXEL_AGENTS_ID`.

Replaces the current "match by session_id discovered from JSONL" logic, which was needed only because we didn't control the launch environment.

## What gets removed

- `agentManager.ts` terminal lifecycle: `createTerminal`, `restoreAgents`, terminal-to-agent matching.
- Terminal adoption scanning loop.
- Heuristic mode polling: 1s main scanner, 3s external scanner, 30s stale check.
- Filesystem-based `/clear` detection (content scan of first 8KB).
- Permission timer (7s) and text-idle timer (`TEXT_IDLE_DELAY_MS`, 5s).
- All "dual-mode" branches in `fileWatcher.ts` (heuristic vs hooks). Only the transcript-read path remains.

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
- AgentRunner class.
- RepoPicker UI + recent-repos persistence.
- Chat panel with text + tool block rendering.
- agents.json persistence (with one-shot migration from existing workspaceState if present).
- "+ Agent" replaces terminal flow end-to-end.

Outcome: extension fully replaces VS Code terminals for the happy path.

### Phase 2 — Permissions
- `canUseTool` wired up.
- Inline allow/deny in chat panel.
- Existing `...` speech bubble triggered from `canUseTool`, not the heuristic timer.
- Per-session allowlist.

### Phase 3 — Cleanup
- Delete `agentManager.ts` terminal code.
- Delete heuristic scanners.
- Slim `fileWatcher.ts` to "read transcript on panel open" only.
- Wire `PIXEL_AGENTS_ID` env var through the hook script.

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
2. **Long transcripts** — for sessions with thousands of blocks, the initial parse + render could be slow. Phase 1 reads the whole file; pagination/virtualization deferred to Phase 4 only if it's actually a problem.
3. **Multiple inflight tools** — the SDK can run tools in parallel within a turn (Anthropic supports this). Block rendering must not assume strict tool_use → tool_result ordering. Use IDs to pair them.
4. **Hook env propagation** — confirm in Phase 0 that env vars set in `query({ env })` propagate to the hook script's process. If not, fall back to identifying agents by session_id (current approach).
5. **Branch detection latency** — `git rev-parse` is fast (<10ms) but should not block the chat panel render. Cache + refresh async on focus.

## Future specs (referenced from project vision, not in this spec)

- `custom-characters-and-furniture.md` — wiring user-supplied PNGs into the asset pipeline. Source assets at `dbz_assets/` (DBZ Legacy of Goku II rips: 6 character sheets + 1 furniture tileset). Characters need a preprocessing tool to map source frames → the 112×96 / 7-frame × 3-direction layout the loader expects, plus green-screen → transparent and credit-text stripping. Furniture runs through the existing `scripts/0-import-tileset.ts` pipeline as-is.
- `desks-as-directories.md` — drag-to-assign agent to desk's repo.
- `kanban-autonomous-pickup.md` — wall-placeable board, idle agents take tasks. Has safety / concurrency design questions.

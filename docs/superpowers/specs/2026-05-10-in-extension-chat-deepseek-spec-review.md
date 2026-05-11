# DeepSeek Plan Review

**Plan:** 2026-05-10-in-extension-chat-design.md
**Overall Assessment:** NEEDS_WORK

## Critical Issues (BLOCKERS)

*None*

## Assumptions to Question

- **The local server for hook events is always running when the extension is activated.** — The spec says hooks fire for all local claude invocations and the hook script POSTs to the local server. If the server is not started or fails to start, hook events are silently lost (fire-and-forget). The spec mentions this is resilient when server is unreachable, but doesn't define startup ordering or failure handling for the server itself. If the server fails to start, the extension might still function but tool routing may be degraded without clear indication to the user beyond a dismissible banner.

- **The TS SDK will support systemPrompt option for role presets.** — Phase 0 validates this. If unsupported, role presets are silently dropped, which means the user sees a role icon but no behavior change, potentially causing confusion. The spec acknowledges this but does not specify showing a warning to the user when role is set but unsupported. This could lead to a feature that appears broken.

- **The canvas and character animation FSM from the existing codebase remain compatible with the new chat panel interactions.** — The spec reuses existing UI components (office canvas, characters, speech bubbles) but adds new overlays and animations. It's possible that the existing state machine or rendering pipeline doesn't support per-agent overlays or queued states cleanly, leading to implementation complexity.

## Spec-Plan Gaps

- **Handling of permission dialog when chat panel is closed.** — If canUseTool triggers a permission request while the chat panel is not open (e.g., user closes it after sending a prompt), the extension host must present the allow/deny prompt. The spec says 'Show inline prompt in chat panel', but doesn't address the panel visibility. Without a defined behavior, the agent could hang indefinitely waiting for permission that the user cannot see. This ambiguity could lead to a deadlock where the inflight turn never progresses and no error is shown.

- **Upgrade detection logic for showing the one-time migration banner absent.** — The spec says 'On first launch after upgrade, show a one-time banner ...'. But it doesn't specify how to detect this condition. The implementation could use the existence of old workspaceState data or a version field in config.json, but without explicit design, the implementer may need to guess, leading to potential missed banner or repeated showing.

- **Role preset silently dropped without user warning if SDK lacks systemPrompt support.** — The spec says if systemPrompt is not supported, role presets are 'silently dropped' and the user sees the role icon but no behavioral change. This could mislead users into thinking the role feature works when it doesn't. At minimum, a visual indication (e.g., role icon greyed out, tooltip) or a one-time warning should be considered.

- **No specification for token bar behavior after model change within a session.** — The token bar uses hardcoded model limits. If the model changes mid-session (e.g., via user editing system prompt or claude config), the bar might use the wrong limit, showing inaccurate context %. While approximate, this could cause confusion if the display is clearly wrong.

## Feasibility Concerns

*None*

## Blind Spots

- **Extension deactivation with inflight turns.** — When VS Code closes or extension deactivates, the AgentRunner may have inflight queries. The spec doesn't define what happens to these processes. The SDK might terminate them, leaving the transcript incomplete. On next launch, the sessionId is still in agents.json, and resuming could fail or yield unexpected state (since the turn wasn't completed). While the spec handles session_not_found errors, the user might lose the inflight context. A shutdown hook to interrupt and finalize could mitigate, but none is mentioned.

- **Concurrent writes to agents.json from multiple windows could cause data loss on Windows.** — The spec says 'Last write wins' and relies on atomic tmp+rename. On Windows, rename may not be atomic if the file is open, and two processes could clash. The spec acknowledges 'single-window-by-design' but offers no guard. If the user accidentally opens a second window, they might lose agent state silently. This could be a support issue.

- **Token bar resets to 0 on extension restart, losing context visibility.** — The token bar is meant to show 'current context window occupancy', but on restart it zeros out. This means that after restart, all agents appear to have empty context, which is misleading if the user resumes a long conversation. While 'approximate display only', it undermines the purpose of the bar if it's frequently inaccurate.

## Architectural Concerns

- **Tight coupling to Claude Code SDK and transcript format.** — The spec builds directly on @anthropic-ai/claude-agent-sdk and reads Claude Code's proprietary JSONL transcript format. Any upstream change could break the extension. While mitigated by Phase 0 validation and permissive parsing, this creates a fragile dependency that might require frequent updates. This is acceptable for a personal project but may surprise future maintainers.

- **No abstraction for agent management; agents.json may become a bottleneck.** — All agent state is in a single file at the user level, with no versioning beyond a top-level version field. If the spec later adds features like custom characters, multiple windows, or daemonized agents, this flat file could become a scaling bottleneck. The design works for Phase 1 but may require refactoring later.

## Minor Suggestions

- Clarify whether clicking the same character again closes the chat panel or does nothing.
- Specify when the '!' error overlay is cleared: only after a successful retry? Or also if the user manually clears the error?
- Define what happens to queued prompts when the agent is removed; should they be discarded?
- Mention that the chat panel's interrupt button should also be visible during permission prompts (to cancel the turn if stuck waiting).
- Consider making the token bar optional or adding a tooltip explaining it's approximate and resets on restart.
- For the RepoPicker, note that browsing will show a native OS dialog; ensure it's clear the user can cancel.

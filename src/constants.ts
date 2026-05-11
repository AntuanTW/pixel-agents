// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const CONFIG_FILE_NAME = 'config.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';

// ── Settings Persistence (VS Code globalState keys) ─────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
export const GLOBAL_KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
export const GLOBAL_KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
export const GLOBAL_KEY_HOOKS_ENABLED = 'pixel-agents.hooksEnabled';
export const GLOBAL_KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
export const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';
export const TERMINAL_NAME_PREFIX = 'Claude Code';

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

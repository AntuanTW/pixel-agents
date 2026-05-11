// eslint-disable-next-line @typescript-eslint/no-require-imports
const { query: sdkQuery } = require('@anthropic-ai/claude-agent-sdk') as {
  query: (params: { prompt: string; options?: SDKOptions }) => SDKQuery;
};

import { ROLE_PROMPTS } from './constants.js';
import { updateAgentSessionId } from './agentsPersistence.js';
import type { PersistedSDKAgent, SDKAgentErrorCode, SDKAgentState } from './types.js';

// ── Local SDK type declarations ───────────────────────────────────────────────
// These mirror the SDK's exported types to avoid ESM→CJS type-import issues.
// The SDK's `query()` is bundled by esbuild at build time.

interface SDKOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  resume?: string;
  systemPrompt?: string;
  canUseTool?: unknown;
  [key: string]: unknown;
}

interface SDKSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  [key: string]: unknown;
}

interface SDKSystemOtherMessage {
  type: 'system';
  subtype: string;
  [key: string]: unknown;
}

interface SDKAssistantMessage {
  type: 'assistant';
  [key: string]: unknown;
}

interface SDKUserMessage {
  type: 'user';
  [key: string]: unknown;
}

interface SDKResultSuccess {
  type: 'result';
  subtype: 'success';
  usage: { input_tokens: number; output_tokens: number; [key: string]: unknown };
  modelUsage?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SDKResultError {
  type: 'result';
  subtype: string; // 'error_max_turns' | 'error_during_execution' | etc.
  [key: string]: unknown;
}

type SDKMessage =
  | SDKSystemInitMessage
  | SDKSystemOtherMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultSuccess
  | SDKResultError;

interface SDKQuery extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
}

// ── Event types ───────────────────────────────────────────────────────────────

// Events emitted by AgentRunner to be forwarded to the webview
export type AgentRunnerEvent =
  | { kind: 'sdkMessage'; agentId: number; msg: SDKMessage }
  | { kind: 'turnDone'; agentId: number; inputTokens: number; outputTokens: number; model: string }
  | { kind: 'error'; agentId: number; code: SDKAgentErrorCode; message: string; retryable: boolean }
  | { kind: 'queued'; agentId: number; queueLength: number }
  | { kind: 'sessionId'; agentId: number; sessionId: string };

type EventCallback = (event: AgentRunnerEvent) => void;

// ── AgentRunner ───────────────────────────────────────────────────────────────

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
      q.interrupt().catch(() => {}); // SDK background cleanup may reject
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
    const options: SDKOptions = {
      cwd: agent.repoPath,
      env: { ...process.env, PIXEL_AGENTS_ID: String(agentId) },
    };
    if (agent.sessionId) options.resume = agent.sessionId;
    if (rolePrompt) options.systemPrompt = rolePrompt;
    // NOTE: canUseTool is added in Phase 2

    const q = sdkQuery({ prompt, options });
    this.inflight.set(agentId, q);

    try {
      for await (const msg of q) {
        if (!this.inflight.has(agentId)) break; // interrupted
        this.dispatchSDKMessage(agentId, agent, msg);
      }
    } catch (err) {
      const code = this.classifyError(err);
      const message = String(err);
      agent.errorCode = code;
      agent.lastErrorMessage = message;
      this.onEvent({ kind: 'error', agentId, code, message, retryable: code !== 'binary_missing' && code !== 'auth_failed' });

      if (code === 'session_not_found') {
        agent.sessionId = null;
        updateAgentSessionId(agentId, null);
      }
    } finally {
      this.inflight.delete(agentId);

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
    if (msg.type === 'system' && msg.subtype === 'init') {
      const initMsg = msg as SDKSystemInitMessage;
      if (agent.sessionId !== initMsg.session_id) {
        agent.sessionId = initMsg.session_id;
        updateAgentSessionId(agentId, initMsg.session_id);
        this.onEvent({ kind: 'sessionId', agentId, sessionId: initMsg.session_id });
      }
    }

    // Capture token usage and model from ResultMessage
    if (msg.type === 'result' && msg.subtype === 'success') {
      const r = msg as SDKResultSuccess;
      agent.inputTokens = r.usage.input_tokens;
      const firstModel = r.modelUsage ? Object.keys(r.modelUsage)[0] ?? null : null;
      if (firstModel) agent.currentModel = firstModel;
      this.onEvent({
        kind: 'turnDone',
        agentId,
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
        model: agent.currentModel ?? '',
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
    if (msg.includes('binary') || msg.includes('not found') || msg.includes('command not found')) return 'binary_missing';
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

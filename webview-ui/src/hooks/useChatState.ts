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

  const handleQueued = useCallback((agentId: number, queueLength: number) => {
    updateAgent(agentId, (s) => ({
      ...s,
      blocks: [...s.blocks, { blockType: 'queued', id: `q-${Date.now()}`, text: `Queued (${queueLength})` }],
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

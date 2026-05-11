import React, { useEffect, useRef, useState } from 'react';
import type { AgentChatState } from '../hooks/useChatState.js';
import { ChatBlockRenderer } from './ChatBlocks.js';
import { MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT } from '../../../src/constants.js';
import type { AgentRole } from '../../../src/types.js';

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 0,
  bottom: 0,
  width: 420,
  background: 'var(--pixel-bg)',
  borderLeft: '2px solid var(--pixel-border)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 50,
  boxShadow: '-4px 0px 0px #0a0a14',
};

const headerStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '2px solid var(--pixel-border)',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 14,
  color: 'var(--pixel-header-text)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 10px',
};

const inputRowStyle: React.CSSProperties = {
  borderTop: '2px solid var(--pixel-border)',
  padding: '6px 8px',
  display: 'flex',
  gap: 6,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: '#0d0d1a',
  border: '2px solid var(--pixel-border)',
  padding: '6px 8px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: 'var(--pixel-text)',
  outline: 'none',
};

const sendBtnStyle: React.CSSProperties = {
  background: 'var(--pixel-accent)',
  border: '2px solid var(--pixel-border)',
  padding: '6px 12px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: '#fff',
  cursor: 'pointer',
  boxShadow: '2px 2px 0px #0a0a14',
};

interface ChatPanelProps {
  agentId: number;
  displayName: string;
  chatState: AgentChatState | undefined;
  onSend: (agentId: number, text: string) => void;
  onInterrupt: (agentId: number) => void;
  onClose: () => void;
  onApprove: (agentId: number, requestId: string, toolName: string, always?: boolean) => void;
  onDeny: (agentId: number, requestId: string, toolName: string) => void;
  sessionId?: string | null;
  role?: string;
  branch?: string;
  queueLength?: number;
  onRoleChange?: (role: string) => void;
}

function Inspector({ agent, chatState, branch, onInterrupt, onRoleChange, agentId, queueLength }: {
  agent: { sessionId: string | null; role: string };
  chatState: AgentChatState | undefined;
  branch?: string;
  onInterrupt: (agentId: number) => void;
  onRoleChange?: (role: string) => void;
  agentId: number;
  queueLength: number;
}) {
  const [open, setOpen] = useState(false);
  const inputTokens = chatState?.inputTokens ?? 0;
  const model = chatState?.currentModel ?? '';
  const contextPct = inputTokens > 0 && model
    ? Math.round((inputTokens / (MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT)) * 100)
    : null;
  const isStreaming = chatState?.isStreaming ?? false;
  return (
    <div style={{ borderBottom: '2px solid var(--pixel-border)' }}>
      <div onClick={() => setOpen((o) => !o)} style={{ padding: '4px 10px', cursor: 'pointer', fontSize: 11, color: 'var(--pixel-text-dim)' }}>
        {open ? '▾' : '▸'} Inspector
      </div>
      {open && (
        <div style={{ padding: '4px 10px 8px', fontSize: 10, color: 'var(--pixel-text-dim)', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div>Model: {model || '(pending first turn)'}</div>
          {branch && <div>Branch: {branch}</div>}
          <div>Session: {agent.sessionId ? agent.sessionId.slice(0, 8) + '…' : '(none)'}</div>
          {contextPct !== null && <div>Context: {contextPct}%</div>}
          <div>Queue: {queueLength > 0 ? `${queueLength} pending` : 'empty'}</div>
          <div>
            Role:{' '}
            <select value={agent.role} onChange={(e) => onRoleChange?.(e.target.value as AgentRole)}
              style={{ marginLeft: 6, background: 'var(--pixel-bg)', color: 'var(--pixel-text)', border: '1px solid var(--pixel-border)', fontFamily: 'inherit', fontSize: 10 }}>
              {(['generalist', 'coder', 'designer', 'writer', 'reviewer'] as AgentRole[]).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <button onClick={() => onInterrupt(agentId)} disabled={!isStreaming}
            style={{ marginTop: 4, border: '2px solid var(--pixel-border)', padding: '2px 6px', cursor: isStreaming ? 'pointer' : 'default', background: 'var(--pixel-bg)', color: isStreaming ? '#ff6666' : 'var(--pixel-text-dim)', fontFamily: 'inherit', fontSize: 10, alignSelf: 'flex-start' }}>
            ⏹ Interrupt
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ agentId, displayName, chatState, onSend, onInterrupt, onClose, onApprove, onDeny, sessionId, role, branch, queueLength = 0, onRoleChange }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [chatState?.blocks]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(agentId, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const blocks = chatState?.blocks ?? [];
  const isStreaming = chatState?.isStreaming ?? false;
  const permission = chatState?.pendingPermission;

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span>{displayName}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {isStreaming && (
            <button
              onClick={() => onInterrupt(agentId)}
              style={{ background: '#ff4444', border: '2px solid var(--pixel-border)', color: '#fff', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, cursor: 'pointer', padding: '2px 6px' }}
            >
              Stop
            </button>
          )}
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--pixel-text-dim)', fontFamily: 'FS Pixel Sans, monospace', fontSize: 16, cursor: 'pointer', padding: '0 4px' }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Inspector */}
      <Inspector
        agent={{ sessionId: sessionId ?? null, role: role ?? 'generalist' }}
        chatState={chatState}
        branch={branch}
        queueLength={queueLength}
        onInterrupt={onInterrupt}
        onRoleChange={onRoleChange}
        agentId={agentId}
      />

      {/* Permission prompt */}
      {permission && (
        <div style={{ padding: '6px 8px', background: 'rgba(255, 165, 0, 0.1)', borderBottom: '2px solid #ff8c00', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: '#ff8c00' }}>
          <div style={{ marginBottom: 4 }}>Allow <strong>{permission.toolName}</strong>?</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onApprove(agentId, permission.requestId, permission.toolName)} style={{ background: '#22aa44', border: '2px solid var(--pixel-border)', color: '#fff', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, cursor: 'pointer', padding: '2px 8px' }}>Allow</button>
            <button onClick={() => onApprove(agentId, permission.requestId, permission.toolName, true)} style={{ background: '#2288cc', border: '2px solid var(--pixel-border)', color: '#fff', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, cursor: 'pointer', padding: '2px 8px' }}>Always</button>
            <button onClick={() => onDeny(agentId, permission.requestId, permission.toolName)} style={{ background: '#ff4444', border: '2px solid var(--pixel-border)', color: '#fff', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, cursor: 'pointer', padding: '2px 8px' }}>Deny</button>
          </div>
        </div>
      )}

      {/* Body */}
      <div ref={bodyRef} style={bodyStyle}>
        {blocks.length === 0 && !isStreaming && (
          <div style={{ color: 'var(--pixel-text-dim)', fontFamily: 'FS Pixel Sans, monospace', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
            Chat started. Type a message.
          </div>
        )}
        {blocks.map((block) => (
          <ChatBlockRenderer key={block.id} block={block} />
        ))}
        {isStreaming && (
          <div style={{ color: 'var(--pixel-accent)', fontFamily: 'FS Pixel Sans, monospace', fontSize: 13, marginTop: 4 }}>▌</div>
        )}
      </div>

      {/* Input */}
      <div style={inputRowStyle}>
        <input
          style={inputStyle}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={isStreaming}
        />
        <button style={sendBtnStyle} onClick={handleSend} disabled={isStreaming}>Send</button>
      </div>
    </div>
  );
}

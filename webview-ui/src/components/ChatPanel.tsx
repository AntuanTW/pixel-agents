import React, { useEffect, useRef, useState } from 'react';
import type { AgentChatState } from '../hooks/useChatState.js';
import { ChatBlockRenderer } from './ChatBlocks.js';

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
  onApprove: (agentId: number, requestId: string) => void;
  onDeny: (agentId: number, requestId: string) => void;
}

export function ChatPanel({ agentId, displayName, chatState, onSend, onInterrupt, onClose, onApprove, onDeny }: ChatPanelProps) {
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

      {/* Permission prompt */}
      {permission && (
        <div style={{ padding: '6px 8px', background: 'rgba(255, 165, 0, 0.1)', borderBottom: '2px solid #ff8c00', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: '#ff8c00' }}>
          <div style={{ marginBottom: 4 }}>Allow <strong>{permission.toolName}</strong>?</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onApprove(agentId, permission.requestId)} style={{ background: '#22aa44', border: '2px solid var(--pixel-border)', color: '#fff', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, cursor: 'pointer', padding: '2px 8px' }}>Allow</button>
            <button onClick={() => onDeny(agentId, permission.requestId)} style={{ background: '#ff4444', border: '2px solid var(--pixel-border)', color: '#fff', fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, cursor: 'pointer', padding: '2px 8px' }}>Deny</button>
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

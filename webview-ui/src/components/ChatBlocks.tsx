import React, { useState } from 'react';
import type { ChatBlock, SDKAgentErrorCode } from '../../../src/types.js';

const styles = {
  bubble: (role: 'user' | 'assistant'): React.CSSProperties => ({
    background: role === 'user' ? 'var(--pixel-accent)' : 'var(--pixel-bg)',
    border: '2px solid var(--pixel-border)',
    padding: '6px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--pixel-text)',
  }),
  thinking: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 12,
    color: 'var(--pixel-text-dim)',
    fontStyle: 'italic' as const,
  },
  tool: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 12,
    background: 'rgba(255, 255, 255, 0.04)',
    borderLeft: '2px solid var(--pixel-accent)',
    color: 'var(--pixel-text-dim)',
  },
  error: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 12,
    background: 'rgba(255, 0, 0, 0.1)',
    borderLeft: '2px solid #ff4444',
    color: '#ff6666',
  },
  queued: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 12,
    color: 'var(--pixel-text-dim)',
    fontStyle: 'italic' as const,
  },
};

function BlockUserText({ block, id }: { block: { text: string }; id: string }) {
  return <div key={id} style={styles.bubble('user')}>{block.text}</div>;
}

function BlockAssistantText({ block, id }: { block: { text: string }; id: string }) {
  return <div key={id} style={styles.bubble('assistant')}>{block.text}</div>;
}

function BlockThinking({ block, id }: { block: { text: string }; id: string }) {
  return <div key={id} style={styles.thinking}>Thinking: {block.text.slice(0, 200)}{block.text.length > 200 ? '...' : ''}</div>;
}

function BlockToolUse({ block, id }: { block: { toolId: string; toolName: string; input: unknown; result?: unknown; isError?: boolean }; id: string }) {
  const [showResult, setShowResult] = useState(false);
  const resultStr = block.result ? (typeof block.result === 'string' ? block.result : JSON.stringify(block.result)) : null;
  return (
    <div key={id} style={styles.tool}>
      <div style={{ cursor: 'pointer' }} onClick={() => setShowResult(!showResult)}>
        {showResult ? '▾' : '▸'} {block.toolName}
        {block.isError ? ' ❌' : block.result !== undefined ? ' ✓' : ' …'}
      </div>
      {showResult && resultStr && (
        <div style={{ marginTop: 4, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>
          {resultStr.slice(0, 2000)}
          {resultStr.length > 2000 ? '...' : ''}
        </div>
      )}
    </div>
  );
}

function BlockError({ block, id }: { block: { code: SDKAgentErrorCode; message: string }; id: string }) {
  return <div key={id} style={styles.error}>Error: {block.message}</div>;
}

function BlockQueued({ block, id }: { block: { text: string }; id: string }) {
  return <div key={id} style={styles.queued}>{block.text}</div>;
}

export function ChatBlockRenderer({ block }: { block: ChatBlock }) {
  switch (block.blockType) {
    case 'user-text': return <BlockUserText block={block} id={block.id} />;
    case 'assistant-text': return <BlockAssistantText block={block} id={block.id} />;
    case 'thinking': return <BlockThinking block={block} id={block.id} />;
    case 'tool-use': return <BlockToolUse block={block} id={block.id} />;
    case 'error': return <BlockError block={block} id={block.id} />;
    case 'queued': return <BlockQueued block={block} id={block.id} />;
  }
}

import React, { useState } from 'react';

import type { ChatBlock, SDKAgentErrorCode } from '../../../src/types.js';

const styles = {
  bubble: (role: 'user' | 'assistant'): React.CSSProperties => ({
    background: role === 'user' ? 'var(--color-accent)' : 'var(--color-bg-dark)',
    border: '2px solid var(--color-accent)',
    padding: '8px 10px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 15,
    lineHeight: 1.4,
    color: 'var(--color-text)',
  }),
  thinking: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 13,
    color: 'var(--color-text-muted)',
    fontStyle: 'italic' as const,
  },
  tool: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 13,
    background: 'transparent',
    borderLeft: '2px solid var(--color-accent)',
    color: 'var(--color-text-muted)',
  },
  error: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 13,
    background: 'transparent',
    borderLeft: '2px solid var(--color-danger)',
    color: 'var(--color-status-error)',
  },
  queued: {
    padding: '4px 8px',
    marginBottom: 4,
    fontFamily: 'FS Pixel Sans, monospace',
    fontSize: 13,
    color: 'var(--color-text-muted)',
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
        <div style={{ marginTop: 4, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>
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

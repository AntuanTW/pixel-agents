import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatBlock } from './types.js';

/** Convert absolute repo path to Claude Code's project hash directory name. */
export function repoPathToProjectHash(repoPath: string): string {
  return repoPath.replace(/[:/\\]/g, '-');
}

/** Return path to the JSONL file for a given session. */
export function getTranscriptPath(repoPath: string, sessionId: string): string {
  const hash = repoPathToProjectHash(repoPath);
  return path.join(os.homedir(), '.claude', 'projects', hash, `${sessionId}.jsonl`);
}

interface RawJSONLRecord {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
  };
  content?: unknown;
}

function parseContent(content: unknown): { text?: string; toolUse?: { id: string; name: string; input: unknown } } {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return {};
  for (const block of content as { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
    if (block.type === 'text' && block.text) return { text: block.text };
    if (block.type === 'tool_use' && block.id && block.name) {
      return { toolUse: { id: block.id, name: block.name, input: block.input } };
    }
  }
  return {};
}

export interface TranscriptLoadResult {
  blocks: ChatBlock[];
  truncatedAt?: number;
  error?: 'missing' | 'corrupt';
}

/**
 * Parse a JSONL transcript into ChatBlock array.
 * Permissive: skips unknown lines, truncates on parse error.
 */
export function loadTranscript(transcriptPath: string): TranscriptLoadResult {
  if (!fs.existsSync(transcriptPath)) {
    return { blocks: [], error: 'missing' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { blocks: [], error: 'corrupt' };
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  const blocks: ChatBlock[] = [];
  const toolResultMap = new Map<string, ChatBlock & { blockType: 'tool-use' }>();
  let truncatedAt: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    let record: RawJSONLRecord;
    try {
      record = JSON.parse(lines[i]) as RawJSONLRecord;
    } catch {
      if (i === 0) return { blocks: [], error: 'corrupt' };
      truncatedAt = i;
      break;
    }

    if (!record.type) continue;

    // User text prompt
    if (record.type === 'user' && record.message?.role === 'user') {
      const parsed = parseContent(record.message.content);
      if (parsed.text) {
        blocks.push({ blockType: 'user-text', id: `h-${i}`, text: parsed.text });
      }
      // tool_result: find and update the matching tool_use block
      if (Array.isArray(record.message.content)) {
        for (const c of record.message.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (c.type === 'tool_result' && c.tool_use_id) {
            const target = toolResultMap.get(c.tool_use_id);
            if (target) {
              target.result = c.content;
              target.isError = c.is_error;
            }
          }
        }
      }
    }

    // Assistant message
    if (record.type === 'assistant' && record.message?.role === 'assistant') {
      if (Array.isArray(record.message.content)) {
        for (const block of record.message.content as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text) {
            blocks.push({ blockType: 'assistant-text', id: `h-${i}-txt`, text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            blocks.push({ blockType: 'thinking', id: `h-${i}-thk`, text: block.thinking });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const toolBlock: ChatBlock & { blockType: 'tool-use' } = {
              blockType: 'tool-use',
              id: `h-${i}-tu-${block.id}`,
              toolId: block.id,
              toolName: block.name,
              input: block.input,
            };
            blocks.push(toolBlock);
            toolResultMap.set(block.id, toolBlock);
          }
        }
      }
    }
  }

  return { blocks, truncatedAt };
}

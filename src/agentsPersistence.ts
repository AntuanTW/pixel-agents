import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AGENTS_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';
import type { AgentsFile, PersistedSDKAgent } from './types.js';

const EMPTY_FILE: AgentsFile = { version: 1, agents: [], nextAgentId: 1 };

function getAgentsFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, AGENTS_FILE_NAME);
}

export function readAgentsFile(): AgentsFile {
  try {
    const filePath = getAgentsFilePath();
    if (!fs.existsSync(filePath)) return { ...EMPTY_FILE };
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as AgentsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
      return { ...EMPTY_FILE };
    }
    return parsed;
  } catch (err) {
    console.error('[Pixel Agents] Failed to read agents file:', err);
    return { ...EMPTY_FILE };
  }
}

export function writeAgentsFile(data: AgentsFile): void {
  const filePath = getAgentsFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(data, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write agents file:', err);
  }
}

/** Upsert an agent entry and write atomically. */
export function upsertAgent(agent: PersistedSDKAgent): void {
  const data = readAgentsFile();
  const idx = data.agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) {
    data.agents[idx] = agent;
  } else {
    data.agents.push(agent);
  }
  writeAgentsFile(data);
}

/** Remove an agent entry and write atomically. */
export function removePersistedAgent(agentId: number): void {
  const data = readAgentsFile();
  data.agents = data.agents.filter((a) => a.id !== agentId);
  writeAgentsFile(data);
}

/** Allocate and persist the next agent ID, return it. */
export function allocateNextAgentId(): number {
  const data = readAgentsFile();
  const id = data.nextAgentId;
  data.nextAgentId = id + 1;
  writeAgentsFile(data);
  return id;
}

/** Update only the sessionId for an agent (called when SDK emits init SystemMessage). */
export function updateAgentSessionId(agentId: number, sessionId: string | null): void {
  const data = readAgentsFile();
  const agent = data.agents.find((a) => a.id === agentId);
  if (agent) {
    agent.sessionId = sessionId;
    writeAgentsFile(data);
  }
}

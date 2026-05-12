import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../src/constants.js';

export interface StandaloneSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  watchAllSessions: boolean;
}

const DEFAULTS: StandaloneSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  hooksEnabled: true,
  hooksInfoShown: false,
  watchAllSessions: false,
};

function getSettingsPath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'settings.json');
}

export function readSettings(): StandaloneSettings {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const raw = fs.readFileSync(p, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(partial: Partial<StandaloneSettings>): StandaloneSettings {
  const current = readSettings();
  const next = { ...current, ...partial };
  const p = getSettingsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
  return next;
}

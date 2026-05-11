import { installHooks } from '../server/src/providers/hook/claude/claudeHookInstaller.js';
import { execFileNoThrow } from './utils/execFileNoThrow.js';

export interface PreflightResult {
  binaryOk: boolean;
  hooksOk: boolean;
  errors: string[]; // error codes: 'binary_missing' | 'binary_error' | 'hooks_failed'
}

let cached: PreflightResult | null = null;

export async function runPreflight(
  outputChannel: { appendLine(s: string): void },
): Promise<PreflightResult> {
  if (cached) return cached;

  const errors: string[] = [];

  // Check 1: claude binary present
  const versionResult = await execFileNoThrow('claude', ['--version']);
  if (versionResult.status !== 0) {
    errors.push(
      versionResult.stderr.includes('not found') ? 'binary_missing' : 'binary_error',
    );
    outputChannel.appendLine(
      `[Pixel Agents] Preflight: claude binary check failed: ${versionResult.stderr}`,
    );
  }

  // Check 2: hook installer (idempotent, best-effort)
  let hooksOk = true;
  try {
    installHooks();
  } catch (err) {
    hooksOk = false;
    errors.push('hooks_failed');
    outputChannel.appendLine(
      `[Pixel Agents] Preflight: hook installer failed: ${String(err)}`,
    );
  }

  cached = {
    binaryOk: !errors.some((e) => e === 'binary_missing' || e === 'binary_error'),
    hooksOk,
    errors,
  };
  return cached;
}

export function clearPreflightCache(): void {
  cached = null;
}

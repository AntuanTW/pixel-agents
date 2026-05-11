import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ExecFileResult {
  status: 0 | 1;
  stdout: string;
  stderr: string;
}

/**
 * Runs `file` with `args` (no shell expansion). Never throws.
 * Returns status 0 on success, 1 on any failure.
 */
export async function execFileNoThrow(
  file: string,
  args: string[],
): Promise<ExecFileResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 5000 });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { status: 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

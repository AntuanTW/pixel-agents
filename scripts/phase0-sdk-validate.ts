// scripts/phase0-sdk-validate.ts
// Run: npx tsx scripts/phase0-sdk-validate.ts
// Purpose: validate SDK assumptions before building Phase 1.
// DELETE this file after Phase 0 passes.
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as os from 'os';

const tmpDir = os.tmpdir();
let pass = 0;
let fail = 0;

function ok(label: string): void { console.log(`✅ ${label}`); pass++; }
function err(label: string, e: unknown): void { console.error(`❌ ${label}:`, e); fail++; }

async function main(): Promise<void> {
  // ── Test 1: auth (no env vars → uses MAX subscription) ──────────
  try {
    console.log('\n[1] Auth: query with no env vars (should use MAX subscription)...');
    let session = '';
    const q1 = query({ prompt: 'respond with the single word OK', options: { cwd: tmpDir } });
    for await (const msg of q1) {
      if (msg.type === 'system' && 'session_id' in msg) {
        session = (msg as { session_id: string }).session_id;
      }
      if (msg.type === 'result' && msg.subtype === 'success') {
        ok(`Auth: got result, session_id=${session.slice(0, 8)}...`);
      }
    }

    // ── Test 2: resume ───────────────────────────────────────────
    if (session) {
      console.log('\n[2] Resume: second query with resume session_id...');
      const q2 = query({ prompt: 'respond with the word RESUMED', options: { cwd: tmpDir, resume: session } });
      for await (const msg of q2) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          ok('Resume: completed second turn');
        }
      }
    }
  } catch (e) { err('Auth/Resume', e); }

  // ── Test 3: env propagation ──────────────────────────────────────
  try {
    console.log('\n[3] Env: PIXEL_AGENTS_ID should reach hook script env...');
    // env replaces process.env entirely — must spread existing env to preserve auth credentials
    const q3 = query({
      prompt: 'respond with the word ENVTEST',
      options: { cwd: tmpDir, env: { ...process.env, PIXEL_AGENTS_ID: 'test-42' } },
    });
    for await (const msg of q3) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        ok('Env: query with env completed (verify PIXEL_AGENTS_ID in server logs)');
      }
    }
  } catch (e) { err('Env propagation', e); }

  // ── Test 4: interrupt ────────────────────────────────────────────
  try {
    console.log('\n[4] Interrupt: call q.interrupt() mid-stream...');
    const q4 = query({ prompt: 'count from 1 to 1000 slowly', options: { cwd: tmpDir } });
    let events = 0;
    for await (const msg of q4) {
      void msg;
      events++;
      if (events === 2) {
        void q4.interrupt();
        break;
      }
    }
    ok(`Interrupt: stopped after ${events} events`);
  } catch (e) { err('Interrupt', e); }

  // ── Test 5: async canUseTool ─────────────────────────────────────
  // Note: canUseTool uses --permission-prompt-tool stdio (bidirectional control channel).
  // The SDK runs background async loops for the control channel. We install an
  // unhandledRejection handler to catch SDK cleanup errors so they don't crash the process.
  try {
    console.log('\n[5] canUseTool: async callback should resolve before tool runs...');
    let callbackFired = false;
    let resultSeen = false;

    // Capture SDK background cleanup errors (they happen after for-await ends)
    const sdkCleanupErrors: unknown[] = [];
    const unhandledHandler = (reason: unknown) => { sdkCleanupErrors.push(reason); };
    process.on('unhandledRejection', unhandledHandler);

    // canUseTool intercepts permission prompts when --permission-prompt-tool stdio is active.
    // With settingSources: [], user allow-list is disabled, so any tool requiring permission
    // will go through canUseTool. We write a file with Bash which requires a permission prompt.
    const abortCtrl = new AbortController();
    const q5 = query({
      prompt: 'Run bash: echo test > /tmp/pa-canusetool-test.txt',
      options: {
        cwd: tmpDir, // tmpDir exists
        abortController: abortCtrl,
        permissionMode: 'default',
        settingSources: [], // disable user settings to prevent allow-list bypass
        canUseTool: async (toolName: string) => {
          callbackFired = true;
          console.log(`   canUseTool called for: ${toolName}`);
          return { behavior: 'allow' as const };
        },
      },
    });
    for await (const msg of q5) {
      if (msg.type === 'result') {
        resultSeen = true;
        // Don't break — let SDK clean up naturally via the generator return
      }
    }

    // Give SDK background tasks a moment to settle, then remove handler
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    process.off('unhandledRejection', unhandledHandler);

    if (callbackFired) ok('canUseTool: async callback fired');
    else if (resultSeen) err('canUseTool', 'result received but callback never fired — tool not called');
    else err('canUseTool', 'neither result nor callback seen');

    if (sdkCleanupErrors.length > 0) {
      console.log(`   Note: ${sdkCleanupErrors.length} SDK background cleanup error(s) (non-fatal)`);
    }
  } catch (e) { err('canUseTool', e); }

  console.log(`\n── Phase 0 result: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

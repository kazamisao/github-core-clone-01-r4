// Entry point: the wire contract with the trial environment.
//
// The environment owns the trial clock; this process only has to show up,
// announce where it listens, and stay alive until it is dismissed:
//
//   - MAKEFUN_ENV_URL points at the environment. Missing means there is no
//     trial to join, so the process refuses to start (exit 1).
//   - The server binds port 0 and the kernel assigns a free port; a fixed
//     port is never requested, because the environment dials whatever port
//     gets registered and owns its own well-known port itself.
//   - Registration is POST /register with { port }. A 200 accepts it; a 409
//     means an earlier registration already won and this process simply
//     waits like any other; 400 and 405 are contract violations and abort.
//     Anything else (a refusal, a timeout, a 5xx while the environment is
//     still booting) is retried with exponential backoff.
//   - Completion is polled from GET /done until the body reports
//     { done: true }. Only then does the server close and the process
//     exit 0; the harness reads its export afterwards.
//
// The graded surface is the server built in app.ts; this file is only the
// lifecycle around it, and it talks to nothing but the environment.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no environment to register with\n');
  process.exit(1);
}

/** One environment call may hang at most this long before it counts as failed. */
const CALL_TIMEOUT_MS = 30_000;
/** Backoff between retries: starts at BASE, doubles per failure, never exceeds CAP. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Delay before retry number `failures` (0-based): BASE * 2^failures, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 8));
}

/**
 * POST the bound port to the environment until it accepts. A fatal status
 * (400/405) throws with the status in the message; the caller tells a fatal
 * throw apart from a transient failure by that prefix.
 */
async function registerWithEnv(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffMs(failures));
  }
}

/** Poll the environment until it declares the trial done; never return early. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer yet, or a timed-out poll: the trial is not over either way.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind, register, wait to be dismissed: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await registerWithEnv(bound.port);
  process.stdout.write('[entry] registered; waiting for the environment to finish\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

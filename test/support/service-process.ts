import { type ChildProcess, spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type Options, transformFile } from '@swc/core';

/** The service root. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Where the sources are compiled for a separate process: inside
 * `node_modules` (ignored everywhere), so bare imports resolve to the
 * service's dependencies; `dist/` is never touched.
 */
const OUT = join(ROOT, 'node_modules', '.cache', 'surveillance-test-process');

/** `.swcrc`: legacy decorators with the metadata NestJS injection reads. */
const SWC_OPTIONS: Options = {
  swcrc: false,
  sourceMaps: false,
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    keepClassNames: true,
  },
};

let compiled: Promise<void> | undefined;

/**
 * Compiles `src/` (without tests and test doubles) once per run, laid out
 * like `dist/`: `package.json` and `migrations/` next to `src/`.
 */
function compileService(): Promise<void> {
  compiled ??= (async () => {
    await rm(OUT, { recursive: true, force: true });
    const sources = (
      await readdir(join(ROOT, 'src'), { recursive: true })
    ).filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.spec.ts') &&
        !file.split(/[\\/]/).some((part) => part.startsWith('__')),
    );
    await Promise.all(
      sources.map(async (file) => {
        const { code } = await transformFile(
          join(ROOT, 'src', file),
          SWC_OPTIONS,
        );
        const target = join(OUT, 'src', file.replace(/\.ts$/, '.js'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, code);
      }),
    );
    await copyFile(join(ROOT, 'package.json'), join(OUT, 'package.json'));
    await symlink(join(ROOT, 'migrations'), join(OUT, 'migrations'), 'dir');
  })();
  return compiled;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string')
    throw new Error('No free port');
  return address.port;
}

/** The service running as its own process (`src/main.ts`), e.g. to pause it. */
export interface ServiceProcess {
  readonly url: string;
  /** Its log lines (JSON), newest last; the last 2 000 are kept. */
  readonly logs: readonly string[];
  /** `SIGSTOP`: no event loop, no NATS pulls or heartbeats (a hung process). */
  pause(): void;
  /** `SIGCONT`. */
  resume(): void;
  /** Sum of the samples of a metric, optionally of those with `label` (e.g. `outcome="completed"`). */
  metric(name: string, label?: string): Promise<number>;
  /** `SIGTERM` (resumed first), then `SIGKILL` after 30 s. */
  stop(): Promise<void>;
}

/**
 * Starts the service from its sources (compiled by SWC) as a child process
 * with `env` over test defaults (`NODE_ENV=test`, a free `PORT`); resolves
 * once `/health/ready` answers 200.
 */
export async function startServiceProcess(
  env: Readonly<Record<string, string>>,
): Promise<ServiceProcess> {
  await compileService();
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ['--enable-source-maps', 'src/main.js'],
    {
      // No `.env` there: the process sees exactly `env`.
      cwd: OUT,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        SERVICE_VERSION: '0.0.0-test',
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'info',
        LOG_PRETTY: 'false',
        HOST: '127.0.0.1',
        PORT: String(port),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    createInterface({ input: stream }).on('line', (line) => {
      logs.push(line);
      if (logs.length > 2_000) logs.shift();
    });
  }
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const url = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGCONT');
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    await exited;
    clearTimeout(killer);
  };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Service process exited (${String(child.exitCode ?? child.signalCode)}):\n${logs.slice(-30).join('\n')}`,
      );
    }
    const ready = await fetch(`${url}/health/ready`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `Service process not ready after 120 s:\n${logs.slice(-30).join('\n')}`,
      );
    }
    await sleep(250);
  }

  return {
    url,
    logs,
    pause: () => child.kill('SIGSTOP'),
    resume: () => child.kill('SIGCONT'),
    metric: async (name, label) => {
      const response = await fetch(`${url}/metrics`);
      return (await response.text())
        .split('\n')
        .filter(
          (line) =>
            /^[a-z_]+/.exec(line)?.[0] === name &&
            (label === undefined || line.includes(label)),
        )
        .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
    },
    stop,
  };
}

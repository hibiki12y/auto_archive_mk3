import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ProcessSubprocessRunner } from '../src/core/process-subprocess-runner.js';

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { env?: NodeJS.ProcessEnv } | undefined;
  stdinPayload: string;
  child: FakeChild;
}

function createFakeSpawn(): {
  spawn: (
    command: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => FakeChild;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fakeSpawn = (
    command: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ): FakeChild => {
    const emitter = new EventEmitter() as FakeChild;
    let captured = '';
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString('utf8');
        cb();
      },
    });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    emitter.stdin = stdin;
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    const call: SpawnCall = {
      command,
      args,
      options,
      stdinPayload: '',
      child: emitter,
    };
    calls.push(call);
    stdin.on('finish', () => {
      call.stdinPayload = captured;
    });
    return emitter;
  };
  return { spawn: fakeSpawn, calls };
}

describe('ProcessSubprocessRunner', () => {
  it('rejects unknown commands without spawning', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });
    await expect(
      runner.run({ command: 'rm' as never, args: ['-rf', '/'] }),
    ).rejects.toThrow(/not allowed/);
    expect(fake.calls).toHaveLength(0);
  });

  it('captures stdout/stderr and exit code from a salloc-shaped invocation', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });

    const promise = runner.run({
      command: 'salloc',
      args: ['--no-shell', '--job-name=task-1'],
    });

    const child = fake.calls[0].child;
    child.stdout.push('salloc: Granted job allocation 12345\n');
    child.stdout.push(null);
    child.stderr.push(null);
    await new Promise((resume) => setImmediate(resume));
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Granted job allocation 12345');
    expect(result.stderr).toBe('');
  });

  it('writes stdin payload and emits per-line stderr callbacks', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });
    const lines: string[] = [];

    const promise = runner.run({
      command: 'apptainer',
      args: ['exec', 'image.sif', 'node', 'entry.js'],
      stdin: '{"taskId":"t-1"}',
      onStderrLine: (line) => lines.push(line),
    });

    const call = fake.calls[0];
    call.child.stderr.push('lifecycle: accepted\nlifecycle: runtime-running\n');
    call.child.stderr.push('lifecycle: terminal\n');
    call.child.stderr.push(null);
    call.child.stdout.push('{"cause":{"kind":"success"}}\n');
    call.child.stdout.push(null);
    await new Promise((resume) => setImmediate(resume));
    call.child.emit('close', 0, null);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(call.stdinPayload).toBe('{"taskId":"t-1"}');
    expect(lines).toEqual([
      'lifecycle: accepted',
      'lifecycle: runtime-running',
      'lifecycle: terminal',
    ]);
    expect(result.stdout).toContain('"kind":"success"');
  });

  it('translates spawn errors into a typed rejection', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });

    const promise = runner.run({ command: 'scancel', args: ['12345'] });
    fake.calls[0].child.emit('error', new Error('ENOENT: scancel not found'));

    await expect(promise).rejects.toThrow(/spawn scancel failed/);
  });

  it('honors commandPaths overrides for pinned binaries', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({
      spawn: fake.spawn as never,
      commandPaths: { apptainer: '/opt/apptainer/bin/apptainer' },
    });

    const promise = runner.run({
      command: 'apptainer',
      args: ['exec', 'image.sif'],
    });

    const call = fake.calls[0];
    call.child.stdout.push(null);
    call.child.stderr.push(null);
    await new Promise((resume) => setImmediate(resume));
    call.child.emit('close', 0, null);

    expect(call.command).toBe('/opt/apptainer/bin/apptainer');
    await promise;
  });

  it('does not inherit non-allowlisted host environment variables', async () => {
    const fake = createFakeSpawn();
    const previousSecret = process.env.AUTO_ARCHIVE_SECRET_TOKEN;
    const previousPath = process.env.PATH;
    process.env.AUTO_ARCHIVE_SECRET_TOKEN = 'do-not-leak';
    process.env.PATH = '/usr/bin:/bin';
    try {
      const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });
      const promise = runner.run({ command: 'salloc', args: ['--no-shell'] });
      const call = fake.calls[0];
      call.child.stdout.push(null);
      call.child.stderr.push(null);
      await new Promise((resume) => setImmediate(resume));
      call.child.emit('close', 0, null);
      await promise;

      expect(call.options?.env?.PATH).toBe('/usr/bin:/bin');
      expect(call.options?.env).not.toHaveProperty('AUTO_ARCHIVE_SECRET_TOKEN');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.AUTO_ARCHIVE_SECRET_TOKEN;
      } else {
        process.env.AUTO_ARCHIVE_SECRET_TOKEN = previousSecret;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it('passes selected non-secret SLURM context and operator-approved extra env names only', async () => {
    const fake = createFakeSpawn();
    const previous = {
      SLURM_JOB_ID: process.env.SLURM_JOB_ID,
      SLURM_CLUSTER_NAME: process.env.SLURM_CLUSTER_NAME,
      SLURM_TOKEN: process.env.SLURM_TOKEN,
      SITE_SCRATCH: process.env.SITE_SCRATCH,
    };
    process.env.SLURM_JOB_ID = '12345';
    process.env.SLURM_CLUSTER_NAME = 'kivotos';
    process.env.SLURM_TOKEN = 'do-not-leak';
    process.env.SITE_SCRATCH = '/scratch/aa';
    try {
      const runner = new ProcessSubprocessRunner({
        spawn: fake.spawn as never,
        additionalHostEnvAllowlist: ['SITE_SCRATCH'],
      });
      const promise = runner.run({ command: 'salloc', args: ['--no-shell'] });
      const call = fake.calls[0];
      call.child.stdout.push(null);
      call.child.stderr.push(null);
      await new Promise((resume) => setImmediate(resume));
      call.child.emit('close', 0, null);
      await promise;

      expect(call.options?.env?.SLURM_JOB_ID).toBe('12345');
      expect(call.options?.env?.SLURM_CLUSTER_NAME).toBe('kivotos');
      expect(call.options?.env?.SITE_SCRATCH).toBe('/scratch/aa');
      expect(call.options?.env).not.toHaveProperty('SLURM_TOKEN');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('rejects secret-looking additional host env allowlist names', () => {
    expect(
      () =>
        new ProcessSubprocessRunner({
          additionalHostEnvAllowlist: ['SITE_API_TOKEN'],
        }),
    ).toThrow(/looks secret-bearing/);
  });

  it('overlays request env values after validating they are strings', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });

    const promise = runner.run({
      command: 'apptainer',
      args: ['exec', 'image.sif'],
      env: {
        PATH: '/custom/bin',
        AUTO_ARCHIVE_CHILD_FLAG: '1',
      },
    });
    const call = fake.calls[0];
    call.child.stdout.push(null);
    call.child.stderr.push(null);
    await new Promise((resume) => setImmediate(resume));
    call.child.emit('close', 0, null);
    await promise;

    expect(call.options?.env?.PATH).toBe('/custom/bin');
    expect(call.options?.env?.AUTO_ARCHIVE_CHILD_FLAG).toBe('1');

    await expect(
      runner.run({
        command: 'apptainer',
        args: ['exec'],
        env: { BAD: 123 as never },
      }),
    ).rejects.toThrow(/env override BAD must be a string/);
  });

  it('encodes signal-only termination as 128 + signal code', async () => {
    const fake = createFakeSpawn();
    const runner = new ProcessSubprocessRunner({ spawn: fake.spawn as never });

    const promise = runner.run({ command: 'apptainer', args: ['exec'] });
    const call = fake.calls[0];
    call.child.stdout.push(null);
    call.child.stderr.push(null);
    await new Promise((resume) => setImmediate(resume));
    call.child.emit('close', null, 'SIGTERM');

    const result = await promise;
    expect(result.exitCode).toBe(128 + 15);
  });
});

import { execFile } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs a command without a shell, with a timeout. Never throws. */
export function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 15_000, signal: options.signal, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error ? error.message : undefined,
        });
      },
    );
  });
}

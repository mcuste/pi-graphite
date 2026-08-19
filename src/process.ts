import { execFile } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
) => Promise<CommandResult>;

export class CommandExecutionError extends Error {
  readonly result: CommandResult;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.name = "CommandExecutionError";
    this.result = result;
  }
}

export class CommandInvocationError extends Error {
  readonly command: string;
  readonly code: string | undefined;

  constructor(command: string, message: string, code: string | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandInvocationError";
    this.command = command;
    this.code = code;
  }
}

export class CommandCancelledError extends Error {
  constructor(command: string) {
    super(`${command} was cancelled.`);
    this.name = "CommandCancelledError";
  }
}

/**
 * Node kills the child once its output passes `maxBuffer`. That is a size limit, not a
 * broken executable, so it gets its own type instead of looking like a failed spawn.
 */
export class CommandOutputLimitError extends Error {
  readonly command: string;
  readonly maxOutputBytes: number;

  constructor(command: string, maxOutputBytes: number, options?: ErrorOptions) {
    super(`${command} produced more than ${maxOutputBytes} bytes of output and was stopped.`, {
      ...options,
    });
    this.name = "CommandOutputLimitError";
    this.command = command;
    this.maxOutputBytes = maxOutputBytes;
  }
}

export const runCommand: CommandRunner = (command, args, options) => {
  if (options.signal?.aborted) {
    return Promise.reject(new CommandCancelledError(command));
  }

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  execFile(
    command,
    [...args],
    {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      signal: options.signal,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (options.signal?.aborted || error?.name === "AbortError") {
        reject(new CommandCancelledError(command));
        return;
      }

      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new CommandOutputLimitError(command, maxOutputBytes, { cause: error }));
        return;
      }

      if (error && typeof error.code !== "number") {
        const detail = error.message.trim();
        reject(
          new CommandInvocationError(
            command,
            `Unable to execute ${command}: ${detail}`,
            typeof error.code === "string" ? error.code : undefined,
            { cause: error },
          ),
        );
        return;
      }

      resolve({
        command,
        args: [...args],
        exitCode: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    },
  );
  return promise;
};

export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
  failureContext: string,
): Promise<CommandResult> {
  const result = await runner(command, args, options);
  if (result.exitCode === 0) {
    return result;
  }

  throw new CommandExecutionError(formatFailure(failureContext, result), result);
}

function formatFailure(context: string, result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  const suffix = output ? `\n${output}` : "";
  return `${context} (exit ${result.exitCode}).${suffix}`;
}

import { CommandCancelledError, type CommandRunner, runChecked } from "./process.js";

const MAX_BRANCH_NAME_LENGTH = 255;

declare const branchNameBrand: unique symbol;
declare const existingBranchNameBrand: unique symbol;

/** A branch name that passed syntax checks and `git check-ref-format --branch`. */
export type ParsedBranchName = string & { readonly [branchNameBrand]: true };

/** A parsed branch name whose `refs/heads/<name>` ref was also confirmed to exist. */
export type ParsedExistingBranchName = ParsedBranchName & {
  readonly [existingBranchNameBrand]: true;
};

/**
 * Rejects values that could turn into a command-line option or split an argument
 * before Git or Graphite ever sees them.
 */
export function hasSafeBranchSyntax(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BRANCH_NAME_LENGTH &&
    value === value.trim() &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

export async function parseBranchName(
  runner: CommandRunner,
  value: unknown,
  label: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ParsedBranchName> {
  if (!hasSafeBranchSyntax(value)) {
    throw new Error(`${label} is not a safe branch name: ${JSON.stringify(value)}.`);
  }

  try {
    await runChecked(
      runner,
      "git",
      ["check-ref-format", "--branch", value],
      { cwd, signal },
      `${label} is not a valid Git branch name`,
    );
  } catch (error) {
    if (error instanceof CommandCancelledError) {
      throw error;
    }
    throw new Error(`${label} is not a valid Git branch name: ${JSON.stringify(value)}.`, {
      cause: error,
    });
  }
  return value as ParsedBranchName;
}

export async function parseExistingBranchName(
  runner: CommandRunner,
  value: unknown,
  label: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ParsedExistingBranchName> {
  const branch = await parseBranchName(runner, value, label, cwd, signal);
  await assertBranchExists(runner, branch, label, cwd, signal);
  return branch as ParsedExistingBranchName;
}

async function assertBranchExists(
  runner: CommandRunner,
  branch: ParsedBranchName,
  label: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await runChecked(
      runner,
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd, signal },
      `${label} does not name an existing local branch`,
    );
  } catch (error) {
    if (error instanceof CommandCancelledError) {
      throw error;
    }
    throw new Error(`${label} does not name an existing local branch: ${JSON.stringify(branch)}.`, {
      cause: error,
    });
  }
}

export async function assertBranchMissing(
  runner: CommandRunner,
  branch: string,
  label: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runner("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
    signal,
  });
  if (result.exitCode === 0) {
    throw new Error(`${label} still exists: ${JSON.stringify(branch)}.`);
  }
}

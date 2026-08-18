import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  hasSafeBranchSyntax,
  type ParsedExistingBranchName,
  parseExistingBranchName,
} from "./branch.js";
import {
  CommandCancelledError,
  CommandExecutionError,
  type CommandResult,
  type CommandRunner,
  runChecked,
  runCommand,
} from "./process.js";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = "pi-graphite.json";
const SUPPORTED_GT_VERSION = "1.8.6";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface StoredCapability {
  readonly schemaVersion: number;
  readonly usesGraphite: boolean;
  readonly repositoryRoot: string;
  readonly gtVersion: typeof SUPPORTED_GT_VERSION;
  readonly trunk: string;
  readonly verifiedAt: string;
}

export interface GitRepository {
  readonly root: string;
  readonly gitDir: string;
  readonly cachePath: string;
}

export interface GraphiteCapability {
  readonly repository: GitRepository;
  readonly gtVersion: string;
  readonly trunk: ParsedExistingBranchName;
  readonly cache: "memory" | "persistent" | "written" | "unavailable";
  readonly cacheWarning?: string;
}

interface DetectedCapability {
  readonly gtVersion: typeof SUPPORTED_GT_VERSION;
  readonly trunk: ParsedExistingBranchName;
}

interface RememberedCapability {
  readonly capability: Omit<GraphiteCapability, "cache">;
  readonly expiresAt: number;
}

function parseStoredCapability(
  value: unknown,
  repository: GitRepository,
  now = Date.now(),
): StoredCapability | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const schemaVersion = Reflect.get(value, "schemaVersion");
  const usesGraphite = Reflect.get(value, "usesGraphite");
  const repositoryRoot = Reflect.get(value, "repositoryRoot");
  const gtVersion = Reflect.get(value, "gtVersion");
  const trunk = Reflect.get(value, "trunk");
  const verifiedAt = Reflect.get(value, "verifiedAt");
  if (
    schemaVersion !== CACHE_SCHEMA_VERSION ||
    usesGraphite !== true ||
    repositoryRoot !== repository.root ||
    gtVersion !== SUPPORTED_GT_VERSION ||
    !hasSafeBranchSyntax(trunk) ||
    typeof verifiedAt !== "string"
  ) {
    return undefined;
  }

  const verifiedTime = Date.parse(verifiedAt);
  if (
    !Number.isFinite(verifiedTime) ||
    verifiedTime > now + CACHE_CLOCK_SKEW_MS ||
    now - verifiedTime > CACHE_MAX_AGE_MS
  ) {
    return undefined;
  }

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    usesGraphite: true,
    repositoryRoot: repository.root,
    gtVersion: SUPPORTED_GT_VERSION,
    trunk,
    verifiedAt: new Date(verifiedTime).toISOString(),
  };
}

function parseGraphiteVersion(result: CommandResult): typeof SUPPORTED_GT_VERSION {
  const raw = result.stdout.trim() || result.stderr.trim();
  const match = /^(?:gt version )?(\d+\.\d+\.\d+)$/u.exec(raw);
  const version = match?.[1];
  if (version !== SUPPORTED_GT_VERSION) {
    const installed = version ?? (raw ? JSON.stringify(raw) : "an unknown version");
    throw new GraphiteUnavailableError(
      `Graphite CLI ${SUPPORTED_GT_VERSION} is required, but ${installed} is installed.`,
    );
  }
  return SUPPORTED_GT_VERSION;
}

function trunkFrom(value: string): string {
  const trunk = value.trim();
  if (!hasSafeBranchSyntax(trunk) || trunk !== value.trimEnd() || /[\n\r]/u.test(trunk)) {
    throw new GraphiteUnavailableError("Graphite detection returned an invalid repository trunk.");
  }
  return trunk;
}

export class GraphiteUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GraphiteUnavailableError";
  }
}

export class GraphiteCapabilityResolver {
  readonly #runner: CommandRunner;
  readonly #memory = new Map<string, RememberedCapability>();

  constructor(runner: CommandRunner = runCommand) {
    this.#runner = runner;
  }

  async ensure(cwd: string, signal?: AbortSignal): Promise<GraphiteCapability> {
    const lookupKey = resolve(cwd);
    const remembered = this.#memory.get(lookupKey);
    if (remembered && remembered.expiresAt > Date.now()) {
      return { ...remembered.capability, cache: "memory" };
    }
    this.#memory.delete(lookupKey);

    const repository = await this.#findRepository(cwd, signal);
    const stored = await this.#readStoredCapability(repository);
    const storedTrunk = stored
      ? await this.#reverifyTrunk(repository, stored.trunk, signal)
      : undefined;
    if (stored && storedTrunk) {
      const capability = {
        repository,
        gtVersion: stored.gtVersion,
        trunk: storedTrunk,
      };
      this.#remember(lookupKey, capability, Date.parse(stored.verifiedAt) + CACHE_MAX_AGE_MS);
      return { ...capability, cache: "persistent" };
    }

    const detected = await this.#detect(repository, signal);
    const cacheWarning = await this.#writeStoredCapability(repository, detected);
    const capability = {
      repository,
      gtVersion: detected.gtVersion,
      trunk: detected.trunk,
      ...(cacheWarning ? { cacheWarning } : {}),
    };
    this.#remember(lookupKey, capability, Date.now() + CACHE_MAX_AGE_MS);

    return {
      ...capability,
      cache: cacheWarning ? "unavailable" : "written",
    };
  }

  forget(cwd: string): void {
    const lookupKey = resolve(cwd);
    const remembered = this.#memory.get(lookupKey);
    const repositoryRoot = resolve(remembered?.capability.repository.root ?? cwd);
    for (const [key, entry] of this.#memory) {
      if (key === lookupKey || resolve(entry.capability.repository.root) === repositoryRoot) {
        this.#memory.delete(key);
      }
    }
  }

  clearMemory(): void {
    this.#memory.clear();
  }

  #remember(
    lookupKey: string,
    capability: Omit<GraphiteCapability, "cache">,
    expiresAt: number,
  ): void {
    const remembered = { capability, expiresAt };
    this.#memory.set(lookupKey, remembered);
    this.#memory.set(resolve(capability.repository.root), remembered);
  }

  async #findRepository(cwd: string, signal?: AbortSignal): Promise<GitRepository> {
    let result: CommandResult;
    try {
      result = await runChecked(
        this.#runner,
        "git",
        ["rev-parse", "--show-toplevel", "--absolute-git-dir"],
        { cwd, signal },
        "Unable to locate the Git repository",
      );
    } catch (error) {
      if (error instanceof CommandCancelledError) {
        throw error;
      }
      throw new GraphiteUnavailableError(
        "Graphite tools require a Git worktree. Run the tool from inside a Git repository.",
        { cause: error },
      );
    }

    const lines = result.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    if (
      lines.length !== 2 ||
      !lines[0] ||
      !isAbsolute(lines[0]) ||
      lines[0].includes("\0") ||
      !lines[1] ||
      !isAbsolute(lines[1]) ||
      lines[1].includes("\0")
    ) {
      throw new GraphiteUnavailableError(
        "Git returned an invalid repository location; Graphite cannot run reliably here.",
      );
    }
    const [root, gitDir] = lines;
    return {
      root,
      gitDir,
      cachePath: join(gitDir, CACHE_FILE_NAME),
    };
  }

  async #readStoredCapability(repository: GitRepository): Promise<StoredCapability | undefined> {
    let raw: string;
    try {
      raw = await readFile(repository.cachePath, "utf8");
    } catch {
      return undefined;
    }

    try {
      return parseStoredCapability(JSON.parse(raw), repository);
    } catch {
      return undefined;
    }
  }

  /**
   * Confirms a cached trunk still exists locally. A trunk that was renamed or deleted
   * makes the cache stale, so detection runs again instead of failing the tool call.
   */
  async #reverifyTrunk(
    repository: GitRepository,
    trunk: string,
    signal: AbortSignal | undefined,
  ): Promise<ParsedExistingBranchName | undefined> {
    try {
      return await parseExistingBranchName(this.#runner, trunk, "trunk", repository.root, signal);
    } catch (error) {
      if (error instanceof CommandCancelledError) {
        throw error;
      }
      return undefined;
    }
  }

  async #detect(repository: GitRepository, signal?: AbortSignal): Promise<DetectedCapability> {
    let versionResult: CommandResult;
    try {
      versionResult = await runChecked(
        this.#runner,
        "gt",
        ["--version"],
        { cwd: repository.root, signal },
        "Unable to read the Graphite CLI version",
      );
    } catch (error) {
      if (error instanceof CommandCancelledError) {
        throw error;
      }
      throw new GraphiteUnavailableError(
        "The Graphite CLI is unavailable. Install `gt` and ensure it is on PATH.",
        { cause: error },
      );
    }

    const gtVersion = parseGraphiteVersion(versionResult);

    let trunkResult: CommandResult;
    try {
      trunkResult = await runChecked(
        this.#runner,
        "gt",
        ["trunk", "--no-interactive"],
        { cwd: repository.root, signal },
        "Graphite could not read the repository trunk",
      );
    } catch (error) {
      if (error instanceof CommandCancelledError) {
        throw error;
      }
      const detail = error instanceof CommandExecutionError ? `\n${error.message}` : "";
      throw new GraphiteUnavailableError(
        `This Git repository is not ready for Graphite. Run \`gt init\` and retry.${detail}`,
        { cause: error },
      );
    }

    const requested = trunkFrom(trunkResult.stdout);
    let trunk: ParsedExistingBranchName;
    try {
      trunk = await parseExistingBranchName(
        this.#runner,
        requested,
        "trunk",
        repository.root,
        signal,
      );
    } catch (error) {
      if (error instanceof CommandCancelledError) {
        throw error;
      }
      throw new GraphiteUnavailableError(
        `Graphite returned trunk ${JSON.stringify(requested)}, but it is not an existing local branch.`,
        { cause: error },
      );
    }

    return { gtVersion, trunk };
  }

  async #writeStoredCapability(
    repository: GitRepository,
    detected: DetectedCapability,
  ): Promise<string | undefined> {
    const stored: StoredCapability = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      usesGraphite: true,
      repositoryRoot: repository.root,
      gtVersion: detected.gtVersion,
      trunk: detected.trunk,
      verifiedAt: new Date().toISOString(),
    };
    const temporaryPath = `${repository.cachePath}.${process.pid}-${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, repository.cachePath);
      return undefined;
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (await this.#readStoredCapability(repository)) {
        return undefined;
      }
      const detail = error instanceof Error ? error.message : String(error);
      return `Graphite works, but the repository cache could not be written: ${detail}`;
    }
  }
}

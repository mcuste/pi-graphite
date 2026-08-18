import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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

interface StoredCapability {
  readonly schemaVersion: number;
  readonly usesGraphite: boolean;
  readonly repositoryRoot: string;
  readonly gtVersion: string;
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
  readonly trunk: string;
  readonly cache: "memory" | "persistent" | "written" | "unavailable";
  readonly cacheWarning?: string;
}

export class GraphiteUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GraphiteUnavailableError";
  }
}

export class GraphiteCapabilityResolver {
  readonly #runner: CommandRunner;
  readonly #memory = new Map<string, Omit<GraphiteCapability, "cache">>();

  constructor(runner: CommandRunner = runCommand) {
    this.#runner = runner;
  }

  async ensure(cwd: string, signal?: AbortSignal): Promise<GraphiteCapability> {
    const lookupKey = resolve(cwd);
    const remembered = this.#memory.get(lookupKey);
    if (remembered) {
      return { ...remembered, cache: "memory" };
    }

    const repository = await this.#findRepository(cwd, signal);
    const stored = await this.#readStoredCapability(repository);
    if (stored) {
      const capability = {
        repository,
        gtVersion: stored.gtVersion,
        trunk: stored.trunk,
      };
      this.#remember(lookupKey, capability);
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
    this.#remember(lookupKey, capability);

    return {
      ...capability,
      cache: cacheWarning ? "unavailable" : "written",
    };
  }

  forget(cwd: string): void {
    const lookupKey = resolve(cwd);
    const remembered = this.#memory.get(lookupKey);
    const repositoryRoot = resolve(remembered?.repository.root ?? cwd);
    for (const [key, capability] of this.#memory) {
      if (key === lookupKey || resolve(capability.repository.root) === repositoryRoot) {
        this.#memory.delete(key);
      }
    }
  }

  clearMemory(): void {
    this.#memory.clear();
  }

  #remember(lookupKey: string, capability: Omit<GraphiteCapability, "cache">): void {
    this.#memory.set(lookupKey, capability);
    this.#memory.set(resolve(capability.repository.root), capability);
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

    const lines = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const [root, gitDirOutput] = lines;
    if (!root || !gitDirOutput) {
      throw new GraphiteUnavailableError(
        "Git returned an incomplete repository location; Graphite cannot run reliably here.",
      );
    }

    const gitDir = isAbsolute(gitDirOutput) ? gitDirOutput : resolve(cwd, gitDirOutput);
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
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") {
        return undefined;
      }

      const stored = value as Partial<StoredCapability>;
      if (
        stored.schemaVersion !== CACHE_SCHEMA_VERSION ||
        stored.usesGraphite !== true ||
        stored.repositoryRoot !== repository.root ||
        typeof stored.gtVersion !== "string" ||
        stored.gtVersion.length === 0 ||
        typeof stored.trunk !== "string" ||
        stored.trunk.length === 0 ||
        typeof stored.verifiedAt !== "string"
      ) {
        return undefined;
      }

      return stored as StoredCapability;
    } catch {
      return undefined;
    }
  }

  async #detect(
    repository: GitRepository,
    signal?: AbortSignal,
  ): Promise<Pick<StoredCapability, "gtVersion" | "trunk">> {
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

    const gtVersion = versionResult.stdout.trim() || versionResult.stderr.trim();
    const trunk = trunkResult.stdout.trim();
    if (!gtVersion || !trunk) {
      throw new GraphiteUnavailableError(
        "Graphite detection succeeded without returning a CLI version and trunk.",
      );
    }

    return { gtVersion, trunk };
  }

  async #writeStoredCapability(
    repository: GitRepository,
    detected: Pick<StoredCapability, "gtVersion" | "trunk">,
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

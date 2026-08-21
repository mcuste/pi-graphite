import type { GraphiteCapabilityResolver } from "./capability.js";

/** The tool loads on demand, so the model needs this note before it reaches for `git` in bash. */
export const GRAPHITE_PROMPT_NOTE =
  "This repository uses Graphite so use the graphite tool for branch and stack operations instead of git or gt in bash. The tool does not cover remote or publish operations.";

interface BeforeAgentStartEvent {
  readonly systemPrompt?: unknown;
}

interface BeforeAgentStartContext {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

interface BeforeAgentStartResult {
  readonly systemPrompt: string;
}

export interface GraphitePromptApi {
  on?(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent,
      context?: BeforeAgentStartContext,
    ) => Promise<BeforeAgentStartResult | undefined>,
  ): void;
}

/** A host may chain several `before_agent_start` handlers, which must not append the note twice. */
export function registerGraphiteGuidance(
  pi: GraphitePromptApi,
  capabilities: GraphiteCapabilityResolver,
): void {
  pi.on?.("before_agent_start", async (event, context) => {
    const systemPrompt = event?.systemPrompt;
    if (typeof systemPrompt !== "string" || systemPrompt.includes(GRAPHITE_PROMPT_NOTE)) {
      return undefined;
    }

    const capability = await capabilities.tryEnsure(context?.cwd ?? process.cwd(), context?.signal);
    if (!capability) {
      return undefined;
    }

    return { systemPrompt: `${systemPrompt}\n\n${GRAPHITE_PROMPT_NOTE}` };
  });
}

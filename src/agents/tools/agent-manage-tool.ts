import { Type } from "@sinclair/typebox";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const AgentAddSchema = Type.Object({
  id: Type.String({ description: "Agent ID to add (e.g. 'doubao-web', 'kimi-web')" }),
  provider: Type.Optional(
    Type.String({ description: "Provider name (e.g. 'doubao', 'kimi', 'qwen', 'qwen-cn', 'glm')" }),
  ),
  name: Type.Optional(Type.String({ description: "Human-readable display name" })),
});

const AgentRemoveSchema = Type.Object({
  id: Type.String({ description: "Agent ID to remove" }),
});

export function createAgentAddTool(): AnyAgentTool {
  return {
    label: "Agents",
    name: "agent_add",
    description:
      "Add a new agent to the OpenClaw config. Updates openclaw.json agents.list with the new agent entry, making it available for sessions_spawn and agents_list.",
    parameters: AgentAddSchema,
    execute: async (_toolCallId, args) => {
      const agentId = normalizeAgentId(readStringParam(args, "id"));
      if (agentId === "main") {
        return jsonResult({ ok: false, error: "Cannot add/overwrite the 'main' agent." });
      }

      const cfg = loadConfig();
      const existingIds = new Set(
        (Array.isArray(cfg.agents?.list) ? cfg.agents.list : []).map((a) =>
          normalizeAgentId(a.id),
        ),
      );
      if (existingIds.has(agentId)) {
        return jsonResult({ ok: false, error: `Agent '${agentId}' already exists in agents.list. Use agent_remove first to update.` });
      }

      try {
        const result = await readConfigFileSnapshotForWrite();
        const parsed = structuredClone(result.snapshot.parsed) as Record<string, unknown>;
        parsed.agents ??= {};
        (parsed.agents as Record<string, unknown>).list ??= [];

        const entry: Record<string, unknown> = { id: agentId };
        const provider = typeof args.provider === "string" ? args.provider.trim() : "";
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (provider) { entry.provider = provider; }
        if (name) { entry.name = name; }
        entry.subagents ??= { allowAgents: [] };

        (parsed.agents as Record<string, unknown>).list = [
          ...((parsed.agents as Record<string, unknown>).list as Array<unknown>),
          entry,
        ];

        const validated = validateConfigObjectWithPlugins(parsed);
        if (!validated.ok) {
          const issue = validated.issues?.[0];
          return jsonResult({
            ok: false,
            error: `Invalid config after adding agent '${agentId}': ${issue?.path}: ${issue?.message ?? "unknown"}`,
          });
        }
        await writeConfigFile(validated.config, result.writeOptions);

        return jsonResult({
          ok: true,
          agentId,
          provider: provider || null,
          name: name || null,
          message: `Agent '${agentId}' added to agents.list. Restart may be required for full effect.`,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

export function createAgentRemoveTool(): AnyAgentTool {
  return {
    label: "Agents",
    name: "agent_remove",
    description:
      "Remove an agent from the OpenClaw config. Updates openclaw.json by removing the agent from agents.list.",
    parameters: AgentRemoveSchema,
    execute: async (_toolCallId, args) => {
      const agentId = normalizeAgentId(readStringParam(args, "id"));
      if (agentId === "main") {
        return jsonResult({ ok: false, error: "Cannot remove the 'main' agent." });
      }

      try {
        const result = await readConfigFileSnapshotForWrite();
        const parsed = structuredClone(result.snapshot.parsed) as Record<string, unknown>;
        const list = ((parsed.agents as Record<string, unknown> | undefined)?.list ?? []) as Array<{ id: string }>;
        const idx = list.findIndex((a) => normalizeAgentId(a.id) === agentId);
        if (idx === -1) {
          return jsonResult({ ok: false, error: `Agent '${agentId}' not found in agents.list.` });
        }

        const removed = list.splice(idx, 1)[0];
        (parsed.agents as Record<string, unknown>).list = list;

        const validated = validateConfigObjectWithPlugins(parsed);
        if (!validated.ok) {
          const issue = validated.issues?.[0];
          return jsonResult({
            ok: false,
            error: `Invalid config after removing agent '${agentId}': ${issue?.path}: ${issue?.message ?? "unknown"}`,
          });
        }
        await writeConfigFile(validated.config, result.writeOptions);

        return jsonResult({
          ok: true,
          agentId,
          removed,
          message: `Agent '${agentId}' removed from agents.list.`,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
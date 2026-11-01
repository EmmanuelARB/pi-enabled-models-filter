/**
 * enabled-models-filter
 *
 * Enforces the `enabledModels` allowlist from ~/.pi/agent/settings.json as a hard
 * catalog filter, everywhere:
 *
 *   - `pi --list-models` (load-time registration happens before the list-models exit)
 *   - `/model` picker, Ctrl+P cycling, `--model` resolution, session restore
 *   - spawned `pi` subprocesses (subagents) — they load this extension too
 *
 * A session whose model is not enabled fails explicitly (exit 1 with an error in
 * print/RPC mode, graceful shutdown in the TUI) — no silent fallback, no redirect.
 *
 * How it works:
 *   1. `session_start`: the fully composed catalog (ctx.modelRegistry.getAll()) is
 *      snapshotted to ~/.pi/agent/enabled-models-catalog.json. Unseen providers/models
 *      are appended on every session start.
 *   2. Extension load (every pi process): current enabledModels patterns are resolved
 *      against the snapshot; every provider with hidden models is re-registered with
 *      only its allowed models via pi.registerProvider() — the official override API.
 *
 * enabledModels remains the single source of truth. The snapshot only caches model
 * definitions so filtering can happen at load time, before the runtime is composed.
 *
 * Limitations (inherent to pi, not fixable by an extension):
 *   - `pi -ne` (no extensions) bypasses everything.
 *   - Requests made outside pi (curl, other tools) are unreachable.
 *   This is a policy boundary, not a security boundary.
 *
 * Commands:
 *   /enabled-models          — status
 *   /enabled-models refresh  — rebuild the catalog snapshot (unregisters overlays,
 *                              captures base models, re-applies filtering)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ??
  path.join(homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const SNAPSHOT_PATH = path.join(AGENT_DIR, "enabled-models-catalog.json");

const TAG = "[enabled-models-filter]";

interface ModelDef {
  provider: string;
  id: string;
  [key: string]: unknown;
}

interface Snapshot {
  version: 1;
  updatedAt: string;
  models: ModelDef[]; // full unfiltered chat-model catalog
}

function isChatModel(m: ModelDef): boolean {
  return (m.type as string | undefined) === undefined || m.type === "chat";
}

/** Read enabledModels patterns from global settings.json. */
function readEnabledModels(): string[] {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const patterns = settings?.enabledModels;
    return Array.isArray(patterns) ? patterns.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Glob → anchored RegExp ("*" any run, "?" exactly one), like pi's model patterns. */
function patternToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/** Match an enabledModels pattern against provider/id (pi-style: "provider/id", bare id, or glob). */
function patternMatches(pattern: string, provider: string, id: string): boolean {
  const reference = `${provider}/${id}`;
  if (pattern.includes("*") || pattern.includes("?")) {
    const re = patternToRegExp(pattern);
    return re.test(reference) || re.test(id);
  }
  const p = pattern.toLowerCase();
  return p === reference.toLowerCase() || p === id.toLowerCase();
}

function isAllowed(patterns: string[], m: ModelDef): boolean {
  return patterns.some((p) => patternMatches(p, m.provider, m.id));
}

function loadSnapshot(): Snapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.models)) return parsed as Snapshot;
  } catch {
    /* no snapshot yet */
  }
  return null;
}

function saveSnapshot(snapshot: Snapshot): void {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
}

function groupByProvider(models: ModelDef[]): Map<string, ModelDef[]> {
  const byProvider = new Map<string, ModelDef[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider);
    if (list) list.push(m);
    else byProvider.set(m.provider, [m]);
  }
  return byProvider;
}

/**
 * Re-register every provider that has hidden models, keeping only allowed ones.
 * Works both at extension load (queued, applied before --list-models exits) and
 * post-bind (immediate). Providers with nothing hidden are left untouched.
 */
function applyFilter(
  register: (provider: string, config: Record<string, unknown>) => void,
  patterns: string[],
  catalog: ModelDef[],
): { registered: string[]; hiddenCount: number } {
  const byProvider = groupByProvider(catalog);
  const registered: string[] = [];
  let hiddenCount = 0;
  for (const [provider, models] of byProvider) {
    const allowed = models.filter((m) => isAllowed(patterns, m));
    if (allowed.length === models.length) continue; // nothing hidden — don't touch
    hiddenCount += models.length - allowed.length;
    // Override refreshModels too: providers with dynamic catalogs (e.g. OAuth
    // subscriptions) otherwise reintroduce hidden models on every refresh.
    register(provider, {
      models: allowed,
      refreshModels: async () => allowed,
    });
    registered.push(provider);
  }
  return { registered, hiddenCount };
}

export default function (pi: ExtensionAPI) {
  const patterns = readEnabledModels();
  if (patterns.length === 0) return; // no allowlist configured — extension is inert

  const snapshot = loadSnapshot();
  if (snapshot) {
    // Warn about patterns that match nothing (e.g. new model not yet in the snapshot)
    const unmatched = patterns.filter(
      (p) => !snapshot.models.some((m) => patternMatches(p, m.provider, m.id)),
    );
    if (unmatched.length > 0) {
      console.error(
        `${TAG} warning: enabledModels patterns match no model in the catalog snapshot: ${unmatched.join(", ")}. ` +
          `Run /enabled-models refresh inside a session, or delete ${SNAPSHOT_PATH} and start a session to rebuild.`,
      );
    }
    applyFilter(
      (provider, config) => pi.registerProvider(provider, config),
      patterns,
      snapshot.models,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const registry = ctx.modelRegistry;
      const registryModels = registry.getAll().filter(isChatModel);

      if (!snapshot) {
        // First run: create the snapshot from the (unfiltered) registry.
        const fresh: Snapshot = { version: 1, updatedAt: new Date().toISOString(), models: registryModels };
        saveSnapshot(fresh);
        const { registered, hiddenCount } = applyFilter(
          (provider, config) => pi.registerProvider(provider, config),
          patterns,
          fresh.models,
        );
        ctx.ui.notify(
          `${TAG} catalog snapshot created (${fresh.models.length} models). ` +
            `Filtered ${hiddenCount} models from ${registered.length} providers — active everywhere from now on.`,
          "info",
        );
        return;
      }

      // Incremental update: capture providers/models missing from the snapshot.
      // (Snapshot providers are already filtered in the registry; unseen providers are not.)
      const key = (m: ModelDef) => `${m.provider}/${m.id}`;
      let changed = false;
      for (const m of registryModels) {
        const existing = snapshot.models.find((x) => key(x) === key(m));
        if (!existing) {
          snapshot.models.push(JSON.parse(JSON.stringify(m)));
          changed = true;
        } else if (JSON.stringify(existing) !== JSON.stringify(m)) {
          Object.assign(existing, JSON.parse(JSON.stringify(m)));
          changed = true;
        }
      }
      if (changed) {
        snapshot.updatedAt = new Date().toISOString();
        saveSnapshot(snapshot);
      }

      // Hard enforcement (fail-closed): never let a session run with an out-of-scope
      // model. pi's custom-model fallback ("--model provider/unknown-id") synthesizes
      // a model and would still send the request — abort explicitly instead.
      const current = ctx.model as ModelDef | undefined;
      if (current && !isAllowed(patterns, current)) {
        const enabledList = (ctx.scopedModels ?? [])
          .map((sm) => `${sm.model.provider}/${sm.model.id}`)
          .join("\n  ");
        const message =
          `Model "${current.provider}/${current.id}" is not in enabledModels.\n` +
          `Refusing to start. Enabled models:\n  ${enabledList || "(none)"}`;
        if (ctx.mode === "tui") {
          // Graceful shutdown in interactive mode (restores the terminal)
          ctx.ui.notify(`${TAG} ${message}`, "error");
          pi.shutdown();
        } else {
          console.error(`${TAG} ${message}`);
          process.exit(1);
        }
        return;
      }
    } catch (error) {
      console.error(`${TAG} session_start error: ${error instanceof Error ? error.message : error}`);
    }
  });

  pi.registerCommand("enabled-models", {
    description: "Show enabledModels filter status, or refresh the catalog snapshot",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      const registry = ctx.modelRegistry;
      const snap = loadSnapshot();
      const lines: string[] = [];

      if (sub === "refresh") {
        try {
          const fresh: Snapshot = { version: 1, updatedAt: new Date().toISOString(), models: [] };
          const oldByProvider = snap ? groupByProvider(snap.models) : new Map<string, ModelDef[]>();
          const providers = new Set([
            ...oldByProvider.keys(),
            ...registry.getAll().map((m: ModelDef) => m.provider),
          ]);

          for (const provider of providers) {
            // The merged config-style registration (ours over other extensions')
            const config = registry.getRegisteredProviderConfig?.(provider);
            // Remove all overlays — base (builtin/models.json) models become visible
            try {
              registry.unregisterProvider(provider);
            } catch {
              /* never registered via config-style */
            }
            const base = registry
              .getAll()
              .filter((m: ModelDef) => m.provider === provider && isChatModel(m));

            // Extension-only providers (e.g. OAuth subscriptions) vanish when
            // unregistered; keep their definitions from the old snapshot.
            const source = base.length > 0 ? base : (oldByProvider.get(provider) ?? []);
            fresh.models.push(...source.map((m) => JSON.parse(JSON.stringify(m))));

            // Re-register with only allowed models (restores extension-only providers)
            const allowed = source.filter((m) => isAllowed(patterns, m));
            if (config && source.length > 0) {
              registry.registerProvider(provider, { ...config, models: allowed });
            } else if (allowed.length < source.length && source.length > 0) {
              registry.registerProvider(provider, { models: allowed });
            }
          }

          saveSnapshot(fresh);
          lines.push(`${TAG} snapshot rebuilt: ${fresh.models.length} models, ${providers.size} providers`);
        } catch (error) {
          lines.push(`${TAG} refresh failed: ${error instanceof Error ? error.message : error}`);
        }
      } else if (sub && sub !== "status") {
        lines.push(`${TAG} usage: /enabled-models [status|refresh]`);
      }

      // Status
      const scope = ctx.scopedModels ?? [];
      lines.push(`enabledModels patterns: ${patterns.length}`);
      for (const p of patterns) lines.push(`  ${p}`);
      lines.push(
        `snapshot: ${snap ? `${snap.models.length} models (updated ${snap.updatedAt})` : "missing — run a session or /enabled-models refresh"}`,
      );
      lines.push(
        `session scoped models: ${scope.map((sm: any) => `${sm.model.provider}/${sm.model.id}`).join(", ") || "(none)"}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

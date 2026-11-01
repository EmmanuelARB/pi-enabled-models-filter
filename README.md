# enabled-models-filter

**Enforce the `enabledModels` allowlist in your pi `settings.json` as a hard model filter — everywhere.**

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for people whose model picker has gotten out of hand. Pi's built-in `enabledModels` setting only scopes the interactive picker and `Ctrl+P` cycling; `pi --list-models` ignores it, explicit `--model` references ignore it, and subagents spawned with a disallowed model happily run with it. This extension makes the same list absolute for every entry point.

## What it does

| Path | Behavior with the extension |
|---|---|
| `pi --list-models` | Shows only enabled models |
| `/model` picker, `Ctrl+P` | Only enabled models |
| `pi --model <disabled-model>` | **Fails explicitly** — error + exit 1, no request is sent |
| Session restore with a disabled model | Same explicit failure |
| Spawned `pi` subprocesses (subagents) | Load the extension too — disabled models can't be resolved, nonsense ids fail closed |
| Empty / missing `enabledModels` | Extension is inert (pi's default behavior) |

No hardcoded model lists, no second config file to maintain: the extension reads
`enabledModels` from `~/.pi/agent/settings.json` on every launch — that setting stays the
single source of truth.

```jsonc
// ~/.pi/agent/settings.json
{
  "enabledModels": [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5-5",
    "mistral-subscription/mistral-large-4",
    "aiRouter/*"
  ]
}
```

Patterns follow pi's conventions: exact `provider/id`, bare model id, or `*`/`?` globs.

## Install

```bash
pi install https://github.com/EmmanuelARB/enabled-models-filter
```

Or from a local clone:

```bash
pi install ./enabled-models-filter
```

> The extension must load **after** any other extension that registers providers
> (registration merges last-wins). `pi install` appends to the `packages` array in
> `settings.json`, which gives the right order; keep it last.

## How it works

Pi extensions can't reach the model runtime at the moment `pi --list-models` prints —
but extension factories run before that exit, and `pi.registerProvider()` registrations
are applied to the runtime before the list is built. A registration that defines
`models` **replaces** a provider's model list (pi's official override API).

1. **Snapshot.** On `session_start`, the fully composed catalog
   (`ctx.modelRegistry.getAll()`) is cached to `~/.pi/agent/enabled-models-catalog.json`.
   Unseen providers and models are appended automatically on every session start.
2. **Filter.** On every extension load (i.e. in every `pi` process), the current
   `enabledModels` patterns are resolved against the snapshot, and each provider with
   hidden models is re-registered with only its allowed models — plus a
   `refreshModels` override, so providers with dynamic catalogs (OAuth subscriptions
   etc.) can't reintroduce hidden models on refresh.
3. **Fail closed.** Pi's resolver turns `--model provider/unknown-id` into a synthetic
   "custom model" and would still send the request (a bring-your-own-endpoint feature).
   The extension can't veto that resolution, so it aborts at `session_start` instead:
   clear error and exit code 1 in print/RPC mode, graceful shutdown in the TUI. No
   session ever runs with a disallowed model.

## Commands

- `/enabled-models` — status: active patterns, snapshot info, session scope
- `/enabled-models refresh` — rebuild the snapshot from the live registry and re-apply
  filtering. Use it after `pi update --models`, after updating a provider extension,
  or when the extension warns that a pattern matches nothing in the snapshot.

## Limitations

- **First run** is unfiltered in `pi --list-models` until the first session creates the
  snapshot (a notice is printed). Everything after is filtered.
- **Catalog updates** aren't detected automatically — run `/enabled-models refresh`.
- `pi -ne` skips all extensions; requests made outside pi (curl, other tools) are
  unreachable. This is a policy boundary, not a security boundary.
- Only the **global** `settings.json` is read; project-level `enabledModels` is not
  supported.
- Non-chat models (image/classifier) are not filtered.

## License

MIT

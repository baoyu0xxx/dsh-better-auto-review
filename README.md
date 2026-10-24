# dsh-better-auto-review

A two-layer tool-call authorization gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **deterministic rules decide everything they can prove**, and only what they cannot settle is handed to a reviewer model.

The reviewer defaults to the conversation's own main model, so there is nothing to configure before it works. It also works on an `opencode-go` route, which the shipped Auto review does not — see [the OpenCode Go fix](#the-opencode-go-fix).

```text
                  every tool call
                         │
        ┌────────────────▼─────────────────┐
        │ Layer 1 — deterministic rules    │  microseconds, no model, every call
        │  · 17 hard-deny rules            │
        │  · protected / sensitive paths   │
        │  · workspace containment         │
        │  · literal read-only detection   │
        └───────┬──────────────┬───────────┘
           deny │        allow │ escalate
                ▼              ▼        │
          refused      runs, no model   │
                                        ▼
                        ┌───────────────────────────────┐
                        │ Layer 2 — the reviewer model  │  one request, only when needed
                        │  low/medium/high × allow/deny │
                        └───────────┬───────────────────┘
                             allow  │  deny
                                    ▼
                        allowed, or the human is asked
```

## Why not just use the shipped Auto review

`@deepseek-ai/dsh-experimental-auto-review` is good, and this plugin borrows its decision protocol wholesale. Three things are worth improving:

| | shipped Auto review | this plugin |
|---|---|---|
| Every call | one model request, including `ls` and `read` | a rule decides; a plain `git status` costs nothing |
| Reviewer model | fixed to the conversation route | defaults to the main model, **overridable per plugin** |
| Reviewer failure | refuses the call outright, so a flaky provider blocks all work | asks the human by default (`review.onError`) |
| Audit | *"risk, prompt, reasoning and raw response are not persisted, so do not expect it to serve as an audit log"* (its own README) | one JSON line per decision, with rotation and credential redaction |
| `opencode-go` | review request goes out with **no** `x-opencode-session` header | the session id is always sent |
| Permission slot | takes the single global `auto` slot, so only one such plugin can exist | ships its own named preset, so both can coexist |

## Install

From GitHub (tagged release):

```bash
dsh plugin --profile <profile> add https://github.com/baoyu0xxx/dsh-better-auto-review
```

From a local checkout (development):

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-better-auto-review
```

Or install a bundle through the plugin manager (`install_bundle`) with the absolute package directory.

A profile owned by the desktop application is refused by the CLI — `dsh` answers *"profile `desktop` is managed exclusively by the Electron application"*. Install into that profile through the app's own plugin manager instead; the command above is for CLI-booted profiles such as `web` or `tui`.

Installing **changes nothing by itself**: the gate is armed only when a session selects the `better-auto-review` permission preset.

## Enabling it

1. Open a session and pick **Better Auto Review** in the permission picker.
2. That is all. From then on every call in that session is judged by layer 1, and the leftovers reach the reviewer.

To arm it for every session instead, open **Settings → Plugins → Better Auto Review** and set **Gate → Mode** to `always`. Do this deliberately: `always` means a session that never opted in is reviewed too.

## Configuration

Everything is on the plugin's own page under **Settings → Plugins → Better Auto Review**. The plugin-manager detail page also offers a compact **Reviewer model** section; both pages share one data hook and the same controls, use Host routes for validation and persistence, and follow DSH's own settings design tokens (so they track the app's theme and type scale) while the full settings tab retains rules, audit, and the rest of the configuration.

| Group | What it controls |
|---|---|
| **Gate** | enabled, `preset` vs `always`, and the preset key |
| **Reviewer** | provider/model, reasoning effort, output budget and ceiling, timeout, failure policy, history/action budgets |
| **Layer 1 rules** | the hard-deny floor, the two fast-allow switches, protected paths, sensitive write paths, extra allowed roots, and the fast-allow command patterns |
| **Try a command** | a dry run of layer 1: which rule would fire, with nothing executed |
| **Audit log** | recording switches, and the last 15 decisions |

**Reviewer model.** Choose from the models advertised by configured DSH providers, or keep **Inherit from conversation** (the default) to use the session's own route; advertised reasoning-effort choices follow the selected model. A saved route that the current catalog no longer advertises stays visible instead of being silently dropped.

**Fast-allow command patterns.** This is the one knob worth understanding. Layer 1 refuses to *guess*: anything it cannot prove is ordinary work escalates, which costs one model request. That is the right default for a gate that really does grant access, but a project whose everyday command is a compiler or a test runner will pay for it on every call. Listing regexes such as `^npm run ` or `^pytest\b` makes those free. The list is consulted **last**, after every deny and every sensitive-path escalation has declined, so a bad entry cannot open the floor.

## Layer 1 rules

A verdict is one of three things: `deny` (never run the body), `allow` (provably ordinary — skip the model), `escalate` (a rule cannot settle it — ask layer 2).

**Denied outright** — effects that are unrecoverable, or that destroy the ability to boot or to be recovered: volume format, `diskpart`, `mkfs`, raw device writes, shadow-copy deletion, `wbadmin delete`, `bcdedit /delete`, `reg delete HKLM`, Defender real-time disable, firewall disable, restore-point removal, `takeown /r`, `icacls /deny`, event-log clearing, `rm -rf` on a filesystem root, and **any destructive command whose target is the harness state (`.dsh`)**.

**Escalated** — recursive or forced deletion under a protected root (`~/.dsh`, Desktop, Documents, Downloads, Pictures, OneDrive, `C:\Windows`, `Program Files`, `ProgramData`), any write into a sensitive location (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.dsh`, `AppData`, Program Files), a delete whose scope cannot be read (wildcards, unresolved variables), a harness/package/service/registry change, and every command no rule recognises.

**Allowed without the model** — literal read-only commands (`git status`, `git diff`, `Get-ChildItem`, `node --version`, …) and writes or deletions where **every** recognisable target resolves inside the session workspace.

Two details make this trustworthy:

- **Quoted text is masked, and rules match at command positions.** `Write-Output "a|format C:"` is a print statement, not a format. Separators inside quotes do not start a command, and the inner script of `bash -c "…"`, `pwsh -Command "…"` and `python -c "…"` is unwrapped and re-scanned on its own.
- **An unterminated quote escalates.** Masking would swallow the rest of the line, so nothing downstream may allow.

### Deliberate differences from the guard this grew out of

The rules began as a hardened port of a `PreToolUse` guard that ran on the author's machine and passed all 17 of its cases. Two verdicts changed on purpose:

- The guard allowed anything its rules did not flag, because a `PreToolUse` hook **cannot** pre-approve — its `allow` changed nothing. Here `allow` really does authorize the call under a full-access preset, so "not provably ordinary" escalates instead of passing silently.
- The guard treated any path segment named `sessions`, `storages` or `profiles` as harness state, which refused a project's own `./sessions` directory. Only `.dsh` and the DSH-unique `session_projcache` count now; everything else is covered by the concrete, user-editable `protectPaths`.

## The reviewer

The reviewer is asked for exactly one JSON object in a closed protocol — the same one the shipped Auto review uses, so its prompt-hardening lessons carry over:

```json
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny","reason":"..."}
```

`low` must be allowed; `medium` may be allowed only against a current explicit human instruction naming that action, target and scope; `high` (credentials or private data crossing a trust boundary) is always denied **even when a human asks**. Key order is irrelevant, a repeated member is treated as an attack, and a duplicated `risk` cannot smuggle an allow past the parser.

A response that is truncated (`max-tokens`), errored, aborted, or not exactly one text block after zero or more reasoning blocks is an **error, never a decision** — a truncated reviewer is precisely the one most likely to have been about to say `deny`. On a truncation the output budget doubles and the review is retried, up to `review.tokenLimitRetries` times and `maxTokensLimit` tokens.

Then the failure policy applies:

- `review.onError: "ask"` (**default**) — the human is asked. The reviewer never silently allows, and never silently blocks all work either.
- `review.onError: "deny"` — the call is refused, matching the shipped Auto review.

Under a session whose approval policy is `never`, `ask` is structurally impossible, so a refusal is finalized as a `deny` instead of a prompt that could never appear.

### The OpenCode Go fix

`opencode-go` requires a per-conversation routing header. Two upstream facts make that fragile:

- pi-ai injects `x-opencode-session` only when the caller passed a session id — `if (!options?.sessionId || …) return streams` in `opencode-headers.js`.
- `@deepseek-ai/dsh-llm-pi-ai` forwards `GenerateOptions.sessionId` only when it is present.

The shipped Auto review builds its request without it, so on an `opencode-go` route the reviewer goes out unheadered. This plugin sets `sessionId` on every review, following the host's own agent loop (`dsh-agent-loop`: `sessionId: this.session.id`). It costs one field and removes the whole class of failure.

Adapters that use `sessionId` for their own routing can simply disable the plugin or leave the preset unselected.

## Audit log

One JSON line per decision at `$DSH_HOME/plugin-state/better-auto-review/audit.jsonl`, rotated once at `audit.maxBytes` (4 MiB). Argument bodies are not recorded unless `audit.recordArguments` is on, and credential-shaped keys and values are redacted even then. A failure to write **never** fails a tool call.

```bash
dsh --profile <profile>               # no; read it directly:
Get-Content "$env:USERPROFILE\.dsh\plugin-state\better-auto-review\audit.jsonl" -Tail 20
```

## `/bar` command

| Command | Effect |
|---|---|
| `/bar` or `/bar status` | current state, reviewer route, audit path |
| `/bar on` / `/bar off` | enable or disable the gate |
| `/bar preset` / `/bar always` | how the gate is armed |
| `/bar check <command>` | layer 1 only — which rule would fire, nothing executed |
| `/bar audit [n]` | the last `n` decisions |

## Testing

The rules, the reviewer's parsing, the audit log and the whole decision path are pure modules over `node:*` only. Run `npm install` once for the single dependency (`@deepseek-ai/schemastery`, used by the Host adapter and the schema test); after that the suite is offline and needs no DSH:

```bash
npm test        # 87 unit tests
npm run verify  # syntax + tests
```

The gate, reviewer, audit, catalog and config modules are covered end to end by that suite, including the lazy-context and hard-floor paths. The HTTP route layer in `lib/index.js` is a thin adapter over them and was exercised against a stubbed host during development; it has no separate permanent harness.

## Limitations

- **The preset picker's own entry.** The shipped presets carry no display copy, so a named preset shows whatever `name` it sets. This one sets `name` and `description` in `cordis.patch.yml`.
- **One reviewer per session.** The gate arms on a single preset. It coexists with the shipped Auto review, but a session uses one at a time.
- **Not a sandbox.** This decides *whether* a call runs; the sandbox and the approval policy still decide *what it can reach*. The preset pairs `danger-full-access` with `approval: ask` precisely so a review verdict still means something.
- **Layer 1 is a denylist plus a containment proof.** A command that writes through an unrecognised tool is escalated, not allowed — which is why `escalate` is the common case, and why the fast-allow list exists.
- The management page is English-labelled; the plugin's own metadata and the ask prompt are bilingual (`locale/en.json`, `locale/zh.json`).

## License

MIT — see [LICENSE](./LICENSE).

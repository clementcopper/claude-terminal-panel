# Inter-Agent Communication Channel

## Overview

The extension already hosts both PTYs (Claude Code + OpenCode), knows their IDs, and can write into
any PTY via `ptyManager.write()`. There is an established pattern: a shared directory
(`getStatusLineDir()`), atomic JSON writes, `fs.watch`. We reuse that infrastructure, but the
inter-agent channel must only _borrow_ from the statusline pattern — it is **N-to-1** by nature,
which changes the file layout (see step 1).

## Core Idea

The extension becomes a **message broker**. Agents drop JSON messages in a shared directory (or send
via a new `interagent` message type to the host), the host routes each message to the target PTY
and delivers it as a bracketed paste (mid-turn safe).

## Message Protocol

```json
{
  "from": "tab-id",           // sender; host overwrites from the pair filename (see step 1)
  "to":   "tab-id" | "all",
  "kind": "text" | "control", // text = delivered as bracketed paste; control = a signal/kick
  "payload": "string" | object,
  "seq":  123,                // per-sender monotonic
  "ts":   1724856000000
}
```

`kind` is separate from the payload type: a **text** message carries content the recipient acts on,
delivered as one bracketed-paste input; a **control** message (e.g. the `\x1b[?997;1n` theme kick)
is written raw and must never be pasted into a prompt. Do not collapse these two delivery paths.

## Implementation Steps

### 1. New Shared Directory

`getInterAgentDir()` → `<tmp>/claude-terminal-panel/interagent/`

- `inbox/` — **one file per sender→recipient pair**, `<from>.to.<to>.jsonl` (append-only)
- `outbox/` — optional per-pair reply acks (`<to>.to.<from>.jsonl`)
- `presence.json` — registry, rewritten atomically (like `limits.json`), not appended
- Permissions: 0700 dirs, 0600 files (like statusline)

**Why per-pair files:** the statusline is one-writer-per-file, but here several agents may target the
same recipient. Raw `appendFileSync` from two senders into one `<to>.jsonl` can interleave and mangle
a JSON line — there is no `O_APPEND` guarantee across processes on all platforms. A file per
sender→recipient pair means each file has exactly one writer, so no lock is needed and the 300 ms
polling / `fs.watch` design stays as simple as the statusline.

This also fixes `from`: with `<from>.to.<to>.jsonl` the **filename is the truth of the sender**, so
the host can drop any self-declared `from` in the payload and substitute the one from the filename
— spoofing-proof, no trust in the body.

### 2. Extension: `InterAgentRouter` class

New file: `src/InterAgentRouter.ts` (~180 LOC)

- `fs.watch` on `inbox/`, plus the statusline's 300 ms polling fallback
- On a new line in `<from>.to.<to>.jsonl`: parse, validate, then deliver
  - `kind == 'text'` → `ptyManager.write(to, bracketedPaste(payload))` — reuse the existing
    `bracketedPaste()` at `src/ClaudeTerminalViewProvider.ts:30` (`\x1b[200~…\x1b[201~`) so a
    multi-line message lands as one input, not as a series of submitted prompts
  - `kind == 'control'` → `ptyManager.write(to, payload)` raw (a control string, never pasted)
- Overwrite `from` with the sender from the filename; reject a message whose `from` does not match
  the filename
- Optional: write a reply-ack to `outbox/<to>.to.<from>.jsonl`
- Register a dispose hook and prune `presence.json` on tab close

### 3. Per-Engine Adapters (not a shared `npm` library)

Both CLIs are opaque; neither loads a bundled JS module. The "agent side" is therefore a **thin
adapter per engine**, built on top of the repo's existing hook/producer patterns:

- **OpenCode** — a skill (like this repo's skills) with `send(to, payload)` and
  `onMessage(handler)`, wired to `INTERAGENT_DIR` + `MY_TAB_ID`
- **Claude Code** — a settings-injected producer/trigger (the same mechanism as
  `resources/panel-statusline.js`), not an npm dependency
- Each adapter appends JSONL to `inbox/<my-id>.to.<to>.jsonl` and registers with `fs.watch` (300 ms
  polling fallback) so multi-line payloads stay single JSONL lines — escape `\n` in `payload` rather
  than emitting a raw newline

No shared npm package; the protocol contract lives in this document and the two adapters implement
it independently.

### 4. Bootstrap via PTY Env — unconditional

The statusline env vars (`CLAUDE_PANEL_TAB_ID`, `CLAUDE_PANEL_STATUS_DIR`) are only set when
`statusLine !== undefined` (`src/ptyManager.ts:268`), so **OpenCode does not get them today**. The
inter-agent bootstrap must therefore be a separate, **unconditional** set added for every PTY at
spawn:

- `INTERAGENT_DIR` → the shared interagent directory
- `MY_TAB_ID` → the tab's id

Adding these must not be gated behind the statusline path, or the whole channel silently fails for
engine tabs that have no status line.

### 5. Discovery & Presence Lifecycle

- `ls inbox/*.to.*.jsonl` → all reachable sender→recipient edges
- `cat inbox/<id>.to.<other>.jsonl` → history with that peer
- `presence.json` rewritten (atomic, not appended) on register and on tab close; the
  `closeTerminal` path (`src/ClaudeTerminalViewProvider.ts:565`) must also prune the entry, or
  closed tabs look reachable forever — optionally add a `ts` TTL as a second line of defence

## Why Not WebSocket / IPC?

- No ports, no firewall, no extra permissions
- Works across process boundaries, windows, restarts
- Statusline pattern is already production-hardened (atomic write + rename + `fs.watch`)
- Zero new dependencies

## Tradeoffs

| Aspect           | Decision                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Concurrency**  | One writer per file via `<from>.to.<to>.jsonl` pairs — no interleaving, no lock                            |
| **Pull vs Push** | `fs.watch` is push, but can be flaky on some FS → 300 ms polling fallback (already used for `limits.json`) |
| **Delivery**     | Text as bracketed paste (mid-turn safe); control written raw; do not mix the two                           |
| **Message Size** | JSONL line — large payloads escape `\n` in `payload` or chunk; statusline shows small JSONs suffice        |
| **Security**     | User-private tmp, 0700, no cross-user leak; `from` derived from the filename, not the body                 |
| **Ordering**     | Per-pair JSONL is append-only; per-sender `seq` handles reordering                                         |

## Next Steps (if approved)

1. Create `InterAgentRouter.ts` in `src/`
2. Add unconditional `INTERAGENT_DIR` + `MY_TAB_ID` to `ptyManager.ts` (outside the statusline gate)
3. Wire the router callback + `presence.json` pruning into `ClaudeTerminalViewProvider` (like
   `handleThemeApplied` and `closeTerminal`)
4. Build the two thin adapters: an OpenCode skill and a Claude Code producer/trigger

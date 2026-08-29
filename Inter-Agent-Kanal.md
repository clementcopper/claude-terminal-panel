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

### Protocol Extensions (Future-Proofing)

- **Schema version**: add `"v": 1` to the protocol object. Routers/adapters must reject unknown major
  versions and tolerate unknown fields (forward-compatible).
- **Message ID for idempotency**: optional `"msgId": "uuid"` — recipients track seen IDs (bounded
  LRU, e.g. 1000 entries) to deduplicate retries after crashes.
- **Broadcast `to: "all"`**: router expands to all live tabs from `presence.json` and writes one
  `<from>.to.<each>.jsonl` per recipient. O(n) files, acceptable for n ≤ 10 tabs.
- **Chunking for large payloads**: if `payload` (stringified) > 64 KB, split into chunks with
  `"chunk": { "id": "msgId", "index": 0, "total": 3, "data": "..." }` and reassemble on receipt.
  Keeps JSONL lines bounded for `fs.watch` reliability.

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

### 6. Router Lifecycle & Cleanup

- `InterAgentRouter` implements `dispose()`: closes both watchers, clears polling interval,
  removes `inbox/*.jsonl` and `outbox/*.jsonl` for tabs that no longer exist (scans
  `presence.json` on shutdown).
- File rotation: each `.jsonl` capped at 1 MB / 10 000 lines; on overflow, rename to
  `<name>.1.jsonl`, keep max 3 generations. Adapters handle missing history gracefully.

### 7. Cross-Window & Multi-Instance

The tmp dir is per-user (`os.tmpdir()`), so **multiple VS Code windows share one channel**.
This is intentional: a tab in Window A can message a tab in Window B. If isolation is needed,
append the window's `vscode.env.sessionId` (or a random instance-id at startup) to the
directory name: `<tmp>/claude-terminal-panel/interagent-<instanceId>/`.

### 8. Security Hardening

- On each `fs.watch` event, `lstat` the file first — ignore symlinks, non-regular files, files
  not owned by the current uid.
- The router never writes outside `inbox/`/`outbox/`/`presence.json`; path traversal in
  `<from>.to.<to>` is impossible because filenames are derived from validated tab IDs
  (alphanumeric + `-` only, enforced at spawn).

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

## Testing Strategy

- **Unit** (`InterAgentRouter.test.ts`): in-memory mock `fs` (memfs), inject lines, assert
  `ptyManager.write` called with correct bracketed paste / raw control, `from` overwritten,
  invalid lines rejected, `presence.json` pruned on tab close.
- **Integration**: spin two PTYs in the same test process (using `node-pty` directly), feed
  messages through the real `inbox/` dir, verify delivery order and deduplication (`msgId`).
- **Chaos**: kill the router mid-delivery, restart, verify no duplicate delivery and no
  message loss (idempotency + `presence.json` recovery).
- **Cross-window**: simulate two router instances on the same `interagent-<id>` dir, verify
  no file collision and correct routing.

## Open Questions

- **Backpressure**: `ptyManager.write` is fire-and-forget; if the PTY's OS buffer fills, writes
  block or drop silently. No flow control in this design — acceptable for low-volume control
  messages, but a high-volume text stream could stall. A future `pause/resume` signal from the
  adapter (when its input buffer is full) would close the loop.
- **Encryption**: not needed (user-private tmp, 0700), but if the channel ever crosses machine
  boundaries (e.g. remote dev), add Noise protocol or libsodium box.

---

## Decision Log & Alternatives (Recorded 2026-08-28)

### Confirmed Decisions

| ID  | Decision                  | Choice                                         | Rationale                                                                          |
| --- | ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| E1  | IPC Transport Ext↔Sidecar | **stdio JSONL**                                | No port, native `spawn`, line-delimited JSON, trivial debugging                    |
| E2  | Sidecar Scope             | **Per Tab** (isolated)                         | Clean state, crash isolation, no cross-tab leaks                                   |
| E3  | PTY Owner                 | **Sidecar owns PTY**                           | Extension becomes thin IPC layer; cleaner separation                               |
| E4  | Feature Flag              | **`claudeTerminal.useSidecar` (default true)** | Instant rollback without rebuild, A/B testing                                      |
| E5  | File Rotation             | **1 MB / 10k lines / 3 generations**           | Matches statusline pattern; tmpfs-friendly                                         |
| E6  | Cross-Window Isolation    | **Default shared** (`interagent/`)             | Tabs across windows can talk; opt-out via `interagent-<sessionId>/`                |
| E7  | Backpressure Signal       | **None for MVP** (fire-and-forget)             | Control messages low-volume; text streams rare; add `pause/resume` later if needed |
| E8  | Chunking Threshold        | **64 KB**                                      | `fs.watch` reliable on small lines; 64 KB safe default                             |

### Rejected Alternatives (Documented for Context)

| Alternative                          | Why Not Chosen                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Per-Engine Adapters (no Sidecar)** | Claude Code has no listener hook → cannot receive programmatically; asymmetry (OpenCode↔OpenCode works, Claude→ only visible) |
| **WebSocket / HTTP**                 | Port management, firewall, permissions, cross-window complexity; over-engineering for ≤10 tabs                                |
| **Router in Sidecar**                | N-to-1 race: multiple Sidecars watching same files; `presence.json` sync needed; Sidecar bloats                               |
| **Raw Write + `\n` Delivery**        | Breaks prompt if recipient is typing (each line = submit)                                                                     |
| **OSC 52 Clipboard**                 | Not universally supported; clipboard pollution                                                                                |
| **`ls inbox/` for Discovery**        | No metadata (engine, cwd, capabilities); `presence.json` atomic rewrite chosen (like `limits.json`)                           |

### Chosen Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    EXTENSION HOST                           │
│  ┌──────────────┐  ┌────────────────────────────────────┐  │
│  │ InterAgent   │  │ Sidecar Manager                    │  │
│  │ Router       │  │  - spawnSidecar() per Tab          │  │
│  │ - fs.watch   │  │  - IPC stdin/stdout JSONL          │  │
│  │ - delivery   │  │  - handles resize/kill/output      │  │
│  │ - presence   │  └────────────────────────────────────┘  │
│  └──────┬───────┘           ▲                ▲            │
└─────────│───────────────────│────────────────│────────────┘
          │ IPC JSONL         │ IPC JSONL      │
    ┌─────┴─────┐       ┌─────┴─────┐    ┌─────┴─────┐
    │ Sidecar A │       │ Sidecar B │    │ Sidecar N │
    │ (Claude)  │       │ (OpenCode)│    │  (any)    │
    │ - PTY     │       │ - PTY     │    │ - PTY     │
    │ - inbox   │       │ - inbox   │    │ - inbox   │
    │   watch   │       │   watch   │    │   watch   │
    └───────────┘       └───────────┘    └───────────┘
          │                   │                │
          └───────────────────┴────────────────┘
                          │
                 ┌────────┴────────┐
                 │ Shared tmp dir  │
                 │ interagent/     │
                 │  inbox/         │
                 │  outbox/        │
                 │  presence.json  │
                 └─────────────────┘
```

### Implementation Phases

| Phase | Scope                         | Key Files                                                                                           |
| ----- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| 1     | **Sidecar Core**              | `src/sidecar/ipc.ts`, `src/sidecar/SidecarProcess.ts`, `src/sidecar/index.ts`, `esbuild.sidecar.js` |
| 2     | **Extension Integration**     | `src/ptyManager.ts`, `src/ClaudeTerminalViewProvider.ts`                                            |
| 3     | **InterAgentRouter (Broker)** | `src/interagent/InterAgentRouter.ts`                                                                |
| 4     | **Bootstrap / Adapters**      | Env vars in `ptyManager.ts`, OpenCode skill, Claude producer (sidecar covers receive)               |
| 5     | **Tests & Hardening**         | Unit (memfs), Integration (2 PTYs), Chaos (kill/restart), Security (lstat/UID)                      |

---

_Decisions recorded by OpenCode session `big-pickle`. All confirmed by user._

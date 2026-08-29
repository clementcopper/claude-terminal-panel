import * as vscode from 'vscode';

/**
 * The panel's diagnostic log — View → Output → "Claude Terminal".
 *
 * Exists because the interesting failures here are invisible from the terminal itself: a PTY that
 * dies a second after it started leaves nothing behind but `[Process exited with code 1]` in a
 * tab, and the size a process was spawned with is gone by the time anyone looks. Every spawn,
 * exit, error and size negotiation is written here so the next odd report can be answered from a
 * record instead of a reconstruction.
 *
 * A module-level channel rather than an injected one: the alternative threads a logger through
 * five constructors for a facility that is a singleton either way.
 */
let channel: vscode.OutputChannel | undefined;

export function initLog(target: vscode.OutputChannel): void {
  channel = target;
}

/** `12:04:07.812 [pty] spawn …` — the scope names the subsystem, never the tab alone. */
export function log(scope: string, message: string): void {
  if (!channel) return;
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const millis = String(now.getMilliseconds()).padStart(3, '0');
  channel.appendLine(`${time}.${millis} [${scope}] ${message}`);
}

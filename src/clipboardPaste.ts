import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';

/**
 * What a paste into the terminal should turn into.
 *
 * `path` and `text` both end up as text in the prompt; they are told apart only so a caller can
 * log which route was taken. `image` means the pasteboard carries pixels and no text — Claude
 * Code reads those itself when it receives Ctrl+V.
 */
export type PasteboardContent =
  | { kind: 'path'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image' }
  | { kind: 'none' };

/**
 * One line, no separators, ends in a short extension: the shape a file name has. Finder puts
 * exactly this on the pasteboard as the text form of a copied file, so this is when the file URL
 * is worth the extra round trip.
 */
const LOOKS_LIKE_FILE_NAME = /^[^\n\r/\\]{1,255}\.[a-z0-9]{1,8}$/i;

function osascript(script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr });
    });
  });
}

/**
 * Reads the pasteboard the way a terminal should, not the way a browser does.
 *
 * A file copied in Finder is three things on the pasteboard: a file URL, its icon as an image,
 * and its bare name as text. A browser paste delivers the name; Claude Code's Ctrl+V takes the
 * image — and that is the 1024×1024 PNG document icon, not the screenshot (measured 2026-09-15
 * with Claude Code 2.1.272: `the clipboard as «class PNGf»` on a copied `.png` is the icon). The
 * one representation that leads to the real file is the URL, and Claude Code reads a pasted
 * image path itself, so that is what a copied file becomes here.
 *
 * Order is chosen for latency: `readText` is in-process, every `osascript` call is 0.4–0.8 s on
 * this machine (baseline `osascript -e 1` is 0.06 s; the pasteboard access itself is the cost).
 * So the file URL is asked for only when the text has the shape of a file name, and the image
 * check only when there is no text at all. A plain text paste never waits.
 *
 * Several files copied at once: `«class furl»` yields the first one only. Not extended on
 * purpose — a second osascript round trip per file is not worth it until somebody needs it.
 */
export async function readPasteboard(): Promise<PasteboardContent> {
  const text = await vscode.env.clipboard.readText();
  if (text.length > 0) {
    if (process.platform === 'darwin' && LOOKS_LIKE_FILE_NAME.test(text.trim())) {
      const result = await osascript('get POSIX path of (the clipboard as «class furl»)');
      const filePath = result.stdout.trim();
      if (result.ok && filePath && fs.existsSync(filePath)) {
        return { kind: 'path', text: filePath };
      }
      // Error -1700 ("can't make … into type file") is the normal answer for text that merely
      // looks like a file name; anything else is worth a line.
      if (!result.ok && !result.stderr.includes('-1700')) {
        console.warn(`[clipboardPaste] file URL lookup failed: ${result.stderr.trim()}`);
      }
    }
    return { kind: 'text', text };
  }

  if (process.platform === 'darwin') {
    const result = await osascript('the clipboard as «class PNGf»');
    if (result.ok) {
      return { kind: 'image' };
    }
  }
  return { kind: 'none' };
}

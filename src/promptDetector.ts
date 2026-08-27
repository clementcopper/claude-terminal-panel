// Default patterns for detecting CLI AI prompts waiting for input
const DEFAULT_PROMPT_PATTERNS: RegExp[] = [
  // REPL prompts (at end of output)
  /(?:^|\n|\r)>\s*$/,
  /(?:^|\n|\r)>>>\s*$/,
  /(?:^|\n|\r)\w+>\s*$/i, // claude>, gemini>, aider>, etc.

  // Y/N confirmations
  /\([Yy]\/[Nn]\)\s*:?\s*$/,
  /\[[Yy]\/[Nn]\]\s*:?\s*$/,
  /\(yes\/no\)\s*:?\s*$/i,

  // Question prompts (at end)
  /[Cc]onfirm\??\s*$/,
  /[Aa]pply\??\s*$/,
  /[Cc]ontinue\??\s*$/,
  /[Pp]roceed\??\s*$/,
  /[Aa]ccept\??\s*$/,

  // Interactive menus (selector arrows - various unicode characters)
  /[❯›>]\s*\d+\./,
  // Claude Code plan file hint (appears during interactive prompts)
  /~\/\.claude\/plans\/.*\.md/,
  // Generic "Would you like to" questions anywhere in recent output
  /[Ww]ould you like to [^?]*\?/,
  // Common confirmation prompts
  /[Pp]ress enter to confirm/i,
  /esc to cancel/i
];

// Strip ANSI escape codes from terminal output
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/** Only the tail of the PTY stream can hold a prompt, so that is all each terminal keeps. */
const BUFFER_SIZE = 500;

export interface PromptDetectorConfig {
  enabled: boolean;
  showDelay: number;
  customPatterns: string[];
}

export type NotificationCallback = (terminalId: string, isWaiting: boolean) => void;

export class PromptDetector {
  private readonly buffers = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly waitingState = new Map<string, boolean>();
  private readonly patterns: RegExp[];
  private config: PromptDetectorConfig;
  private readonly onNotificationChange: NotificationCallback;

  constructor(config: PromptDetectorConfig, onNotificationChange: NotificationCallback) {
    this.config = config;
    this.onNotificationChange = onNotificationChange;
    this.patterns = this.buildPatterns(config.customPatterns);
  }

  private buildPatterns(customPatterns: string[]): RegExp[] {
    const patterns = [...DEFAULT_PROMPT_PATTERNS];

    for (const pattern of customPatterns) {
      try {
        patterns.push(new RegExp(pattern));
      } catch {
        // Skip invalid patterns
      }
    }

    return patterns;
  }

  updateConfig(config: PromptDetectorConfig): void {
    this.config = config;
    // Rebuild patterns if custom patterns changed
    const newPatterns = this.buildPatterns(config.customPatterns);
    this.patterns.length = 0;
    this.patterns.push(...newPatterns);
  }

  onData(terminalId: string, data: string): void {
    if (!this.config.enabled) {
      return;
    }

    // slice() on a shorter string returns it whole, so no length check is needed
    this.buffers.set(terminalId, ((this.buffers.get(terminalId) ?? '') + data).slice(-BUFFER_SIZE));

    // Clear any pending show timer - more output arrived
    this.clearTimer(terminalId);

    // If notification is showing, check if we should hide it
    if (this.waitingState.get(terminalId)) {
      // New output arrived, hide notification quickly
      this.setWaitingState(terminalId, false);
    }

    // Schedule pattern check after output settles
    const timer = setTimeout(() => {
      this.checkForPrompt(terminalId);
    }, this.config.showDelay);

    this.timers.set(terminalId, timer);
  }

  onUserInput(terminalId: string): void {
    // Clear notification immediately on user input
    this.clearTimer(terminalId);
    this.setWaitingState(terminalId, false);

    // Also clear the buffer since user is interacting. Emptied rather than removed, so a check
    // that still runs reports "not waiting" instead of bailing out before it says anything.
    if (this.buffers.has(terminalId)) {
      this.buffers.set(terminalId, '');
    }
  }

  private checkForPrompt(terminalId: string): void {
    const buffer = this.buffers.get(terminalId);
    if (buffer === undefined) {
      return;
    }

    const content = stripAnsi(buffer);

    // Check last 200 characters for patterns (sufficient for any prompt)
    const tail = content.slice(-200);

    const isWaiting = this.patterns.some((pattern) => pattern.test(tail));
    this.setWaitingState(terminalId, isWaiting);
  }

  private setWaitingState(terminalId: string, isWaiting: boolean): void {
    const currentState = this.waitingState.get(terminalId) ?? false;

    if (currentState !== isWaiting) {
      this.waitingState.set(terminalId, isWaiting);
      this.onNotificationChange(terminalId, isWaiting);
    }
  }

  private clearTimer(terminalId: string): void {
    const timer = this.timers.get(terminalId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(terminalId);
    }
  }

  removeTerminal(terminalId: string): void {
    this.clearTimer(terminalId);
    this.buffers.delete(terminalId);
    this.waitingState.delete(terminalId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.buffers.clear();
    this.waitingState.clear();
  }
}

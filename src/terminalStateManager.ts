import * as nodePath from 'path';
import type { TerminalInstance, TerminalGroup, TabInfo, GroupInfo, Engine } from './types';
import { ENGINE_ACCENT_COLORS } from './types';

/**
 * Manages terminal instance state including active terminal tracking.
 * Eliminates duplicated tab activation logic.
 *
 * Two levels: groups own a working directory and an ordered list of terminal ids; terminals stay
 * in one flat map keyed by a globally unique id, because that id is also the key for the PTY map,
 * the status line file, the PTY env and the webview DOM. Grouping never renames a terminal.
 */
export class TerminalStateManager {
  private readonly terminals = new Map<string, TerminalInstance>();
  private readonly groups = new Map<string, TerminalGroup>();
  private activeTerminalId: string | undefined;
  private activeGroupId: string | undefined;
  private terminalCounter = 0;

  /**
   * Generates a unique terminal ID.
   */
  generateId(): string {
    return `terminal-${String(Date.now())}-${Math.random().toString(36).substring(2, 9)}`;
  }

  // --- Groups ---

  /**
   * The default name for a group: the last segment of its working directory.
   *
   * A group is a project, and the folder is what tells two of them apart — the CLI is already on
   * the accent bar, and a counter would only put a digit in front of the name. Falls back to the
   * engine label for a directory with no last segment, such as a filesystem root.
   */
  private defaultGroupName(cwd: string, engine: Engine): string {
    const base = nodePath.basename(cwd).trim();
    return base.length > 0 ? base : engine === 'claude' ? 'Claude' : 'OpenCode';
  }

  /**
   * Creates a group and returns it. The caller decides when it becomes active.
   */
  createGroup(cwd: string, engine: Engine, workspaceFolderIndex?: number): TerminalGroup {
    const group: TerminalGroup = {
      id: `group-${String(Date.now())}-${Math.random().toString(36).substring(2, 9)}`,
      name: this.defaultGroupName(cwd, engine),
      cwd,
      workspaceFolderIndex,
      engine,
      terminalIds: []
    };
    this.groups.set(group.id, group);
    return group;
  }

  /**
   * Renames a group. An empty name is refused rather than stored — a nameless tab is
   * unclickable-looking and there would be no way back to a default.
   */
  renameGroup(id: string, name: string): boolean {
    const group = this.groups.get(id);
    const trimmed = name.trim();
    if (!group || trimmed.length === 0 || trimmed === group.name) {
      return false;
    }
    group.name = trimmed;
    return true;
  }

  getGroup(id: string): TerminalGroup | undefined {
    return this.groups.get(id);
  }

  getAllGroups(): TerminalGroup[] {
    return Array.from(this.groups.values());
  }

  getAllGroupIds(): string[] {
    return Array.from(this.groups.keys());
  }

  get groupCount(): number {
    return this.groups.size;
  }

  getActiveGroupId(): string | undefined {
    return this.activeGroupId;
  }

  getActiveGroup(): TerminalGroup | undefined {
    return this.activeGroupId ? this.groups.get(this.activeGroupId) : undefined;
  }

  setActiveGroup(id: string): void {
    if (this.groups.has(id)) {
      this.activeGroupId = id;
    }
  }

  /**
   * Drops the group itself. Its terminals must already be gone — closing them is the provider's
   * job, because that also has to kill PTYs and unregister watchers.
   */
  deleteGroup(id: string): boolean {
    const removed = this.groups.delete(id);
    if (removed && this.activeGroupId === id) {
      this.activeGroupId = this.groups.keys().next().value;
    }
    return removed;
  }

  /**
   * Generates the next terminal name.
   */
  generateName(engine: Engine): string {
    this.terminalCounter++;
    const label = engine === 'claude' ? 'Claude' : 'OpenCode';
    return `${label} ${String(this.terminalCounter)}`;
  }

  /**
   * Gets a terminal instance by ID.
   */
  get(id: string): TerminalInstance | undefined {
    return this.terminals.get(id);
  }

  /**
   * Sets a terminal instance and files it under its group, so callers cannot add a terminal and
   * forget the group bookkeeping.
   */
  set(id: string, instance: TerminalInstance): void {
    this.terminals.set(id, instance);
    const group = this.groups.get(instance.groupId);
    if (group && !group.terminalIds.includes(id)) {
      group.terminalIds.push(id);
    }
  }

  /**
   * Deletes a terminal instance and unfiles it from its group.
   */
  delete(id: string): boolean {
    const instance = this.terminals.get(id);
    if (instance) {
      const group = this.groups.get(instance.groupId);
      if (group) {
        group.terminalIds = group.terminalIds.filter((tid) => tid !== id);
        if (group.activeTerminalId === id) {
          group.activeTerminalId = group.terminalIds[group.terminalIds.length - 1];
        }
      }
    }
    return this.terminals.delete(id);
  }

  /**
   * The terminals of one group, in tab order. Defaults to the active group.
   */
  getGroupTerminals(groupId?: string): TerminalInstance[] {
    const id = groupId ?? this.activeGroupId;
    const group = id ? this.groups.get(id) : undefined;
    if (!group) return [];
    return group.terminalIds
      .map((tid) => this.terminals.get(tid))
      .filter((t): t is TerminalInstance => t !== undefined);
  }

  /**
   * Gets all terminal instances.
   */
  getAll(): TerminalInstance[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Gets the active terminal ID.
   */
  getActiveId(): string | undefined {
    return this.activeTerminalId;
  }

  /**
   * Deactivates the current terminal and activates a new one.
   * This eliminates the duplicated tab activation logic.
   * Returns the previously active terminal (if any).
   */
  setActive(id: string): TerminalInstance | undefined {
    let previousActive: TerminalInstance | undefined;

    // Deactivate previous
    if (this.activeTerminalId && this.activeTerminalId !== id) {
      previousActive = this.terminals.get(this.activeTerminalId);
      if (previousActive) {
        previousActive.isActive = false;
      }
    }

    // Activate new
    const instance = this.terminals.get(id);
    if (instance) {
      instance.isActive = true;
      this.activeTerminalId = id;
      // Activating a tab activates its group, and the group remembers the tab. Clicking an
      // inner tab therefore also fixes which terminal that group returns to later.
      const group = this.groups.get(instance.groupId);
      if (group) {
        group.activeTerminalId = id;
        this.activeGroupId = group.id;
      }
    }

    return previousActive;
  }

  /**
   * Clears the active terminal (sets to undefined).
   */
  clearActive(): void {
    this.activeTerminalId = undefined;
  }

  /**
   * Sets the waiting for input state for a terminal.
   */
  setWaitingForInput(id: string, isWaiting: boolean): void {
    const instance = this.terminals.get(id);
    if (instance) {
      instance.isWaitingForInput = isWaiting;
    }
  }

  /**
   * Tab information for one group's terminals — the active group unless told otherwise. The
   * inner tab bar only ever draws one group.
   */
  getTabsInfo(groupId?: string): TabInfo[] {
    return this.getGroupTerminals(groupId).map((t) => ({
      id: t.id,
      name: t.name,
      isActive: t.isActive,
      accentColor: ENGINE_ACCENT_COLORS[t.engine],
      isWaitingForInput: t.isWaitingForInput,
      cwd: t.cwd,
      engine: t.engine
    }));
  }

  /**
   * Group information for the outer tab bar.
   */
  getGroupsInfo(): GroupInfo[] {
    return this.getAllGroups().map((g) => ({
      id: g.id,
      name: g.name,
      isActive: g.id === this.activeGroupId,
      cwd: g.cwd,
      terminalCount: g.terminalIds.length,
      hasWaitingTerminal: g.terminalIds.some(
        (tid) => this.terminals.get(tid)?.isWaitingForInput === true
      ),
      engine: g.engine,
      accentColor: ENGINE_ACCENT_COLORS[g.engine]
    }));
  }
}

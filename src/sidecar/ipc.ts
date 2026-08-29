export type SidecarMessage =
  | { type: 'deliver'; tabId: string; kind: 'text' | 'control'; payload: string }
  | { type: 'resize'; tabId: string; cols: number; rows: number }
  | { type: 'kill'; tabId: string }
  | { type: 'ready'; tabId: string }
  | { type: 'output'; tabId: string; data: string }
  | { type: 'exit'; tabId: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; tabId: string; message: string };

export function serialize(msg: SidecarMessage): string {
  return JSON.stringify(msg);
}

export function deserialize(line: string): SidecarMessage | null {
  try {
    return JSON.parse(line) as SidecarMessage;
  } catch {
    return null;
  }
}

export const SIDECAR_PROTOCOL_VERSION = 1;
/**
 * The Console: a rolling log of the last 2000 events (frame diffs, commands, gate changes, queue,
 * errors), exportable as text for the friend's reports. No network, no telemetry.
 */
export type LogKind =
  'app' | 'frame' | 'command' | 'queue' | 'gate' | 'pad' | 'store' | 'warn' | 'error';

export interface LogEntry {
  /** Wall-clock ms. */
  at: number;
  kind: LogKind;
  msg: string;
}

export class Log {
  private entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(
    private readonly capacity = 2000,
    private readonly clock: () => number = Date.now,
    private readonly echo = false,
  ) {}

  add(kind: LogKind, msg: string): void {
    const e = { at: this.clock(), kind, msg };
    this.entries.push(e);
    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity);
    if (this.echo) console.log(`[${kind}] ${msg}`);
    for (const l of this.listeners) l(e);
  }

  onEntry(l: (e: LogEntry) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  all(): readonly LogEntry[] {
    return this.entries;
  }

  /** One line per entry: ISO time, kind, message. */
  format(header: string[] = []): string {
    const lines = this.entries.map(
      (e) => `${new Date(e.at).toISOString()} ${e.kind.padEnd(7)} ${e.msg}`,
    );
    return [...header, '', ...lines, ''].join('\n');
  }
}

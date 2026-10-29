import type { ButtonInput } from './schema';
import type { CompiledBinding, CompiledProfile, ParsedCombo } from './profile';

export type { ButtonInput } from './schema';

export type StickId = 'lstick' | 'rstick';
export type TriggerId = 'lt' | 'rt';
export type AnalogInput = StickId | TriggerId;
export type Mod = 'Mod' | 'Cmd' | 'Ctrl' | 'Shift' | 'Alt';
export type MouseBtn = 'left' | 'right' | 'middle';
export type WheelName = 'lift' | 'gamma' | 'gain' | 'offset';

/** Standard-mapping pad snapshot. buttons[17] in 0..1, axes[4] = LX, LY, RX, RY in -1..1 (+Y down). */
export interface PadFrame {
  t: number;
  buttons: number[];
  axes: number[];
}

export type EngineInput =
  | { kind: 'frame'; frame: PadFrame }
  | { kind: 'tick' }
  | { kind: 'disconnect' }
  | { kind: 'gate'; open: boolean }
  | { kind: 'releaseAll'; reason: string }
  | { kind: 'setMode'; mode: string };

export type Command =
  | { type: 'command'; id: string; phase: 'tap' | 'down' | 'up'; mods: Mod[]; owner: string }
  | { type: 'keyDown'; code: string; mods: Mod[]; owner: string }
  | { type: 'keyUp'; code: string; owner: string }
  | { type: 'modifierDown'; mod: Mod; owner: string }
  | { type: 'modifierUp'; mod: Mod; owner: string }
  | { type: 'mouseButton'; button: MouseBtn; down: boolean }
  | { type: 'mouseMove'; dx: number; dy: number }
  | { type: 'scroll'; dx: number; dy: number; units: 'lines' | 'pixels' }
  | { type: 'driveStart'; input: AnalogInput; wheel: WheelName; part: 'balance' | 'master' }
  | { type: 'driveDelta'; dx: number; dy: number }
  | { type: 'driveEnd' }
  | { type: 'modeChanged'; mode: string }
  | { type: 'layerChanged'; layers: string[]; fine: boolean }
  | { type: 'haptic'; kind: 'pulse' | 'detent' };

export interface GestureGroup {
  tap: CompiledBinding | null;
  hold: CompiledBinding | null;
  doubleTap: CompiledBinding | null;
}

export type HeldEntry =
  | { kind: 'consumed' }
  | { kind: 'layer'; layers: string[]; fine: boolean }
  | { kind: 'action'; binding: CompiledBinding; owner: string }
  | { kind: 'gesture'; group: GestureGroup; pressedAt: number; holdFired: boolean };

export interface StickState {
  engaged: boolean;
  engagedAt: number;
  /** Set by releaseAll / gate re-arm: ignore the stick until it returns to the deadzone. */
  blocked: boolean;
  needsLock: boolean;
  lock: 'x' | 'y' | null;
  vec: CompiledBinding | null;
  x: CompiledBinding[];
  y: CompiledBinding[];
  /** Axis-as-button bindings currently pressed: binding index → owner. */
  axisPressed: Record<number, string | undefined>;
  mouse: { accX: number; accY: number; lastAt: number | null };
}

export interface TriggerState {
  engaged: boolean;
  engagedAt: number;
  blocked: boolean;
  binding: CompiledBinding | null;
}

export interface JogState {
  active: boolean;
  stick: StickId | null;
  acc: number;
  lastAt: number;
  /** After jog/shuttle arbitration: ignore jog until the stick returns to the deadzone. */
  suppressed: boolean;
}

export interface ShuttleState {
  owner: TriggerId | null;
  binding: CompiledBinding | null;
  zone: number;
  holds: string[];
  candidate: Record<TriggerId, { zone: number; since: number } | null>;
  suppressed: Record<TriggerId, boolean>;
}

export interface DriveState {
  active: {
    input: AnalogInput;
    binding: CompiledBinding;
    wheel: WheelName;
    accX: number;
    accY: number;
    lastAt: number;
  } | null;
  cooldownUntil: number;
  activeWheel: WheelName;
}

export interface ChordEvent {
  kind: 'press' | 'release';
  input: ButtonInput;
}

export interface ChordState {
  pending: { events: ChordEvent[]; deadline: number; fired: number | null } | null;
  active: { index: number; owner: string; members: ButtonInput[] } | null;
}

export interface Holder<K> {
  key: K;
  owners: string[];
}

export interface EngineState {
  profile: CompiledProfile;
  mode: string;
  connected: boolean;
  gateOpen: boolean;
  seq: number;
  axes: number[];
  triggerValues: Record<TriggerId, number>;
  pressed: Record<ButtonInput, boolean>;
  /** Resolution stored at press; `undefined` = not held. */
  held: Partial<Record<ButtonInput, HeldEntry | undefined>>;
  layerStack: string[];
  latched: string[];
  fine: boolean;
  chord: ChordState;
  pendingTaps: { input: ButtonInput; binding: CompiledBinding; deadline: number }[];
  repeats: { owner: string; binding: CompiledBinding; nextAt: number; intervalMs: number }[];
  seqs: {
    owner: string;
    input: ButtonInput | null;
    steps: (ParsedCombo | { delayMs: number })[];
    index: number;
    nextAt: number;
  }[];
  keys: Holder<string>[];
  cmdHolds: Holder<string>[];
  mouse: Holder<MouseBtn>[];
  mods: Holder<Mod>[];
  sticks: Record<StickId, StickState>;
  triggers: Record<TriggerId, TriggerState>;
  jog: JogState;
  shuttle: ShuttleState;
  drive: DriveState;
}

export interface StepResult {
  state: EngineState;
  commands: Command[];
  /** True while the host should deliver 8 ms ticks (analog live, jog/drive/shuttle active). */
  tick: boolean;
  /** Earliest timestamp at which a timer (chord window, hold, repeat, macro) needs a step. */
  wakeAt: number | null;
}

export interface Ctx {
  state: EngineState;
  profile: CompiledProfile;
  now: number;
  out: Command[];
  switchMode: (mode: string) => void;
}

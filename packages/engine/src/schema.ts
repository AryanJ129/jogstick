/**
 * Profile and keymap schemas.
 *
 * The engine's step machinery has zero runtime dependencies. zod is confined to
 * this file: it runs only when a profile or keymap is loaded and validated.
 */
import { z } from 'zod';

export const BUTTON_INPUTS = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'lt',
  'rt',
  'view',
  'menu',
  'l3',
  'r3',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'guide',
] as const;
export const STICK_INPUTS = [
  'lstick',
  'lstick.x',
  'lstick.y',
  'rstick',
  'rstick.x',
  'rstick.y',
] as const;
export const INPUT_IDS = [...BUTTON_INPUTS, ...STICK_INPUTS] as const;

export const ButtonInputSchema = z.enum(BUTTON_INPUTS);
export const InputIdSchema = z.enum(INPUT_IDS);

export const CurveSchema = z.union([
  z.enum(['linear', 'quad', 'cubic', 'sCurve']),
  z.array(z.number().min(0).max(1)).min(2),
]);

const RepeatSchema = z
  .object({ delayMs: z.number().positive(), intervalMs: z.number().positive() })
  .strict();
const DirSchema = z.union([z.literal(1), z.literal(-1)]);
const ModeIdSchema = z.string().min(1);

export const COMMAND_ID_PATTERN = /^[a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+$/;

const CommandActionSchema = z
  .object({
    type: z.literal('command'),
    id: z.string().regex(COMMAND_ID_PATTERN),
    hold: z.boolean().optional(),
    repeat: RepeatSchema.optional(),
  })
  .strict();
const KeyActionSchema = z
  .object({
    type: z.literal('key'),
    combo: z.string().min(1),
    hold: z.boolean().optional(),
    repeat: RepeatSchema.optional(),
  })
  .strict();
const KeySeqActionSchema = z
  .object({
    type: z.literal('keySeq'),
    steps: z
      .array(
        z.union([
          z.object({ combo: z.string().min(1) }).strict(),
          z.object({ delayMs: z.number().nonnegative() }).strict(),
        ]),
      )
      .min(1),
  })
  .strict();
const MouseButtonActionSchema = z
  .object({ type: z.literal('mouseButton'), button: z.enum(['left', 'right', 'middle']) })
  .strict();
const MouseMoveActionSchema = z
  .object({
    type: z.literal('mouseMove'),
    speed: z.number().positive().default(1200),
    curve: CurveSchema.default('quad'),
  })
  .strict();
const ScrollActionSchema = z
  .object({
    type: z.literal('scroll'),
    dx: z.number().default(0),
    dy: z.number().default(0),
    units: z.enum(['lines', 'pixels']).default('lines'),
  })
  .strict();
const JogActionSchema = z
  .object({
    type: z.literal('jog'),
    rate: z
      .object({
        min: z.number().positive(),
        max: z.number().positive(),
        curve: CurveSchema.default('linear'),
      })
      .strict(),
    fastAtEdge: z.boolean().default(false),
  })
  .strict();
const ShuttleActionSchema = z
  .object({
    type: z.literal('shuttle'),
    dir: z.enum(['forward', 'reverse']),
    zones: z.array(z.number().gt(0).lte(1)).min(1),
    slowZone: z.boolean().default(false),
  })
  .strict();
const WheelActionSchema = z
  .object({
    type: z.literal('wheel'),
    wheel: z.enum(['lift', 'gamma', 'gain', 'offset', 'active']),
    part: z.enum(['balance', 'master']),
    dir: DirSchema.optional(),
    gain: z.number().positive().default(1),
    curve: CurveSchema.default('quad'),
  })
  .strict();
const ModeSetActionSchema = z.object({ type: z.literal('modeSet'), mode: ModeIdSchema }).strict();
const LayerToggleActionSchema = z
  .object({ type: z.literal('layerToggle'), layer: z.string().min(1) })
  .strict();
const NoneActionSchema = z.object({ type: z.literal('none') }).strict();

export const ActionSchema = z.discriminatedUnion('type', [
  CommandActionSchema,
  KeyActionSchema,
  KeySeqActionSchema,
  MouseButtonActionSchema,
  MouseMoveActionSchema,
  ScrollActionSchema,
  JogActionSchema,
  ShuttleActionSchema,
  WheelActionSchema,
  ModeSetActionSchema,
  LayerToggleActionSchema,
  NoneActionSchema,
]);

export const SettingsSchema = z
  .object({
    deadzone: z.number().min(0).lt(1).default(0.12),
    outerDeadzone: z.number().gt(0).lte(1).default(0.98),
    triggerDeadzone: z.number().min(0).lt(1).default(0.08),
    chordWindowMs: z.number().nonnegative().default(60),
    holdThresholdMs: z.number().positive().default(300),
    doubleTapWindowMs: z.number().positive().default(250),
    comboSpacingMs: z.number().nonnegative().default(16),
    axisLockRatio: z.number().gte(1).default(1.5),
    hapticDetents: z.boolean().default(true),
    wheelBaseSpeed: z.number().positive().default(300),
  })
  .strict();

export const BindingSchema = z
  .object({
    mode: ModeIdSchema,
    input: InputIdSchema,
    layer: z.string().min(1).optional(),
    gesture: z.enum(['tap', 'hold', 'doubleTap']).default('tap'),
    dir: DirSchema.optional(),
    action: ActionSchema,
  })
  .strict();

const LayerSchema = z
  .object({
    id: z.string().min(1),
    hold: ButtonInputSchema,
    modes: z.array(ModeIdSchema).optional(),
  })
  .strict();

const FineSchema = z
  .object({
    hold: ButtonInputSchema,
    modes: z.array(ModeIdSchema).optional(),
    multiplier: z.number().positive(),
  })
  .strict();

const ChordSchema = z
  .object({
    mode: ModeIdSchema.optional(),
    inputs: z.array(ButtonInputSchema).min(2),
    action: ActionSchema,
  })
  .strict();

const ANALOG_ACTIONS = new Set(['jog', 'shuttle', 'wheel', 'mouseMove']);
const AXIS_INPUTS = new Set(['lstick.x', 'lstick.y', 'rstick.x', 'rstick.y']);
const STICK_2D = new Set(['lstick', 'rstick']);
const TRIGGERS = new Set(['lt', 'rt']);

export const ProfileSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    appMatch: z
      .object({
        win32: z.array(z.string()).default([]),
        darwin: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    settings: SettingsSchema.prefault({}),
    modes: z.array(ModeIdSchema).min(1),
    modeSwitch: z
      .object({
        chord: z.array(ButtonInputSchema).min(2),
        haptic: z.enum(['pulse', 'none']).default('pulse'),
      })
      .strict()
      .optional(),
    layers: z.array(LayerSchema).default([]),
    fine: FineSchema.optional(),
    chords: z.array(ChordSchema).default([]),
    bindings: z.array(BindingSchema),
  })
  .strict()
  .superRefine((p, ctx) => {
    const modes = new Set(p.modes);
    const layerIds = new Set(p.layers.map((l) => l.id));
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    if (modes.size !== p.modes.length) issue(['modes'], 'duplicate mode id');
    if (layerIds.size !== p.layers.length) issue(['layers'], 'duplicate layer id');
    p.layers.forEach((l, i) =>
      l.modes?.forEach((m) => {
        if (!modes.has(m)) issue(['layers', i, 'modes'], `unknown mode "${m}"`);
      }),
    );
    p.fine?.modes?.forEach((m) => {
      if (!modes.has(m)) issue(['fine', 'modes'], `unknown mode "${m}"`);
    });
    p.chords.forEach((c, i) => {
      if (c.mode !== undefined && !modes.has(c.mode)) issue(['chords', i, 'mode'], 'unknown mode');
      if (ANALOG_ACTIONS.has(c.action.type))
        issue(['chords', i, 'action'], 'chords take digital actions');
    });

    p.bindings.forEach((b, i) => {
      const at = ['bindings', i];
      if (!modes.has(b.mode)) issue([...at, 'mode'], `unknown mode "${b.mode}"`);
      if (b.layer !== undefined && !layerIds.has(b.layer))
        issue([...at, 'layer'], `unknown layer "${b.layer}"`);
      const a = b.action;
      if (a.type === 'modeSet' && !modes.has(a.mode))
        issue([...at, 'action'], `unknown mode "${a.mode}"`);
      if (a.type === 'layerToggle' && !layerIds.has(a.layer))
        issue([...at, 'action'], `unknown layer "${a.layer}"`);
      const isAxis = AXIS_INPUTS.has(b.input);
      if (b.dir !== undefined && !isAxis)
        issue([...at, 'dir'], '`dir` only applies to stick axis inputs');
      switch (a.type) {
        case 'jog':
          if (!isAxis) issue([...at, 'input'], 'jog needs a stick axis input (e.g. lstick.x)');
          break;
        case 'shuttle':
          if (!TRIGGERS.has(b.input)) issue([...at, 'input'], 'shuttle needs lt or rt');
          break;
        case 'mouseMove':
          if (!STICK_2D.has(b.input)) issue([...at, 'input'], 'mouseMove needs lstick or rstick');
          break;
        case 'wheel':
          if (a.part === 'balance' && !STICK_2D.has(b.input))
            issue([...at, 'input'], 'wheel balance needs lstick or rstick');
          if (a.part === 'master' && !TRIGGERS.has(b.input))
            issue([...at, 'input'], 'wheel master needs lt or rt');
          break;
        default:
          if (STICK_2D.has(b.input))
            issue([...at, 'input'], `${a.type} can't bind to a 2-D stick; use an axis with dir`);
          if (isAxis && b.dir === undefined)
            issue([...at, 'dir'], 'digital actions on a stick axis need dir: 1 or -1');
      }
      if (b.gesture !== 'tap' && (ANALOG_ACTIONS.has(a.type) || isAxis))
        issue([...at, 'gesture'], 'gestures apply to buttons only');
    });
  });

export const KeymapEntrySchema = z
  .object({
    label: z.string().min(1),
    darwin: z.string().min(1).nullable(),
    win32: z.string().min(1).nullable(),
    source: z.string().min(1),
    verified: z.boolean(),
  })
  .strict();
export const KeymapSchema = z.record(z.string().regex(COMMAND_ID_PATTERN), KeymapEntrySchema);

/**
 * `<userData>/keymap-overrides.json`: per-command shortcuts for people who changed
 * Resolve's defaults (ARCHITECTURE.md → Remapping (b)/(c)). `null` = explicitly unbound;
 * a missing OS key falls back to the shipped default for that OS.
 */
export const KeymapOverridesSchema = z.record(
  z.string().regex(COMMAND_ID_PATTERN),
  z
    .object({
      win32: z.string().min(1).nullable().optional(),
      darwin: z.string().min(1).nullable().optional(),
    })
    .strict(),
);

export const OverlayCornerSchema = z.enum(['topLeft', 'topRight', 'bottomLeft', 'bottomRight']);

/** `<userData>/settings.json`. Every field optional; missing file = defaults. */
export const HostSettingsSchema = z
  .object({
    /** Profile id: a file in `<userData>/profiles/` or a shipped profile id. */
    activeProfile: z.string().min(1).default('resolve-default'),
    overlay: z
      .object({
        enabled: z.boolean().default(true),
        corner: OverlayCornerSchema.default('topRight'),
      })
      .strict()
      .default({ enabled: true, corner: 'topRight' }),
  })
  .strict();

export type ButtonInput = z.infer<typeof ButtonInputSchema>;
export type InputId = z.infer<typeof InputIdSchema>;
export type Curve = z.infer<typeof CurveSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileInput = z.input<typeof ProfileSchema>;
export type KeymapEntry = z.infer<typeof KeymapEntrySchema>;
export type Keymap = z.infer<typeof KeymapSchema>;
export type KeymapOverrides = z.infer<typeof KeymapOverridesSchema>;
export type HostSettings = z.infer<typeof HostSettingsSchema>;
export type OverlayCorner = z.infer<typeof OverlayCornerSchema>;

export function parseProfile(raw: unknown): Profile {
  return ProfileSchema.parse(raw);
}

export function parseKeymap(raw: unknown): Keymap {
  return KeymapSchema.parse(raw);
}

/** JSON Schema for profile files (written to packages/profiles/profile.schema.json). */
export function profileJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProfileSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
}

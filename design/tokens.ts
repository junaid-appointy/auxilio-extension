/**
 * Design tokens — web port of field-app/src/design/tokens.ts.
 * Material 3 *values* (not its code), tuned for our brand ("Steady Purple",
 * primary #92288E). The CSS custom properties in global.css mirror these;
 * keep the two in sync. Prefer the CSS vars in components; this TS object is
 * for places that need values in JS (e.g. injected shadow-DOM UI).
 */

export const palette = {
  primary: '#92288E',
  onPrimary: '#FFFFFF',
  primaryContainer: '#F8D9F5',
  onPrimaryContainer: '#310031',

  secondary: '#6E5868',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#F8DAEF',
  onSecondaryContainer: '#271624',

  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',

  warn: '#7A5900',
  onWarn: '#FFFFFF',
  warnContainer: '#FFDF9E',
  onWarnContainer: '#261A00',

  success: '#3F6212',
  onSuccess: '#FFFFFF',
  successContainer: '#DCF2BC',
  onSuccessContainer: '#142000',

  background: '#FBF7FA',
  onBackground: '#1E1A1D',

  surface: '#FBF7FA',
  onSurface: '#1E1A1D',
  surfaceDim: '#DEDADD',

  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F5EFF3',
  surfaceContainer: '#EFE8EE',
  surfaceContainerHigh: '#E9E2E8',
  surfaceContainerHighest: '#E3DDE2',

  onSurfaceVariant: '#4D444B',
  outline: '#7C747A',
  outlineVariant: '#CDC4CB',

  scrim: 'rgba(0,0,0,0.45)',
} as const;

export type Palette = { [K in keyof typeof palette]: string };

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Motion durations (ms). Animations stay subtle and only where they aid clarity. */
export const motion = {
  fast: 120,
  base: 200,
  slow: 320,
  /** MD3 standard easing. */
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  easingEmphasized: 'cubic-bezier(0.3, 0, 0, 1)',
} as const;

export const type = {
  headlineSmall: { fontSize: 24, lineHeight: 32, fontWeight: 700 },
  titleLarge: { fontSize: 22, lineHeight: 28, fontWeight: 600 },
  titleMedium: { fontSize: 16, lineHeight: 24, fontWeight: 600, letterSpacing: 0.15 },
  bodyLarge: { fontSize: 15, lineHeight: 22, fontWeight: 400, letterSpacing: 0.15 },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontWeight: 400, letterSpacing: 0.25 },
  labelLarge: { fontSize: 14, lineHeight: 20, fontWeight: 600, letterSpacing: 0.1 },
  labelMedium: { fontSize: 12, lineHeight: 16, fontWeight: 600, letterSpacing: 0.5 },
} as const;

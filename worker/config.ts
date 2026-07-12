// The single active event. Registration rows are keyed by this slug, so bump it
// (and redeploy) each season. Everything per-event in D1 hangs off `slug`.
export const CURRENT_EVENT = {
  slug: 'hacksv-2026',
  name: 'hack.sv 2026',
} as const

// Max length of the free-form "what have you been building" field. Deliberately
// generous — high enough no genuine answer hits it, low enough to bound abuse.
// Enforced server-side on submit and draft-save; the client mirrors it as the
// textarea maxLength. Keep in sync with FREEFORM_MAX in src/Register.tsx.
export const FREEFORM_MAX = 32000

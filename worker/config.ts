// The single active event. Registration rows are keyed by this slug, so bump it
// (and redeploy) each season. Everything per-event in D1 hangs off `slug`.
export const CURRENT_EVENT = {
  slug: 'hacksv-2026',
  name: 'hack.sv 2026',
} as const

// Max length of the free-form "anything you'd like" field. Enforced server-side
// on submit and draft-save; the client mirrors it as a live counter.
export const FREEFORM_MAX = 2000

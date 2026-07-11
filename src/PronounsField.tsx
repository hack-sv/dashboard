import { useEffect, useRef, useState } from 'react'
import { SegmentedField, type SegmentNav, type SegmentSpec } from './SegmentedField'
import './segmented.css'
import './PronounsField.css'

/**
 * PronounsField — pronouns as a three-segment control
 * (subjective / objective / possessive, e.g. `they / them / theirs`).
 *
 * Standardized-by-default but never locked: the 99% pick one of the common sets
 * from the quick-select menu in a single tap, while anyone can type a custom
 * value straight into any segment ("let people edit if it's wrong"). Built on
 * SegmentedField, so it looks and navigates like DateField's sibling.
 *
 * `value` is the canonical `"a/b/c"` string (or '' when empty). 2-part input is
 * accepted gracefully — the third segment simply stays empty, and only the
 * filled leading segments are emitted.
 */

const SEG_LABELS = ['Subjective', 'Objective', 'Possessive'] as const
const PLACEHOLDERS = ['they', 'them', 'theirs'] as const

// The standardized sets, common first. `he/they` and `she/they` are the two
// widely-used combined forms; they fill the first two segments and leave the
// third empty (emitted as a 2-part value).
const PRESETS: readonly string[] = [
  'she/her/hers',
  'he/him/his',
  'they/them/theirs',
  'she/they',
  'he/they',
]

// Letters plus the marks that show up in pronouns (e.g. curly apostrophes,
// hyphenated neopronouns). Spaces/digits/slashes are handled by the primitive.
const ALLOWED = /[a-zA-Z'’-]/

type Segs = [string, string, string]

function parseValue(value: string): Segs {
  const parts = value.split('/').map((s) => s.trim())
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '']
}

/** Join filled segments, dropping trailing empties, into the canonical string. */
function toValue(segs: Segs): string {
  const parts = segs.map((s) => s.trim())
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.join('/')
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="pronouns-check">
      <path
        d="M5 12l5 5 9-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export interface PronounsFieldProps {
  /** Canonical `"a/b/c"` pronoun string, or '' when empty. */
  value: string
  /** Emits the canonical `"a/b/c"` string (trailing empty segments dropped). */
  onChange: (value: string) => void
  /** Optional, for label association. */
  id?: string
}

export function PronounsField({ value, onChange, id }: PronounsFieldProps) {
  const [segs, setSegs] = useState<Segs>(() => parseValue(value))
  const [prevValue, setPrevValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const wrapperRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Controlled sync: adopt an external `value` unless it's the echo of our own.
  if (value !== prevValue) {
    setPrevValue(value)
    if (value !== toValue(segs)) setSegs(parseValue(value))
  }

  function apply(next: Segs) {
    setSegs(next)
    const v = toValue(next)
    if (v !== value) onChange(v)
  }

  function setSeg(i: number, text: string) {
    const next = [...segs] as Segs
    next[i] = text
    apply(next)
  }

  function inputChars(i: number, text: string) {
    const filtered = Array.from(text)
      .filter((ch) => ALLOWED.test(ch))
      .join('')
      .toLowerCase()
    if (!filtered) return
    setSeg(i, segs[i] + filtered)
  }

  function handlePaste(text: string, nav: SegmentNav, activeSeg: number) {
    // "she/her/hers" or "she her hers" → fill all; a lone word → this segment.
    const tokens = text
      .trim()
      .split(/[/\s]+/)
      .map((t) => t.replace(/[^a-zA-Z'’-]/g, '').toLowerCase())
      .filter(Boolean)
    if (tokens.length === 0) return
    if (tokens.length === 1) {
      setSeg(activeSeg, tokens[0])
      return
    }
    apply([tokens[0] ?? '', tokens[1] ?? '', tokens[2] ?? ''])
    nav.focus(0)
  }

  // --- Quick-select menu -------------------------------------------------

  const currentValue = toValue(segs)

  function openMenu() {
    const sel = PRESETS.indexOf(currentValue)
    setActiveIndex(sel >= 0 ? sel : 0)
    setOpen(true)
  }

  function closeMenu(focusBtn = true) {
    setOpen(false)
    if (focusBtn) btnRef.current?.focus()
  }

  function choose(preset: string) {
    apply(parseValue(preset))
    setOpen(false)
    // Return focus to the box so a custom tweak is one keystroke away.
    wrapperRef.current?.querySelector('input')?.focus()
  }

  // Move roving focus onto the active option whenever the menu opens or moves.
  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  // Dismiss on an outside pointer press.
  useEffect(() => {
    if (!open) return
    function onDown(e: PointerEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % PRESETS.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + PRESETS.length) % PRESETS.length)
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(PRESETS.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        choose(PRESETS[activeIndex])
        break
      case 'Escape':
        e.preventDefault()
        closeMenu()
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  const segments: SegmentSpec[] = segs.map((text, i) => {
    const placeholder = PLACEHOLDERS[i]
    const chars = Math.max((text || placeholder).length, 2) + 1
    return {
      key: SEG_LABELS[i],
      text,
      placeholder,
      label: SEG_LABELS[i],
      inputMode: 'text',
      width: `${chars}ch`,
      onInput: (t) => inputChars(i, t),
      onBackspace: () => setSeg(i, segs[i].slice(0, -1)),
      onClear: () => setSeg(i, ''),
    }
  })

  return (
    <div className="pronouns-field" ref={wrapperRef}>
      <SegmentedField
        segments={segments}
        id={id}
        label="Pronouns"
        separator="/"
        advanceKeys={['/', ' ']}
        onPasteText={handlePaste}
        className="seg-field--pronouns"
      />
      <button
        ref={btnRef}
        type="button"
        className="pronouns-menu-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choose a standard pronoun set"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openMenu()
          }
        }}
      >
        <ChevronDown />
      </button>
      {open && (
        <ul className="pronouns-menu" role="listbox" aria-label="Standard pronoun sets">
          {PRESETS.map((preset, i) => (
            <li key={preset} role="presentation">
              <button
                ref={(el) => {
                  optionRefs.current[i] = el
                }}
                type="button"
                role="option"
                aria-selected={preset === currentValue}
                tabIndex={i === activeIndex ? 0 : -1}
                className={`pronouns-option${i === activeIndex ? ' is-active' : ''}`}
                onClick={() => choose(preset)}
                onMouseMove={() => setActiveIndex(i)}
                onKeyDown={onMenuKeyDown}
              >
                <span>{preset}</span>
                <CheckMark />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

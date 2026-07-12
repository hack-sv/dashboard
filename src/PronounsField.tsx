import { useEffect, useRef, useState } from 'react'
import { SegmentedField, type SegmentNav, type SegmentSpec } from './SegmentedField'
import './segmented.css'
import './PronounsField.css'

/**
 * PronounsField — a plain dropdown for the common pronoun sets, with an
 * "Other…" door for everything else.
 *
 * Most people pick one of the three standard sets in a single tap. "Other…"
 * swaps the closed control for a three-segment editor (subjective / objective /
 * possessive) where any set — mixed (he/them), neopronoun (ze/zir), whatever —
 * can be typed straight in. Standardized by default, never locked; starts blank
 * so no single set is presumed.
 *
 * `value` is the canonical `"a/b/c"` string (or '' when empty). 2-part custom
 * input is accepted — the trailing segment simply stays empty.
 */

// Common-first. Each is a full three-part set so a returning user sees the whole
// thing, not just "he/him".
const PRESETS = ['he/him/his', 'she/her/hers', 'they/them/theirs'] as const
const OTHER = '__other__'
const OPTIONS = [...PRESETS, OTHER] as const

const SEG_LABELS = ['Subjective', 'Objective', 'Possessive'] as const
// No placeholder words: empty segments render as fill-in-the-blank underlines
// (CSS), so the editor doesn't presume any set.
const PLACEHOLDERS = ['', '', ''] as const

// Letters plus the marks that show up in pronouns (curly apostrophes,
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

/** "he/him/his" → "he / him / his" for the closed control. */
function pretty(value: string): string {
  return parseValue(value).filter(Boolean).join(' / ')
}

const isPreset = (v: string): boolean => (PRESETS as readonly string[]).includes(v)

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
  // "Other…" mode: a non-empty value that isn't one of the three standard sets
  // must have come through the custom editor, so open in that mode.
  const [custom, setCustom] = useState(() => value !== '' && !isPreset(value))
  const [segs, setSegs] = useState<Segs>(() => parseValue(value))
  const [prevValue, setPrevValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const wrapperRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Set when we switch into custom mode from the menu, so the effect below
  // focuses the editor once it renders (but not on an initial custom mount).
  const focusEditor = useRef(false)

  // Controlled sync: adopt an external `value` unless it's the echo of our own.
  if (value !== prevValue) {
    setPrevValue(value)
    if (value !== toValue(segs)) setSegs(parseValue(value))
    if (value !== '' && !isPreset(value)) setCustom(true)
    else if (isPreset(value)) setCustom(false)
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

  // --- Dropdown menu -----------------------------------------------------

  const selectedIndex = custom ? OPTIONS.indexOf(OTHER) : PRESETS.indexOf(value as (typeof PRESETS)[number])

  function openMenu() {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function closeMenu(focusBtn = true) {
    setOpen(false)
    if (focusBtn) btnRef.current?.focus()
  }

  function choose(index: number) {
    const opt = OPTIONS[index]
    setOpen(false)
    if (opt === OTHER) {
      focusEditor.current = true
      setCustom(true)
      return
    }
    setCustom(false)
    apply(parseValue(opt))
    btnRef.current?.focus()
  }

  /** Which option (if any) sits under a viewport point — for drag-to-select. */
  function optionIndexAt(x: number, y: number): number {
    for (let i = 0; i < optionRefs.current.length; i++) {
      const el = optionRefs.current[i]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i
    }
    return -1
  }

  // Press-drag-release: a press anywhere on the control (except the editor's
  // own inputs) opens the menu; sliding highlights options and releasing over
  // one selects it — one gesture, and touch-friendly. A plain tap just opens.
  function beginPointer(e: React.PointerEvent) {
    if (e.button !== 0) return // primary button / touch only
    if (e.target instanceof Element) {
      // Presses on the open menu are the options' own to handle (click / drag
      // release); presses on the editor's inputs are for typing.
      if (e.target.closest('.pronouns-menu') || e.target.closest('.seg-field-seg')) return
    }
    e.preventDefault()
    if (open) {
      setOpen(false)
      return
    }
    openMenu()
    let everOnOption = false
    const ac = new AbortController()
    const onMove = (ev: PointerEvent) => {
      const i = optionIndexAt(ev.clientX, ev.clientY)
      if (i >= 0) {
        everOnOption = true
        setActiveIndex(i)
      }
    }
    const onUp = (ev: PointerEvent) => {
      ac.abort()
      const i = optionIndexAt(ev.clientX, ev.clientY)
      if (i >= 0) choose(i)
      else if (everOnOption) setOpen(false) // dragged off the list → cancel
      // otherwise a plain tap: leave the menu open to click an option next
    }
    document.addEventListener('pointermove', onMove, { signal: ac.signal })
    document.addEventListener('pointerup', onUp, { signal: ac.signal })
    document.addEventListener('pointercancel', () => ac.abort(), { signal: ac.signal })
  }

  // Keyboard on the closed trigger: open the menu (focus moves onto an option).
  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (open) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu()
    }
  }

  // After switching into custom mode from the menu, focus the first segment.
  useEffect(() => {
    if (custom && focusEditor.current) {
      focusEditor.current = false
      wrapperRef.current?.querySelector<HTMLInputElement>('.seg-field-seg')?.focus()
    }
  }, [custom])

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
        setActiveIndex((i) => (i + 1) % OPTIONS.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length)
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(OPTIONS.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        choose(activeIndex)
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
    <div className="pronouns-field" ref={wrapperRef} onPointerDown={beginPointer}>
      {custom ? (
        <div className="pronouns-custom">
          <SegmentedField
            segments={segments}
            id={id}
            label="Pronouns"
            separator="/"
            advanceKeys={['/', ' ']}
            onPasteText={handlePaste}
            gapFocus={false}
            className="seg-field--pronouns"
          />
          <button
            ref={btnRef}
            type="button"
            className="pronouns-menu-btn"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Choose a pronoun set"
            onKeyDown={onTriggerKeyDown}
          >
            <ChevronDown />
          </button>
        </div>
      ) : (
        <button
          ref={btnRef}
          type="button"
          id={id}
          className="pronouns-select"
          aria-haspopup="listbox"
          aria-expanded={open}
          onKeyDown={onTriggerKeyDown}
        >
          <span className={`pronouns-select-value${value ? '' : ' is-placeholder'}`}>
            {value ? pretty(value) : 'Select pronouns'}
          </span>
          <ChevronDown />
        </button>
      )}
      {open && (
        <ul className="pronouns-menu" role="listbox" aria-label="Pronoun sets">
          {OPTIONS.map((opt, i) => {
            const isOther = opt === OTHER
            const selected = isOther ? custom : !custom && opt === value
            return (
              <li key={opt} role="presentation">
                <button
                  ref={(el) => {
                    optionRefs.current[i] = el
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={i === activeIndex ? 0 : -1}
                  className={`pronouns-option${i === activeIndex ? ' is-active' : ''}${
                    isOther ? ' pronouns-option--other' : ''
                  }`}
                  onClick={() => choose(i)}
                  onMouseMove={() => setActiveIndex(i)}
                  onKeyDown={onMenuKeyDown}
                >
                  <span>{isOther ? 'Other…' : pretty(opt)}</span>
                  <CheckMark />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

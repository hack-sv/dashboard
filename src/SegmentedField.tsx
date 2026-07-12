import { Fragment, useRef } from 'react'
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent } from 'react'
import './segmented.css'

/**
 * SegmentedField — the shared shell for fixed-format segmented inputs
 * (DateField's `MM / DD / YYYY`, PronounsField's `they / them / theirs`, …).
 *
 * Renders the same flat white box as `.field` (login.css): a row of focusable
 * segments with literal separators between them. Dropped *inside* a `.field`
 * row it sheds the box and fills the row like a plain input would.
 *
 * Each segment is a real `<input>` — mobile keyboards and focus semantics come
 * for free — but every edit is intercepted (keydown + beforeinput) and the
 * text is fully controlled by the owning field, so no native widget (calendar,
 * autofill dropdown…) can ever appear.
 *
 * The primitive owns everything segments have in common:
 *   - ArrowLeft / ArrowRight move between segments
 *   - Backspace on an empty segment steps back (non-empty delegates to the field)
 *   - Delete clears the segment (via the field's `onClear`)
 *   - typing a separator character hops forward, like native date inputs
 *   - clicks on the box (padding, separators) focus the nearest segment
 *   - paste anywhere is routed whole to the field's `onPasteText`
 *   - virtual keyboards that skip real keydowns still work via beforeinput
 *
 * What a segment *means* — which characters it accepts, when it is full and
 * should auto-advance (`nav.next()`), spinbutton stepping, blur commits — is
 * the field's job, expressed through the `SegmentSpec` callbacks.
 */

/** Focus control handed to segment callbacks. `next`/`prev` are relative to
 *  the segment handling the event; `focus` is absolute. Out-of-range moves
 *  are no-ops, so "advance from the last segment" needs no special-casing. */
export interface SegmentNav {
  focus(index: number): void
  next(): void
  prev(): void
}

export interface SegmentSpec {
  key: string
  /** Rendered text; '' shows the placeholder. */
  text: string
  placeholder: string
  /** aria-label — segments are unlabelled visually. */
  label: string
  inputMode?: 'numeric' | 'text'
  /** CSS width. Fixed widths keep the row still while typing. */
  width?: string
  /** Present → the segment renders as `role="spinbutton"` with these values.
   *  `now` omitted means empty; `text` is the spoken value ("January"). */
  spin?: { min: number; max: number; now?: number; text: string }
  /** Printable characters typed into the segment (separators never reach here).
   *  Filter, accumulate, and call `nav.next()` when the segment is full. */
  onInput(text: string, nav: SegmentNav): void
  /** Backspace on a non-empty segment (empty ones step back automatically). */
  onBackspace(nav: SegmentNav): void
  /** Delete key. */
  onClear?(nav: SegmentNav): void
  /** First look at any other key (ArrowUp/Down, Home/End, Escape…).
   *  Return true to consume it; unclaimed keys keep their default behavior
   *  (Tab moves on, Enter submits the form). */
  onKey?(key: string, nav: SegmentNav): boolean
  onFocus?(): void
  onBlur?(): void
}

export interface SegmentedFieldProps {
  segments: readonly SegmentSpec[]
  /** Set on the group container, mirroring the old single-input `id`. */
  id?: string
  /** aria-label for the group ("Date", "Pronouns"). */
  label?: string
  /** Literal rendered between segments. Default '/'. */
  separator?: string
  /** Typed characters that hop to the next segment. Default: the separator. */
  advanceKeys?: readonly string[]
  /** Pasted (or mobile-committed) text, e.g. "2010-01-22". `activeIndex` is the
   *  segment the caret was in — useful when the paste is a single token. */
  onPasteText?: (text: string, nav: SegmentNav, activeIndex: number) => void
  /** When false, clicks on the box's gaps (padding, separators) are left alone
   *  instead of focusing the nearest segment — the owner handles them (e.g.
   *  PronounsField opens its menu). Default true. */
  gapFocus?: boolean
  className?: string
}

export function SegmentedField({
  segments,
  id,
  label,
  separator = '/',
  advanceKeys,
  onPasteText,
  gapFocus = true,
  className,
}: SegmentedFieldProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const advance = advanceKeys ?? [separator]

  function navFor(index: number): SegmentNav {
    return {
      focus: (i) => refs.current[i]?.focus(),
      next: () => refs.current[index + 1]?.focus(),
      prev: () => refs.current[index - 1]?.focus(),
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return // leave shortcuts (paste…) alone
    const seg = segments[index]
    const nav = navFor(index)
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        nav.prev()
        return
      case 'ArrowRight':
        e.preventDefault()
        nav.next()
        return
      case 'Backspace':
        e.preventDefault()
        if (seg.text === '') nav.prev()
        else seg.onBackspace(nav)
        return
      case 'Delete':
        e.preventDefault()
        seg.onClear?.(nav)
        return
    }
    if (seg.onKey?.(e.key, nav)) {
      e.preventDefault()
      return
    }
    if (e.key.length === 1) {
      // Every printable key is ours: separators hop, the rest goes to the
      // field (which drops what it doesn't accept). Tab/Enter/Escape pass.
      e.preventDefault()
      if (advance.includes(e.key)) {
        if (seg.text !== '') nav.next()
      } else {
        seg.onInput(e.key, nav)
      }
    }
  }

  /** Mobile fallback: virtual keyboards that skip real keydowns (key
   *  "Unidentified") still fire beforeinput. Desktop characters never reach
   *  here — their keydown was already consumed. */
  function handleBeforeInput(index: number, e: FormEvent<HTMLInputElement>) {
    const native = e.nativeEvent as InputEvent
    e.preventDefault()
    const seg = segments[index]
    const nav = navFor(index)
    if (native.inputType === 'deleteContentBackward') {
      if (seg.text === '') nav.prev()
      else seg.onBackspace(nav)
      return
    }
    const data = native.data
    if (!data) return
    if (data.length > 1 && advance.some((k) => data.includes(k))) {
      // A whole formatted value committed at once (swipe paste, autofill).
      onPasteText?.(data, nav, index)
      return
    }
    if (data.length === 1 && advance.includes(data)) {
      if (seg.text !== '') nav.next()
      return
    }
    seg.onInput(data, nav)
  }

  function handlePaste(e: ClipboardEvent) {
    if (!onPasteText) return
    e.preventDefault()
    const active = refs.current.findIndex((el) => el != null && el === document.activeElement)
    const index = Math.max(active, 0)
    onPasteText(e.clipboardData.getData('text'), navFor(index), index)
  }

  /** Clicks on the box itself (separators, padding) land on the nearest
   *  segment, like native date inputs. */
  function handleMouseDown(e: MouseEvent) {
    if (e.target instanceof HTMLInputElement) return
    if (!gapFocus) return // owner handles gap presses (e.g. opens a menu)
    e.preventDefault()
    let best: HTMLInputElement | null = null
    let bestDist = Infinity
    for (const el of refs.current) {
      if (!el) continue
      const r = el.getBoundingClientRect()
      const d = e.clientX < r.left ? r.left - e.clientX : Math.max(e.clientX - r.right, 0)
      if (d < bestDist) {
        bestDist = d
        best = el
      }
    }
    best?.focus()
  }

  const empty = segments.every((s) => s.text === '')

  return (
    <div
      className={`seg-field${empty ? ' seg-field--empty' : ''}${className ? ` ${className}` : ''}`}
      id={id}
      role="group"
      aria-label={label}
      onMouseDown={handleMouseDown}
      onPaste={handlePaste}
      onDrop={(e: DragEvent) => e.preventDefault()}
    >
      {segments.map((seg, i) => (
        <Fragment key={seg.key}>
          {i > 0 && (
            <span className="seg-field-sep" aria-hidden="true">
              {separator}
            </span>
          )}
          <input
            ref={(el) => {
              refs.current[i] = el
            }}
            className="seg-field-seg"
            style={seg.width ? { width: seg.width } : undefined}
            type="text"
            inputMode={seg.inputMode ?? 'text'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            role={seg.spin ? 'spinbutton' : undefined}
            aria-label={seg.label}
            aria-valuemin={seg.spin?.min}
            aria-valuemax={seg.spin?.max}
            aria-valuenow={seg.spin?.now}
            aria-valuetext={seg.spin?.text}
            placeholder={seg.placeholder}
            value={seg.text}
            onChange={() => {
              // Editing happens in onKeyDown/onBeforeInput; React restores
              // the controlled value if anything slips through.
            }}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onBeforeInput={(e) => handleBeforeInput(i, e)}
            onFocus={seg.onFocus}
            onBlur={seg.onBlur}
          />
        </Fragment>
      ))}
    </div>
  )
}

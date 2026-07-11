import { useRef, useState } from 'react'
import { SegmentedField, type SegmentNav, type SegmentSpec } from './SegmentedField'
import './segmented.css'

/**
 * DateField — a segmented `MM / DD / YYYY` date input built on SegmentedField.
 *
 * A from-scratch replacement for `<input type="date">` that keeps the good part
 * (typeable segments, smart auto-advance, arrow stepping) and drops the browser
 * calendar button/popup entirely. Standalone it renders the same flat white box
 * as `.field` (login.css); dropped *inside* a `.field` row it sheds the box.
 *
 * DateField owns only the date model + the native-style digit-entry state
 * machine; SegmentedField owns focus, separators, click/paste routing, and
 * keyboard navigation across segments.
 */

type SegmentKey = 'month' | 'day' | 'year'
type SegmentValues = Record<SegmentKey, number | null>

const ORDER: readonly SegmentKey[] = ['month', 'day', 'year']

interface DateSegmentSpec {
  key: SegmentKey
  label: string
  placeholder: string
  width: string
  /** Digits the segment holds when full ("MM" = 2, "YYYY" = 4). */
  maxDigits: number
  /** Smallest committable value. */
  min: number
  /** Largest committable value, given the other segments (day depends on month/year). */
  maxFor: (values: SegmentValues) => number
  /** Range ArrowUp/ArrowDown wrap within. Typing may be looser (year). */
  stepRange: (values: SegmentValues) => [number, number]
  /** Where arrow keys start from when the segment is empty. */
  todayValue: (today: Date) => number
  /** Spoken value for screen readers (falls back to the number). */
  valueText?: (v: number) => string
}

// Arrows step the year within a sane window; typed/pasted years may be wider.
const YEAR_STEP_MIN = 1900
const YEAR_STEP_MAX = 2099

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** Unknown month → 31; February with unknown year → 29 (be permissive until known). */
function daysInMonth(month: number | null, year: number | null): number {
  if (month == null) return 31
  if (month === 2) return year == null || isLeapYear(year) ? 29 : 28
  return MONTH_DAYS[month - 1]
}

const DATE_SPECS: Record<SegmentKey, DateSegmentSpec> = {
  month: {
    key: 'month',
    label: 'Month',
    placeholder: 'MM',
    width: '2.3em',
    maxDigits: 2,
    min: 1,
    maxFor: () => 12,
    stepRange: () => [1, 12],
    todayValue: (t) => t.getMonth() + 1,
    valueText: (v) => MONTH_NAMES[v - 1],
  },
  day: {
    key: 'day',
    label: 'Day',
    placeholder: 'DD',
    width: '2.3em',
    maxDigits: 2,
    min: 1,
    maxFor: (values) => daysInMonth(values.month, values.year),
    stepRange: (values) => [1, daysInMonth(values.month, values.year)],
    todayValue: (t) => t.getDate(),
  },
  year: {
    key: 'year',
    label: 'Year',
    placeholder: 'YYYY',
    width: '3.2em',
    maxDigits: 4,
    min: 1,
    maxFor: () => 9999,
    stepRange: () => [YEAR_STEP_MIN, YEAR_STEP_MAX],
    todayValue: (t) => t.getFullYear(),
  },
}

const EMPTY: SegmentValues = { month: null, day: null, year: null }

function pad(v: number, digits: number): string {
  return String(v).padStart(digits, '0')
}

function parseIso(value: string): SegmentValues {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return EMPTY
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return EMPTY
  return { month, day, year }
}

function toIso(values: SegmentValues, yearPending: boolean): string {
  if (values.month == null || values.day == null || values.year == null || yearPending) return ''
  const day = Math.min(values.day, daysInMonth(values.month, values.year))
  return `${pad(values.year, 4)}-${pad(values.month, 2)}-${pad(day, 2)}`
}

/** '19' → 2019, '45' → 1945 (never a future year), '1990' → 1990 as-is. */
function expandYear(raw: string): number {
  const n = Number(raw)
  if (raw.length > 2) return n
  const full = 2000 + n
  return full > new Date().getFullYear() ? 1900 + n : full
}

/** Accepts ISO (2010-01-22), US-style M/D/Y (01/22/2010, 1/22/10), D/M/Y when
 *  unambiguous (22/1/2010), and bare YYYYMMDD. Returns null when unparseable. */
function parsePasted(text: string): SegmentValues | null {
  const t = text.trim()
  let month: number
  let day: number
  let year: number
  const ymd =
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t) ??
    /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t) ??
    /^(\d{4})(\d{2})(\d{2})$/.exec(t)
  if (ymd) {
    year = Number(ymd[1])
    month = Number(ymd[2])
    day = Number(ymd[3])
  } else {
    const mdy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t)
    if (!mdy) return null
    month = Number(mdy[1])
    day = Number(mdy[2])
    year = expandYear(mdy[3])
    if (month > 12 && day <= 12) [month, day] = [day, month] // day-first paste
  }
  if (month < 1 || month > 12 || day < 1 || year < 1 || year > 9999) return null
  return { month, day: Math.min(day, daysInMonth(month, year)), year }
}

export interface DateFieldProps {
  /** ISO 'YYYY-MM-DD', or '' when empty/incomplete. */
  value: string
  /** Emits 'YYYY-MM-DD' when all three segments form a valid date, else ''. */
  onChange: (iso: string) => void
  /** Optional, for label association. */
  id?: string
}

export function DateField({ value, onChange, id }: DateFieldProps) {
  const [segs, setSegs] = useState<SegmentValues>(() => parseIso(value))
  const [prevValue, setPrevValue] = useState(value)
  // Digit-entry session for the focused segment. Reset on focus/arrow so that
  // typing over a full segment replaces instead of appending.
  const entryRef = useRef<{ key: SegmentKey | null; digits: number }>({ key: null, digits: 0 })

  // A 1–3 digit year is a prefix, not a value — never emit it as a date.
  // (Month/day commit eagerly, like native: "1" in month is already January.)
  function yearPending(): boolean {
    const entry = entryRef.current
    return entry.key === 'year' && entry.digits > 0 && entry.digits < DATE_SPECS.year.maxDigits
  }

  // Controlled sync: adopt an external `value` change unless the segments
  // already represent it (i.e. it's the echo of our own onChange).
  if (value !== prevValue) {
    setPrevValue(value)
    if (value !== toIso(segs, yearPending())) {
      setSegs(parseIso(value))
      entryRef.current = { key: null, digits: 0 }
    }
  }

  function emit(next: SegmentValues) {
    const iso = toIso(next, yearPending())
    if (iso !== value) onChange(iso)
  }

  /** Commit a new segment state: cross-clamp the day, render, notify. */
  function apply(next: SegmentValues) {
    if (next.day != null) {
      const max = daysInMonth(next.month, next.year)
      if (next.day > max) next = { ...next, day: max }
    }
    setSegs(next)
    emit(next)
  }

  /** Feed typed digits through the native-style entry state machine:
   *  accumulate, restart on overflow ("1" then "5" in month → 05), and
   *  auto-advance once the segment can't accept another digit. */
  function inputDigits(startKey: SegmentKey, text: string, nav: SegmentNav) {
    let key = startKey
    let digits = entryRef.current.key === key ? entryRef.current.digits : 0
    const next: SegmentValues = { ...segs }
    let changed = false
    for (const ch of text) {
      if (ch < '0' || ch > '9') continue
      const d = Number(ch)
      const spec = DATE_SPECS[key]
      const max = spec.maxFor(next)
      let v: number
      if (digits === 0) {
        v = d
        digits = 1
      } else {
        v = (next[key] ?? 0) * 10 + d
        if (v > max) {
          v = d
          digits = 1
        } else {
          digits += 1
        }
      }
      next[key] = v
      changed = true
      // Full, or even a trailing 0 would overflow → this segment is done.
      if (digits >= spec.maxDigits || v * 10 > max) {
        if (v < spec.min) next[key] = spec.min // "00" → 01
        digits = 0
        const i = ORDER.indexOf(key)
        const after = ORDER[i + 1]
        if (after) key = after
      }
    }
    if (!changed) return
    if (key !== startKey) nav.focus(ORDER.indexOf(key)) // focus first: its onFocus resets…
    entryRef.current = { key, digits } // …then restore the in-flight session
    apply(next)
  }

  function step(spec: DateSegmentSpec, dir: 1 | -1) {
    const [min, max] = spec.stepRange(segs)
    const v = segs[spec.key]
    let next: number
    if (v == null) next = Math.min(Math.max(spec.todayValue(new Date()), min), max)
    else if (v < min || v > max) next = Math.min(Math.max(v, min), max) // pull strays into range
    else if (dir === 1) next = v >= max ? min : v + 1
    else next = v <= min ? max : v - 1
    entryRef.current = { key: spec.key, digits: 0 }
    apply({ ...segs, [spec.key]: next })
  }

  function setTo(spec: DateSegmentSpec, v: number) {
    entryRef.current = { key: spec.key, digits: 0 }
    apply({ ...segs, [spec.key]: v })
  }

  /** Drop the last digit. (Empty-segment step-back is handled by the primitive.) */
  function backspace(spec: DateSegmentSpec) {
    const v = segs[spec.key]
    if (v == null) return
    const truncated = Math.floor(v / 10)
    entryRef.current = {
      key: spec.key,
      digits: truncated > 0 ? String(truncated).length : 0,
    }
    apply({ ...segs, [spec.key]: truncated > 0 ? truncated : null })
  }

  function clearSeg(spec: DateSegmentSpec) {
    entryRef.current = { key: spec.key, digits: 0 }
    apply({ ...segs, [spec.key]: null })
  }

  function handleKey(spec: DateSegmentSpec, key: string): boolean {
    switch (key) {
      case 'ArrowUp':
        step(spec, 1)
        return true
      case 'ArrowDown':
        step(spec, -1)
        return true
      case 'Home':
        setTo(spec, spec.stepRange(segs)[0])
        return true
      case 'End':
        setTo(spec, spec.stepRange(segs)[1])
        return true
      default:
        return false
    }
  }

  function handleFocus(spec: DateSegmentSpec) {
    entryRef.current = { key: spec.key, digits: 0 }
  }

  /** Leaving a segment commits any partial entry: a short year gets the
   *  2-digit pivot ("19" → 2019, "45" → 1945), a lone "0" clamps to 01. */
  function handleBlur(spec: DateSegmentSpec) {
    const entry = entryRef.current
    if (entry.key !== spec.key) return
    entryRef.current = { key: null, digits: 0 }
    const v = segs[spec.key]
    if (v == null || entry.digits === 0) return
    if (spec.key === 'year' && entry.digits < spec.maxDigits) {
      apply({ ...segs, year: Math.max(1, expandYear(String(v).padStart(entry.digits, '0'))) })
    } else if (v < spec.min) {
      apply({ ...segs, [spec.key]: spec.min })
    }
  }

  function handlePaste(text: string, nav: SegmentNav) {
    const parsed = parsePasted(text)
    if (!parsed) return
    nav.focus(ORDER.indexOf('year'))
    entryRef.current = { key: null, digits: 0 }
    apply(parsed)
  }

  const segments: SegmentSpec[] = ORDER.map((key) => {
    const spec = DATE_SPECS[key]
    const v = segs[key]
    const [stepMin, stepMax] = spec.stepRange(segs)
    return {
      key,
      text: v == null ? '' : pad(v, spec.maxDigits),
      placeholder: spec.placeholder,
      label: spec.label,
      inputMode: 'numeric',
      width: spec.width,
      spin: {
        min: stepMin,
        max: stepMax,
        now: v ?? undefined,
        text: v == null ? 'Empty' : (spec.valueText?.(v) ?? String(v)),
      },
      onInput: (t, nav) => inputDigits(key, t, nav),
      onBackspace: () => backspace(spec),
      onClear: () => clearSeg(spec),
      onKey: (k) => handleKey(spec, k),
      onFocus: () => handleFocus(spec),
      onBlur: () => handleBlur(spec),
    }
  })

  return (
    <SegmentedField
      segments={segments}
      id={id}
      label="Date"
      separator="/"
      advanceKeys={['/', '-', '.']}
      onPasteText={handlePaste}
      className="seg-field--date"
    />
  )
}

'use client';

import { useCallback, useMemo, useState } from 'react';

// ─── Shared validation-timing hook ───────────────────────────────────────────
//
// One hook, one timing model for every signup form (patient + practice) and
// every future form that needs the same UX. Behaviour:
//
//   • Errors do not show before a field has been touched. "Touched" means
//     the field's blur handler has fired once.
//   • Once a field is touched, its error is recomputed on every keystroke
//     (because we re-run validation when `values` changes). The error
//     therefore clears the instant the user fixes it — positive feedback,
//     not nagging.
//   • A field's validator can opt out of live-mode errors via
//     `suppressLive`. Used by SA ID: while the user has fewer than 13
//     digits typed we never show a date/checksum error.
//   • `validateAll()` is the submit backstop. It runs every validator
//     (ignoring `suppressLive`), marks every registered field touched, and
//     returns the first invalid field name in declaration order so the
//     caller can focus + scroll to it.
//
// The hook does NOT own the form's values — the consumer keeps its own
// useState. We just take a snapshot of `values` to validate against. This
// keeps the hook generic over checkboxes, custom pickers (SalaryDayPicker),
// etc., without needing per-field adapters.

export type FieldValidator<V extends Record<string, unknown>> = (values: V) => string | null;

export type FieldConfig<V extends Record<string, unknown>> = {
  /** Returns an error message, or null when the field is currently valid. */
  validate: FieldValidator<V>;
  /**
   * Returns true to suppress the live-mode error display even when
   * `validate` would return one. Submit-mode ignores this. Default: never
   * suppress (errors show as soon as the field is touched).
   */
  suppressLive?: (values: V) => boolean;
};

export type FieldsSchema<V extends Record<string, unknown>> =
  Partial<Record<keyof V, FieldConfig<V>>>;

export type ValidateAllResult<V extends Record<string, unknown>> = {
  ok:           boolean;
  firstInvalid: keyof V | null;
};

export type UseFieldValidationResult<V extends Record<string, unknown>> = {
  errors:        Partial<Record<keyof V, string | null>>;
  touched:       Partial<Record<keyof V, boolean>>;
  handleBlur:    (name: keyof V) => void;
  markTouched:   (name: keyof V) => void;
  validateAll:   () => ValidateAllResult<V>;
  resetTouched:  () => void;
};

export function useFieldValidation<V extends Record<string, unknown>>(
  values: V,
  schema: FieldsSchema<V>,
): UseFieldValidationResult<V> {
  const [touched,   setTouched]   = useState<Partial<Record<keyof V, boolean>>>({});
  // Once the user clicks Submit, `suppressLive` no longer hides errors for
  // any field — they are in correction mode and need to see what's wrong.
  // The flag stays true for the rest of the form's lifetime; subsequent
  // edits clear individual errors as their values become valid.
  const [submitted, setSubmitted] = useState(false);

  const errors = useMemo<Partial<Record<keyof V, string | null>>>(() => {
    const out: Partial<Record<keyof V, string | null>> = {};
    for (const name of Object.keys(schema) as (keyof V)[]) {
      const cfg = schema[name];
      if (!cfg) continue;
      if (!touched[name] && !submitted) { out[name] = null; continue; }
      if (cfg.suppressLive?.(values) && !submitted) { out[name] = null; continue; }
      out[name] = cfg.validate(values);
    }
    return out;
    // schema is expected to be stable across renders (defined inside useMemo
    // at the call site). We don't include it as a dep on purpose — including
    // it would force consumers to memoise or accept a re-validation every
    // render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, touched, submitted]);

  const handleBlur = useCallback((name: keyof V) => {
    setTouched(prev => (prev[name] ? prev : { ...prev, [name]: true }));
  }, []);

  const markTouched = handleBlur;

  const validateAll = useCallback((): ValidateAllResult<V> => {
    const fieldOrder = Object.keys(schema) as (keyof V)[];
    let firstInvalid: keyof V | null = null;
    for (const name of fieldOrder) {
      const cfg = schema[name];
      if (!cfg) continue;
      const err = cfg.validate(values);
      if (err && firstInvalid === null) firstInvalid = name;
    }
    setTouched(() => {
      const next: Partial<Record<keyof V, boolean>> = {};
      for (const name of fieldOrder) next[name] = true;
      return next;
    });
    setSubmitted(true);
    return { ok: firstInvalid === null, firstInvalid };
    // schema intentionally omitted — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const resetTouched = useCallback(() => {
    setTouched({});
    setSubmitted(false);
  }, []);

  return { errors, touched, handleBlur, markTouched, validateAll, resetTouched };
}

// ─── DOM helper: focus + smooth-scroll to the first invalid field ────────────
//
// Pulled out as a free function so headless tests (Node) can import the hook
// without touching `document`. Callers wrap it in requestAnimationFrame so it
// runs after React paints the error states.

export function focusAndScrollTo(id: string): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
}

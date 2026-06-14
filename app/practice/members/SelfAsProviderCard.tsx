'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { becomeProvider } from './actions';
import {
  useFieldValidation,
  focusAndScrollTo,
  type FieldsSchema,
} from '@/lib/forms/useFieldValidation';
import { validateSaId } from '@/lib/validation';

// ─── SelfAsProviderCard ──────────────────────────────────────────────────────
//
// Renders only when the current viewer is the admin AND their own
// practice_members row still has role='admin' (i.e. they haven't already
// self-elected). The collapsed banner explains why this matters
// (trading gate: ≥ 1 provider required). Tapping the CTA expands an
// inline form for the three required clinical fields.
//
// Validation uses the shared useFieldValidation hook with the same
// timing rules as the signup forms:
//   • Nothing shows before a field is touched.
//   • On submit, the first invalid field is focused and scrolled to.
//   • SA ID surfaces only one generic message regardless of which
//     internal check (length / format / date / citizenship / checksum)
//     failed — mirrors the patient signup pattern.

const SPECIALTIES = [
  'General Practice', 'Dentistry', 'Physiotherapy', 'Optometry',
  'Specialist Medicine', 'Psychology', 'Nursing', 'Pharmacy', 'Other',
];

const INPUT_BASE = 'w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition-all focus:ring-2';
const INPUT_OK   = 'border-gray-300 focus:border-[#15A89E] focus:ring-[#15A89E]/20';
const INPUT_ERR  = 'border-red-400 focus:border-red-500 focus:ring-red-200';
const LABEL_CLS  = 'block text-sm font-medium text-gray-700 mb-1';

function inputClass(hasError: boolean) {
  return `${INPUT_BASE} ${hasError ? INPUT_ERR : INPUT_OK}`;
}

const BLANK = {
  specialty:   '',
  hpcsaNumber: '',
  saIdNumber:  '',
};

type Fields = typeof BLANK;

const SA_ID_GENERIC_ERROR = 'Please enter a valid SA ID number.';

export default function SelfAsProviderCard() {
  const router = useRouter();
  const [expanded,    setExpanded]    = useState(false);
  const [fields,      setFields]      = useState<Fields>(BLANK);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);

  const schema = useMemo<FieldsSchema<Fields>>(() => ({
    specialty: {
      validate: (v) => v.specialty ? null : 'Specialty is required.',
    },
    hpcsaNumber: {
      validate: (v) => v.hpcsaNumber.trim() ? null : 'HPCSA number is required.',
    },
    saIdNumber: {
      validate: (v) => {
        const r = validateSaId(v.saIdNumber);
        return r.valid ? null : SA_ID_GENERIC_ERROR;
      },
    },
  }), []);

  const { errors, handleBlur, validateAll } = useFieldValidation(fields, schema);

  function setText(key: keyof Fields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields(f => ({ ...f, [key]: e.target.value }));
  }
  const onBlur = (key: keyof Fields) => () => handleBlur(key);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const { ok, firstInvalid } = validateAll();
    if (!ok) {
      setSubmitError('Please complete the required fields highlighted below.');
      if (firstInvalid) {
        const id = `self-provider-${String(firstInvalid)}`;
        requestAnimationFrame(() => focusAndScrollTo(id));
      }
      return;
    }
    setLoading(true);
    const result = await becomeProvider({
      specialty:   fields.specialty,
      hpcsaNumber: fields.hpcsaNumber,
      saIdNumber:  fields.saIdNumber,
    });
    setLoading(false);
    if (result.error) {
      setSubmitError(result.error);
      return;
    }
    // Soft-refresh the server-rendered MembersView so the admin's row now
    // shows role='provider' and the trading gate sees the new provider.
    router.refresh();
  }

  if (!expanded) {
    return (
      <div
        data-testid="self-as-provider-card-collapsed"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start justify-between gap-4"
      >
        <div>
          <p className="text-sm font-semibold text-amber-900">
            Are you also the clinician?
          </p>
          <p className="mt-1 text-sm text-amber-800">
            Solo practitioners — add yourself as a provider so this practice can start billing.
            You stay the admin too.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="self-as-provider-open"
          className="shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          Add myself
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Add yourself as a provider</h2>
          <p className="mt-1 text-xs text-gray-500">
            These details are required for clinicians. You keep all your admin capabilities.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setExpanded(false); setSubmitError(null); }}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className={LABEL_CLS} htmlFor="self-provider-specialty">
            Specialty<span aria-hidden className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="self-provider-specialty"
            className={inputClass(!!errors.specialty)}
            value={fields.specialty}
            onChange={setText('specialty')}
            onBlur={onBlur('specialty')}
            aria-invalid={!!errors.specialty}
          >
            <option value="">Select specialty…</option>
            {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {errors.specialty && <p className="mt-1 text-xs text-red-600">{errors.specialty}</p>}
        </div>

        <div>
          <label className={LABEL_CLS} htmlFor="self-provider-hpcsaNumber">
            HPCSA number<span aria-hidden className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="self-provider-hpcsaNumber"
            type="text"
            className={inputClass(!!errors.hpcsaNumber)}
            value={fields.hpcsaNumber}
            onChange={setText('hpcsaNumber')}
            onBlur={onBlur('hpcsaNumber')}
            aria-invalid={!!errors.hpcsaNumber}
            placeholder="MP0123456"
          />
          {errors.hpcsaNumber && <p className="mt-1 text-xs text-red-600">{errors.hpcsaNumber}</p>}
        </div>

        <div>
          <label className={LABEL_CLS} htmlFor="self-provider-saIdNumber">
            SA ID number<span aria-hidden className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="self-provider-saIdNumber"
            type="text"
            inputMode="numeric"
            maxLength={13}
            className={inputClass(!!errors.saIdNumber)}
            value={fields.saIdNumber}
            onChange={setText('saIdNumber')}
            onBlur={onBlur('saIdNumber')}
            aria-invalid={!!errors.saIdNumber}
            placeholder="13-digit ID number"
          />
          {errors.saIdNumber && <p className="mt-1 text-xs text-red-600">{errors.saIdNumber}</p>}
        </div>

        {submitError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {submitError}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => { setExpanded(false); setSubmitError(null); }}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-200 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {loading ? 'Saving…' : 'Add myself as provider'}
          </button>
        </div>
      </form>
    </div>
  );
}

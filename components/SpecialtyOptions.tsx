import { SPECIALTIES, SPECIALTY_LETTER_GROUPS } from '@/lib/specialties';

// ─── <option> set for every specialty dropdown in the app ──────────────
//
// Renders the shared vocabulary (lib/specialties.ts) as <optgroup>s
// keyed by initial letter — 60 flat options is a wall of text, and the
// letter headings are how the register is meant to be read.
//
// Two jobs beyond "map over the list":
//
//   • placeholder — the leading empty option, so callers don't each
//     hand-roll one with subtly different wording.
//
//   • current — a specialty already stored on the record. specialty is
//     free text in the DB (bulk imports, and the pre-2026-08
//     vocabulary), so a saved value may not be in the register. A
//     <select> silently drops a value it has no option for, which would
//     turn "just edit the phone number" into "and quietly relabel this
//     practitioner". When current is off-register we keep it as its own
//     group so it stays selected and visible until someone changes it
//     deliberately.
//
// No hooks, no state — usable from server and client components alike.

export default function SpecialtyOptions({
  placeholder,
  current,
}: {
  /** Label for the leading empty option. Omit for no placeholder. */
  placeholder?: string;
  /** Specialty currently stored on the record, if any. */
  current?: string | null;
}) {
  const offRegister =
    !!current && !(SPECIALTIES as readonly string[]).includes(current);

  return (
    <>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {offRegister && (
        <optgroup label="Currently recorded">
          <option value={current!}>{current}</option>
        </optgroup>
      )}
      {SPECIALTY_LETTER_GROUPS.map(({ letter, specialties }) => (
        <optgroup key={letter} label={letter}>
          {specialties.map(s => <option key={s} value={s}>{s}</option>)}
        </optgroup>
      ))}
    </>
  );
}

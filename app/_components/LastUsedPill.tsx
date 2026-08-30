// ─── "Last used" flag — shared between /login's three sign-in options ────
//
// Same small teal pill above whichever of passkey / Google / password
// succeeded last on this browser (see lib/auth/lastSignInMethod.ts). Lives
// here, not inlined in each spot, because it's rendered from both
// ContinueWithGoogleButton.tsx and app/(auth)/login/page.tsx — two call
// sites is exactly the point where a shared component earns its keep
// rather than staying duplicated.
//
// `tone` picks the teal: the deep #0C8579 has the contrast to sit on a
// white card and none at all on the navy auth surface, where the brand's
// own --teal-bright (#19C2B6, 6.52:1 on --navy) is the readable one.
// Same pill, same meaning — only the ground under it changes.

type Props = { tone?: 'onLight' | 'onDark' };

export default function LastUsedPill({ tone = 'onLight' }: Props) {
  const colour = tone === 'onDark' ? '#19C2B6' : '#0C8579';
  return (
    <p
      className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase"
      style={{ color: colour, letterSpacing: '.04em' }}
    >
      <svg viewBox="0 0 20 20" width="9" height="9" fill="none" stroke={colour} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 10l4 4 8-8" />
      </svg>
      Last used
    </p>
  );
}

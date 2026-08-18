/**
 * The one empty state for the patient account surface: an icon, a short
 * title, and a plain sentence saying what to do about it.
 *
 * ─── WHY A COMPONENT AND NOT THREE HAND-ROLLED BLOCKS ─────────────────
 *
 * Before this, each empty state on the account page was written where it
 * was needed: cards got a dashed box with two lines, passkeys got one bare
 * sentence, and an unset field got an em-dash. None was wrong on its own;
 * together they read as three different apps, and the em-dash in particular
 * says nothing at all to someone who has never set the field.
 *
 * An icon does real work here beyond decoration — it is what makes an empty
 * region legible as "deliberately empty" rather than "still loading" or
 * "broken". That distinction is exactly the one the loading skeletons draw
 * on arrival, so the two need to look like they belong together.
 *
 * Presentational only: a plain server component, no state, no data access.
 */

/** The icons an account empty state can use. Named for what they MEAN. */
export type EmptyStateIcon = 'card' | 'key' | 'record' | 'bell' | 'field';

const ICON_PATHS: Record<EmptyStateIcon, React.ReactNode> = {
  // A card outline — saved payment methods.
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
    </>
  ),
  // A key — passkeys.
  key: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12h9M17 12v3" />
    </>
  ),
  // A rising bar pair — the payment record.
  record: (
    <>
      <path d="M4 19V11M10 19V7M16 19v-5M22 19H2" />
    </>
  ),
  // A bell — notifications.
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" />
      <path d="M10 18a2 2 0 0 0 4 0" />
    </>
  ),
  // A dashed-looking underline — a field with nothing in it yet.
  field: (
    <>
      <path d="M4 16h16M4 8h7" />
    </>
  ),
};

export default function EmptyState({
  icon,
  title,
  children,
  /** Compact form for inside a field row rather than a whole section. */
  inline = false,
}: {
  icon: EmptyStateIcon;
  /** Short — what is absent, not an instruction. */
  title: string;
  /** One plain sentence: what to do, or what will appear here. */
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <div
      className={
        inline
          ? 'flex items-start gap-2.5'
          : 'flex flex-col items-center gap-2 rounded-2xl border border-dashed px-5 py-8 text-center'
      }
      style={inline ? undefined : { borderColor: 'rgba(19,41,75,.14)' }}
      data-testid="empty-state"
    >
      <span
        className={`flex-none flex items-center justify-center rounded-full ${inline ? 'w-6 h-6' : 'w-11 h-11'}`}
        style={{ background: 'rgba(19,41,75,.05)', color: '#8496AA' }}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          width={inline ? 13 : 20}
          height={inline ? 13 : 20}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICON_PATHS[icon]}
        </svg>
      </span>
      <div className={inline ? 'min-w-0' : 'contents'}>
        <p
          className={`font-semibold ${inline ? 'text-[13.5px]' : 'text-[14.5px]'}`}
          style={{ color: '#13294B' }}
        >
          {title}
        </p>
        <p
          className={`leading-[1.5] ${inline ? 'text-[12px] mt-0.5' : 'text-[12.5px]'}`}
          style={{ color: '#8496AA' }}
        >
          {children}
        </p>
      </div>
    </div>
  );
}

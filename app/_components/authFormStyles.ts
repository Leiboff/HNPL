// ─── The control vocabulary of the auth surface ────────────────────────
//
// AuthSurface (app/_components/AuthSurface.tsx) gives the navy ground and
// the .auth-surface token block in app/globals.css gives the palette. This
// file is the third piece: the CONTROLS that sit on it — one field, one
// primary button, one secondary button, one of each banner — so every
// screen in the account journey is assembled from the same parts rather
// than from six sets of nearly-identical Tailwind strings.
//
// It was extracted when the /onboarding steps moved onto the same surface
// as /login and /signup. Before that, onboarding had its own light-ground
// vocabulary (56px fields, 14px radius, 2xl buttons, red-50 error cards)
// and the auth screens had another (52px fields, 2xl radius, pill
// buttons, red-500/10 error cards), and a patient walked from one into
// the other mid-signup. The values below are the AUTH set — nothing here
// is a new design, it is the /login email screen's own markup with a name.
//
// Everything is expressed in the --auth-* custom properties, which are
// defined ONLY inside .auth-surface. A control from this file therefore
// has to be rendered inside <AuthSurface> — outside it the vars resolve
// to nothing and the control loses its fill and its focus ring. That is
// deliberate: it keeps "dark control" and "dark ground" from ever
// drifting apart, because one cannot be used without the other.

// ── Fields ────────────────────────────────────────────────────────────

export const AUTH_LABEL_CLS =
  'mb-[7px] block text-[13px] font-medium text-[var(--auth-muted)]';

const INPUT_BASE =
  'h-[52px] w-full rounded-2xl border-[1.5px] px-4 text-[15px] text-white outline-none ' +
  'transition-all placeholder:text-white/35 disabled:cursor-not-allowed disabled:opacity-60';

const INPUT_OK =
  'border-[var(--auth-edge)] bg-[var(--auth-fill-raised)] focus:border-[var(--auth-accent)] ' +
  'focus:bg-[var(--auth-fill-hover)] focus:ring-4 focus:ring-[var(--auth-accent-ring)]';

const INPUT_ERR =
  'border-red-400/70 bg-red-500/10 focus:border-red-400 focus:ring-4 focus:ring-red-400/20';

/** The resting field. Use authInputClass() where a field can go invalid. */
export const AUTH_INPUT_CLS = `${INPUT_BASE} ${INPUT_OK}`;

export function authInputClass(hasError = false): string {
  return `${INPUT_BASE} ${hasError ? INPUT_ERR : INPUT_OK}`;
}

// ── Buttons ───────────────────────────────────────────────────────────

/**
 * The primary action. One per screen — solid teal is the only fill on the
 * surface, which is what makes it read as the way forward. Pair with
 * authPrimaryStyle(), which carries the teal glow and drops it while the
 * button is disabled (a shadow under a 45%-opacity button reads as dirt).
 */
export const AUTH_PRIMARY_CLS =
  'flex h-[54px] w-full items-center justify-center rounded-full text-[16px] font-semibold ' +
  'text-[var(--auth-on-teal)] transition-transform active:scale-[.985] ' +
  'disabled:cursor-not-allowed disabled:opacity-45';

export function authPrimaryStyle(disabled = false): React.CSSProperties {
  return {
    background: 'var(--auth-teal)',
    boxShadow:  disabled ? 'none' : '0 14px 30px -12px rgba(21,168,158,.75)',
  };
}

/**
 * The secondary action — outlined, no fill of its own. Same shape and
 * height as the sign-in options on /login, because it is the same object:
 * a full-width choice that is not the primary one.
 */
export const AUTH_SECONDARY_CLS =
  'flex h-[52px] w-full items-center justify-center rounded-full border-[1.5px] ' +
  'border-[var(--auth-edge-strong)] bg-[var(--auth-fill)] text-[15px] font-medium text-white ' +
  'transition-colors hover:bg-[var(--auth-fill-hover)] disabled:cursor-not-allowed disabled:opacity-60';

/** A text-weight action (Resend, Change number). Not a control. */
export const AUTH_TEXT_ACTION_CLS =
  'font-semibold text-[var(--auth-accent)] underline-offset-[3px] hover:underline ' +
  'disabled:cursor-not-allowed disabled:no-underline disabled:text-[var(--auth-dim)]';

/** An inline link in body copy. */
export const AUTH_LINK_CLS =
  'font-semibold text-[var(--auth-accent)] underline-offset-[3px] hover:underline';

// ── Banners ───────────────────────────────────────────────────────────
//
// Four tones, one shape. All four are a hue at .10 alpha behind a .30
// edge with a light-tinted text — the treatment /login already uses for
// its error and not-confirmed banners, generalised so a success or a
// neutral notice cannot arrive in some other form.

const BANNER_BASE = 'rounded-2xl border px-4 py-3 text-[13px] leading-[1.55]';

export const AUTH_ERROR_CLS   = `${BANNER_BASE} border-red-400/30 bg-red-500/10 text-red-200`;
export const AUTH_WARNING_CLS = `${BANNER_BASE} border-amber-300/30 bg-amber-400/[.10] text-amber-100`;
export const AUTH_SUCCESS_CLS = `${BANNER_BASE} border-emerald-300/30 bg-emerald-400/[.10] text-emerald-100`;
export const AUTH_NOTICE_CLS  =
  `${BANNER_BASE} border-[var(--auth-accent-edge)] bg-[var(--auth-accent-tint)] text-[var(--auth-muted)]`;

// ── Type ──────────────────────────────────────────────────────────────

/** Screen title on a form step. Matches the /login email screen. */
export const AUTH_TITLE_CLS =
  'text-[28px] font-semibold leading-[1.2] tracking-[-0.03em] text-white';

/** The line under a title. */
export const AUTH_SUBTITLE_CLS = 'text-[15px] leading-[1.55] text-[var(--auth-muted)]';

/** Fine print — consent copy, field hints, expiry notes. */
export const AUTH_HELP_CLS = 'text-[12px] leading-[1.5] text-[var(--auth-dim)]';

# Passkey manual testing

Vitest covers the pure error-mapping helpers in
`lib/hooks/passkeyErrors.ts` (32 cases). The hook itself (`usePasskeys`) and
the WebAuthn ceremonies cannot be exercised in a headless Node test runner
without bringing in jsdom + @testing-library/react + a virtual WebAuthn
authenticator. This doc captures the manual happy-path + edge-case checks
to run before each release that touches passkey code.

## Prerequisites

1. Local Supabase is running with the new config:
   ```
   supabase start
   ```
   `supabase/config.toml` enables `[auth.passkey]` and configures
   `[auth.webauthn]` for `localhost`.

2. `.env.local` points the app at the local Supabase instance
   (`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` or similar).

3. Run the apply the migrations once if not already:
   ```
   supabase db reset
   ```
   so the new columns from `supabase/migrations/0037_passkey_prompt_dismissal.sql`
   exist on `profiles`.

4. Dev server running: `npm run dev`.

5. A confirmed, non-anonymous patient account to test with. Anonymous and
   SSO users can NOT register passkeys (Supabase restriction).

6. A device / browser with platform authenticator (Touch ID, Face ID,
   Windows Hello, or a security key). Chrome DevTools' WebAuthn pane (under
   "More tools → WebAuthn") lets you simulate a virtual authenticator if
   you don't have hardware handy.

## Tests

### 1. Smoke seam (do this FIRST after any supabase-js / @supabase/ssr upgrade)

Visit `/dev/passkey-smoke` (dev-only route; returns 404 in production).

- Sign in via the regular login page first so the server-rendered block at
  the top of the smoke page shows your user id.
- Click **register** → a WebAuthn ceremony should pop up. Approve it.
- Click **list** → log line should show 1 passkey.
- Click **signout** → server block at the top now reads `(no server-side session)`.
- Click **signin** → ceremony pops up again, picks your passkey.
- **Refresh the page**. Server block at the top should now show your user
  id again. ← This is the SSR proof. If it doesn't, the cookie storage
  adapter isn't persisting the passkey session and the rest of the build
  won't work. Stop and dig before continuing.

### 2a. Login page — Conditional UI (the headline experience)

Conditional UI surfaces the saved passkey as a browser autofill suggestion
on the email field. Tap the suggestion → Face ID / fingerprint → signed
in. One tap total, no button.

- On a browser that supports it (Safari 16+, Chrome 108+, Edge 108+) with
  a passkey already registered for the RP:
  - Visit `/login`. Click into the email field.
  - The browser surfaces a "Sign in with [passkey friendly name]"
    suggestion in the autofill dropdown.
  - Tap the suggestion → platform authenticator prompt → success →
    redirect to `/dashboard` → role-based redirect.
- Verify via DevTools: the email input has `autocomplete="username webauthn"`
  and Console shows no errors from `@simplewebauthn/browser`.
- Browsers WITHOUT conditional support (Firefox on most platforms today)
  still show the explicit "Sign in with a passkey" button — fall back to
  that path.
- Conditional UI cancellation (user dismisses the autofill suggestion):
  silent, no error banner, the explicit button still works.
- Navigate away from `/login` mid-ceremony: the conditional ceremony is
  cancelled by `WebAuthnAbortService.cancelCeremony()` in the hook's
  cleanup; no zombie WebAuthn prompt should linger.

### 2b. Login page button (modal fallback)

- Visit `/login` in a browser that supports WebAuthn → "Sign in with a
  passkey" button is visible above the email/password fields.
- Click it → ceremony pops up. On success → routes to `/dashboard` then
  role-based redirect (same as password login).
- Click it again, cancel the ceremony → silent return to login, no error
  banner.
- In a browser without WebAuthn (or with `PublicKeyCredential` deleted
  from `window`), the button does not render.
- Trigger `email_not_confirmed` (unconfirmed test user) → the existing
  "please confirm your email" banner appears (NOT a generic error).
- Click the modal button while the conditional ceremony is still pending
  on focus: the modal flow should succeed (the second `startAuthentication`
  call aborts the conditional one via the library's internal
  `WebAuthnAbortService`).

### 3. Post-first-login prompt

- New patient, just confirmed email, never dismissed:
  log in → land on `/patient` → "Use Face ID or your fingerprint next time"
  card appears between greeting and hero.
- Click **Add a passkey** → ceremony pops → success → card disappears.
- Re-load the page → card does NOT come back (the hook sees an existing
  passkey).

- New patient with no passkey, clicks **Not now**:
  - Card disappears immediately.
  - DB: `passkey_prompt_dismissed_count` is now 1, `passkey_prompt_dismissed_at`
    is now-ish.
  - Re-load → card stays hidden.

- Same patient 31 days later (simulate by manually updating
  `passkey_prompt_dismissed_at` to 31 days ago):
  - Re-load → card reappears.
  - Click **Not now** again → count becomes 2.
  - Re-load → card stays hidden forever (count is capped at 2).

- Patient clicks **Add a passkey** but cancels the ceremony:
  - Card disappears (cancel counts as a dismissal per spec).
  - DB: count is incremented (same as Not now).

### 4. Profile passkeys section

- `/patient/profile` shows a "Passkeys" card.
- With 0 passkeys: shows the explanatory copy + "Add a passkey" button.
- After registering one: it appears in the list with the auto-assigned
  friendly name + created date.
- Click the name → inline rename input. Press Enter to save, Escape to
  cancel.
- Save a name longer than 120 chars → input is hard-capped at 120 by the
  `maxLength` attribute.
- Click **Delete** on a non-last passkey → confirm dialog: "you won't be
  able to sign in with this device anymore" → confirm → row disappears.
- Click **Delete** on the LAST passkey → confirm dialog mentions "you'll
  sign in with your email and password again" → after delete, a green
  notice appears confirming the same.

### 5. Error paths (force these via the smoke page or DevTools)

- **`webauthn_credential_exists`**: try to register the same authenticator
  twice. The "this device already has a passkey registered" message should
  appear in the settings section. Hook's `error` field carries
  `webauthn_credential_exists`.
- **`webauthn_challenge_expired`**: start a register ceremony, leave the
  WebAuthn dialog open longer than the Supabase challenge TTL (~5 min).
  Approve. Error message "passkey prompt timed out" should show.
- **`too_many_passkeys`**: register passkeys until the Supabase cap is
  hit. Settings section shows "you've reached the maximum number of
  passkeys" and the Add button continues to be clickable (so the user can
  delete one first).
- **`passkey_disabled`** (production-only): if a project hasn't enabled
  passkeys via the dashboard, every register/signin call surfaces this.
  Login page falls back to email/password unaffected.

## Browser support matrix

Spot-check these once per major Supabase passkey API change. WebAuthn is
broadly supported now, but iOS Safari + Chrome on Windows have the most
common idiosyncrasies.

- Safari 16+ on iOS / macOS (Touch ID / Face ID)
- Chrome 108+ on macOS (Touch ID) + Windows (Hello)
- Edge 108+ on Windows
- Firefox 122+ on macOS + Windows (uses platform authenticator on macOS)

Older browsers without `window.PublicKeyCredential` should never see the
passkey button or prompt — they get the unchanged email/password flow.

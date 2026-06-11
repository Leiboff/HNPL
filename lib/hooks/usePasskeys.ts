'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { mapPasskeyError, type PasskeyError } from './passkeyErrors';

// Re-export so existing callers can keep importing from this module.
export { mapPasskeyError, passkeyErrorMessage } from './passkeyErrors';
export type { PasskeyError } from './passkeyErrors';

export type Passkey = {
  id:             string;
  friendly_name:  string;
  created_at:     string;
  last_used_at?:  string;
};

/**
 * Hook for the patient-facing passkey surfaces. Wraps Supabase's experimental
 * passkey API (registerPasskey, passkey.list/update/delete) with loading +
 * normalised error state, and a `supported` flag for feature detection.
 *
 * sign-in (signInWithPasskey) is NOT exposed here — that lives on the login
 * page itself, before any session exists, and doesn't share lifecycle with
 * the list/manage surfaces.
 */
export function usePasskeys() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<PasskeyError | null>(null);

  const supported =
    typeof window !== 'undefined' && 'PublicKeyCredential' in window;

  const refresh = useCallback(async () => {
    if (!supported) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: listErr } = await supabase.auth.passkey.list();
      if (listErr) { setError(mapPasskeyError(listErr)); setPasskeys([]); return; }
      setPasskeys((data ?? []) as Passkey[]);
    } catch (err) {
      setError(mapPasskeyError(err));
      setPasskeys([]);
    } finally {
      setLoading(false);
    }
  }, [supported]);

  useEffect(() => { refresh(); }, [refresh]);

  const register = useCallback(async (): Promise<{ ok: boolean; error: PasskeyError | null }> => {
    if (!supported) return { ok: false, error: 'unsupported' };
    setError(null);
    try {
      const supabase = createClient();
const { error: regErr } = await supabase.auth.registerPasskey();
      if (regErr) { const code = mapPasskeyError(regErr); setError(code); return { ok: false, error: code }; }
      await refresh();
      return { ok: true, error: null };
    } catch (err) {
      const code = mapPasskeyError(err);
      // user_cancelled is a normal outcome; surface but don't treat as a real error in UI
      setError(code === 'user_cancelled' ? null : code);
      return { ok: false, error: code };
    }
  }, [supported, refresh]);

  const rename = useCallback(async (passkeyId: string, friendlyName: string): Promise<{ ok: boolean; error: PasskeyError | null }> => {
    if (!supported) return { ok: false, error: 'unsupported' };
    setError(null);
    try {
      const supabase = createClient();
const { error: renErr } = await supabase.auth.passkey.update({ passkeyId, friendlyName });
      if (renErr) { const code = mapPasskeyError(renErr); setError(code); return { ok: false, error: code }; }
      await refresh();
      return { ok: true, error: null };
    } catch (err) {
      const code = mapPasskeyError(err);
      setError(code);
      return { ok: false, error: code };
    }
  }, [supported, refresh]);

  const remove = useCallback(async (passkeyId: string): Promise<{ ok: boolean; error: PasskeyError | null }> => {
    if (!supported) return { ok: false, error: 'unsupported' };
    setError(null);
    try {
      const supabase = createClient();
const { error: delErr } = await supabase.auth.passkey.delete({ passkeyId });
      if (delErr) { const code = mapPasskeyError(delErr); setError(code); return { ok: false, error: code }; }
      await refresh();
      return { ok: true, error: null };
    } catch (err) {
      const code = mapPasskeyError(err);
      setError(code);
      return { ok: false, error: code };
    }
  }, [supported, refresh]);

  return { passkeys, loading, error, supported, refresh, register, rename, remove };
}

import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js';

/** Closed analytics vocabulary. Additions require a migration/test review. */
export const ONBOARDING_EVENTS = {
  PHONE_VIEWED: 'phone_viewed', PHONE_SUBMIT_STARTED: 'phone_submit_started', PHONE_SAVED: 'phone_saved', PHONE_SUBMIT_FAILED: 'phone_submit_failed',
  OTP_SEND_STARTED: 'otp_send_started', OTP_SENT: 'otp_sent', OTP_SEND_FAILED: 'otp_send_failed', OTP_VERIFY_STARTED: 'otp_verify_started', OTP_VERIFIED: 'otp_verified', OTP_VERIFY_FAILED: 'otp_verify_failed',
  SALARY_VIEWED: 'salary_viewed', SALARY_SUBMIT_STARTED: 'salary_submit_started', SALARY_SAVED: 'salary_saved', SALARY_SUBMIT_FAILED: 'salary_submit_failed',
  IDENTITY_VIEWED: 'identity_viewed', IDENTITY_SUBMIT_STARTED: 'identity_submit_started', IDENTITY_PROVIDER_STARTED: 'identity_provider_started', IDENTITY_PROVIDER_FAILED: 'identity_provider_failed', IDENTITY_APPROVED: 'identity_approved', IDENTITY_DECLINED: 'identity_declined',
  CREDIT_CHECK_VIEWED: 'credit_check_viewed', CREDIT_CHECK_STARTED: 'credit_check_started', CREDIT_CHECK_COMPLETED: 'credit_check_completed', CREDIT_CHECK_FAILED: 'credit_check_failed',
  ONBOARDING_COMPLETED: 'onboarding_completed',
} as const;

export type OnboardingEvent = typeof ONBOARDING_EVENTS[keyof typeof ONBOARDING_EVENTS];
export type OnboardingStep = 'phone' | 'salary' | 'identity' | 'credit_check' | 'completion';

const STEP_BY_EVENT: Record<OnboardingEvent, OnboardingStep> = Object.fromEntries(
  Object.values(ONBOARDING_EVENTS).map((event) => [event, event.startsWith('otp_') || event.startsWith('phone_') ? 'phone' : event.startsWith('salary_') ? 'salary' : event.startsWith('identity_') ? 'identity' : event.startsWith('credit_check_') ? 'credit_check' : 'completion']),
) as Record<OnboardingEvent, OnboardingStep>;

export const ONBOARDING_ERROR_CODES = new Set([
  'invalid_phone', 'network_error', 'sms_failed', 'sms_not_configured', 'rate_limited', 'wrong_code', 'expired', 'invalid_code', 'phone_taken',
  'invalid_salary', 'save_failed', 'invalid_identity', 'underage', 'consent_required', 'provider_unavailable', 'provider_declined', 'risk_refused', 'unknown_error',
]);

export function sanitiseOnboardingError(code: string | null | undefined): string | null {
  if (!code) return null;
  if (ONBOARDING_ERROR_CODES.has(code)) return code;
  if (code === 'too_soon' || code.includes('limit')) return 'rate_limited';
  if (code === 'invalid_code_format') return 'invalid_code';
  return 'unknown_error';
}

function serviceClient() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

/** Best-effort telemetry: tracking must never alter onboarding business flow. */
export async function recordOnboardingEvent(userId: string, event: OnboardingEvent, options: {
  outcome?: 'success' | 'failure' | 'started' | null;
  errorCode?: string | null;
  metadata?: { provider?: 'didit' | 'dha' | 'experian'; source?: 'server_page' | 'server_action' | 'webhook' | 'client_recovery' };
  dedupeKey?: string;
  client?: SupabaseClient;
} = {}): Promise<void> {
  try {
    const row = { user_id: userId, step: STEP_BY_EVENT[event], event_type: event, outcome: options.outcome ?? null, error_code: sanitiseOnboardingError(options.errorCode), metadata: options.metadata ?? {}, dedupe_key: options.dedupeKey ?? null };
    const query = (options.client ?? serviceClient()).from('onboarding_events');
    const { error } = options.dedupeKey ? await query.upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true }) : await query.insert(row);
    if (error) console.warn('[onboarding-events] insert failed', { event, code: error.code ?? 'unknown' });
  } catch {
    // Observability must never turn a successful onboarding mutation into a failure.
    console.warn('[onboarding-events] insert unavailable', { event });
  }
}

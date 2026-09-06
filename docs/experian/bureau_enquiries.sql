-- RENUMBER THIS FILE BEFORE COMMITTING. 0099 was a placeholder; the last known
-- migration is 0102_didit_identity_verification.sql. See Step 0 of the brief.
-- Bureau enquiry log: audit trail, POPIA §71 adverse-action record, and the billing/cache guard.
-- Renumber to whatever is next in your sequence.

create table if not exists public.bureau_enquiries (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid references public.profiles(id) on delete set null,

  -- Blind index over the SA ID, from the EXISTING helper. The plaintext ID is never
  -- written here; the encrypted copy already lives on profiles.
  id_number_hash     text not null,

  provider           text not null default 'experian',
  product            text not null default 'person_get_score',
  p_version          text not null,

  requested_at       timestamptz not null default now(),
  completed_at       timestamptz,
  latency_ms         integer,

  outcome            text,        -- ok | thin_file | input_error | config_error | provider_error | transport_error
  error_code         text,
  billed             boolean not null default false,

  -- Restrict hard: this is credit information about a natural person.
  raw_payload        text,
  results            jsonb,

  decision           text,        -- approved | declined | referred | error
  scorecard          text,
  score              integer,     -- positive scores only; warning codes belong in reason_codes
  risk_band          smallint,
  risk_exposure_cents integer,
  reason_codes       text[] not null default '{}',
  decision_detail    text,

  constraint bureau_enquiries_score_non_negative check (score is null or score >= 0),
  constraint bureau_enquiries_band_range check (risk_band is null or risk_band between 1 and 5)
);

create index if not exists bureau_enquiries_hash_requested_idx
  on public.bureau_enquiries (id_number_hash, requested_at desc);

create index if not exists bureau_enquiries_profile_idx
  on public.bureau_enquiries (profile_id, requested_at desc);

-- Double-billing guard: at most one IN-FLIGHT enquiry per ID at a time. Two tabs, two
-- serverless invocations, one billable call. Close the attempt (set completed_at) to release.
create unique index if not exists bureau_enquiries_one_in_flight
  on public.bureau_enquiries (id_number_hash)
  where completed_at is null;

-- Deny by default. Nothing in this table is ever read by a patient or by practice staff;
-- the service role writes it and /admin reads a redacted view.
alter table public.bureau_enquiries enable row level security;
revoke all on public.bureau_enquiries from anon, authenticated;

comment on table public.bureau_enquiries is
  'Experian enquiry log. Credit information — service-role access only. Retention: review against '
  'POPIA §14 (no longer than necessary) and the NCA record-keeping period before go-live.';
comment on column public.bureau_enquiries.reason_codes is
  'Machine codes backing the automated decision, retained for POPIA §71 requests. '
  'Never rendered verbatim to a data subject — map to approved adverse-action wording.';

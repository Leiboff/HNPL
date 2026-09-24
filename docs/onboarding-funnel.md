# Onboarding funnel reporting

`onboarding_events` is an append-only, server-authored ledger. It deliberately contains no submitted values or raw provider/error payloads. Views can repeat after refresh; attempts are never deduplicated. Terminal Didit events use the provider `event_id` as a private deduplication key.

**Abandonment is inferred, never emitted by `beforeunload`.** In the example below the reporting window is 24 hours: a journey is likely abandoned when its latest step has a view/start, no later success milestone, and no activity during the window. Tune the window in reporting, without changing collection.

```sql
-- Supply either :user_id or :email (platform-admin/service-role query).
with target as (
  select id, email, created_at from profiles
  where id = :user_id::uuid or lower(email) = lower(:email)
  limit 1
), timeline as (
  select e.* from onboarding_events e join target t on t.id = e.user_id
), summary as (
  select (array_agg(step order by created_at desc))[1] current_inferred_step,
         (array_agg(event_type order by created_at desc) filter (where outcome = 'success'))[1] last_successful_milestone,
         (array_agg(error_code order by created_at desc) filter (where error_code is not null))[1] last_failure_code,
         max(created_at) last_activity,
         bool_or(event_type = 'onboarding_completed') completed
  from timeline
)
select t.id user_id, t.email, t.created_at account_created_at,
       coalesce(jsonb_agg(to_jsonb(e) - 'user_id' order by e.created_at) filter (where e.id is not null), '[]') ordered_timeline,
       s.current_inferred_step, s.last_successful_milestone, s.last_failure_code,
       (not coalesce(s.completed,false) and s.last_activity < now() - interval '24 hours') likely_abandoned
from target t left join timeline e on true cross join summary s
group by t.id,t.email,t.created_at,s.current_inferred_step,s.last_successful_milestone,s.last_failure_code,s.completed,s.last_activity;
```

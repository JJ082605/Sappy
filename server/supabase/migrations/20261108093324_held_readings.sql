-- Held readings: readings the persistence rule held back and the next reading did not confirm.
--
-- The NEWS2 alert worker (server/news2/alert_worker.py) only escalates once a tier has held for 2
-- consecutive readings, so a single reading that would raise a higher tier on its own is held back
-- ("suppressed") instead of alerting. The worker then waits for that patient's next reading: if it
-- reaches the same tier, the escalation was real and alerts as usual (nothing is written here); if
-- it is back below that tier - e.g. a loose SpO2 probe reading 78% once - the held-back reading is
-- written here, so the nurse dashboard can show it quietly. These rows are NOT alerts: nobody is
-- paged and there is nothing to acknowledge. recorded_at is the held-back reading's own time;
-- created_at is when the worker wrote the row (after the next reading).
--
-- Only 'check soon' and 'go now' readings are recorded. Watch-level blips (e.g. a systolic BP that
-- dips to 110 once) are not: they're clutter, and storing less is the privacy-first choice. The
-- held_tier check still allows 'watch', so that can change without a migration.
--
-- Privacy (CLAUDE.md): a row never holds anything beyond pseudonymous ids (Patient.id /
-- Encounter.id) and NEWS2 values (tier, score, and reasons generated from the vitals) - no names,
-- identifiers or free text. Only the alert worker writes here (secret key, bypasses RLS); signed-in
-- staff can read, and browsers can't change anything.

create table public.held_readings (
  id           bigint generated always as identity primary key,
  patient_id   text not null references public.patients (id) on delete cascade,
  encounter_id uuid not null references public.encounters (id) on delete cascade,
  created_at   timestamptz not null default now(),
  recorded_at  timestamptz not null,           -- the held-back reading's (simulated) time
  held_tier    text not null check (held_tier in ('watch', 'check soon', 'go now')),  -- tier it would have raised
  news2_score  smallint not null,              -- that reading's NEWS2 total
  reason       text not null                   -- NEWS2 reasons joined with "; ", same format as alerts.reason
);
create index held_readings_created_at on public.held_readings (created_at desc);

-- Row Level Security: signed-in staff can read; nobody can write from a browser.
alter table public.held_readings enable row level security;
create policy "staff read held readings" on public.held_readings for select to authenticated using (true);
-- Belt and braces on top of RLS (no write policies exist). TRUNCATE ignores RLS, so it goes too.
revoke insert, update, delete, truncate on public.held_readings from anon, authenticated;

-- Realtime: push new held readings to the apps (RLS still applies to subscribers).
alter publication supabase_realtime add table public.held_readings;

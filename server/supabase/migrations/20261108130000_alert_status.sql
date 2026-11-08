-- Alert status as it exists in the live project, recorded in the repo.
--
-- A teammate replaced alerts.acknowledged_at with `status` + `completed_at` directly in the hosted
-- database. This migration brings any database built from the repo to the same shape, and is safe
-- to run on the live one (every step is conditional):
--   status       'incomplete' = waiting for a nurse, 'completed' = a nurse handled it ("I'm on it")
--   completed_at when it was completed. Database time, stamped by the trigger below, so response
--                times don't depend on a browser's clock (they're compared with created_at).

alter table public.alerts add column if not exists status text not null default 'incomplete';
alter table public.alerts add column if not exists completed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_status_check') then
    alter table public.alerts add constraint alerts_status_check check (status in ('incomplete', 'completed'));
  end if;
  -- carry over acknowledgements from the old column, then drop it
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'alerts' and column_name = 'acknowledged_at') then
    execute 'update public.alerts set status = ''completed'', completed_at = acknowledged_at
             where acknowledged_at is not null';
    alter table public.alerts drop column acknowledged_at;
  end if;
end;
$$;

-- Browsers (signed-in staff) may change only these two columns ("I'm on it" / Undo).
revoke update on public.alerts from authenticated;
grant update (status, completed_at) on public.alerts to authenticated;

-- completed_at is always set by the database: now() when an alert becomes completed, kept as-is
-- while it stays completed (a browser can't rewrite it to forge response times), null when reopened.
create or replace function public.alerts_completed_server_time() returns trigger
language plpgsql as $$
begin
  if new.status = 'completed' then
    if old.status = 'completed' then
      new.completed_at := old.completed_at;
    else
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists alerts_completed_server_time on public.alerts;
create trigger alerts_completed_server_time
  before update of status, completed_at on public.alerts
  for each row execute function public.alerts_completed_server_time();

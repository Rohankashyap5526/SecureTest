-- SecureTest camera proctoring migration
-- Run once in Supabase SQL Editor before enabling the security-hardening branch.
create extension if not exists pgcrypto;

create table if not exists public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  test_id text not null,
  student_id uuid not null,
  roll_number text not null,
  candidate jsonb not null,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active','terminated','submitted','expired')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  violation_count integer not null default 0 check (violation_count between 0 and 1000),
  last_event_at timestamptz,
  camera_consent_at timestamptz not null default now(),
  snapshot_consent boolean not null default false,
  snapshot_consent_at timestamptz,
  saved_answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists exam_sessions_one_active_candidate
  on public.exam_sessions(test_id, student_id) where status = 'active';
create index if not exists exam_sessions_status_expiry_idx
  on public.exam_sessions(status, expires_at);
create index if not exists exam_sessions_roll_test_idx
  on public.exam_sessions(roll_number, test_id);

create table if not exists public.proctoring_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.exam_sessions(id) on delete cascade,
  event_type text not null,
  violation_number integer not null,
  details jsonb not null default '{}'::jsonb,
  snapshot_path text,
  created_at timestamptz not null default now(),
  snapshot_expires_at timestamptz
);
create index if not exists proctoring_events_session_created_idx
  on public.proctoring_events(session_id, created_at desc);

alter table public.exam_sessions enable row level security;
alter table public.proctoring_events enable row level security;
-- No anon/authenticated policies: all access is performed by the trusted Express
-- backend using the Supabase server secret. Never expose that secret in the browser.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proctoring-incidents', 'proctoring-incidents', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 1048576,
  allowed_mime_types = array['image/jpeg'];

create or replace function public.record_proctoring_violation(
  p_token_hash text,
  p_event_type text,
  p_details jsonb default '{}'::jsonb,
  p_snapshot_path text default null
)
returns table(accepted boolean, violation_count integer, terminated boolean, session_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.exam_sessions%rowtype;
  v_count integer;
  v_status text;
begin
  select * into v_session
    from public.exam_sessions
    where token_hash = p_token_hash
    for update;

  if not found then
    return query select false, 0, false, 'not_found'::text;
    return;
  end if;

  if v_session.status <> 'active' or v_session.expires_at <= now() then
    if v_session.status = 'active' then
      update public.exam_sessions set status = 'expired' where id = v_session.id;
    end if;
    return query select false, v_session.violation_count, false,
      case when v_session.expires_at <= now() then 'expired' else v_session.status end;
    return;
  end if;

  -- Server-side debounce: ignore repeated events inside the cooldown window.
  if v_session.last_event_at is not null
     and v_session.last_event_at > now() - interval '8 seconds' then
    return query select false, v_session.violation_count, false, v_session.status;
    return;
  end if;

  v_count := v_session.violation_count + 1;
  v_status := case when v_count >= 3 then 'terminated' else 'active' end;

  update public.exam_sessions
    set violation_count = v_count,
        last_event_at = now(),
        status = v_status
    where id = v_session.id;

  insert into public.proctoring_events(
    session_id, event_type, violation_number, details, snapshot_path, snapshot_expires_at
  ) values (
    v_session.id, p_event_type, v_count,
    coalesce(p_details, '{}'::jsonb), p_snapshot_path,
    case when p_snapshot_path is null then null else now() + interval '30 days' end
  );

  return query select true, v_count, (v_count >= 3), v_status;
end;
$$;

revoke all on function public.record_proctoring_violation(text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.record_proctoring_violation(text,text,jsonb,text) to service_role;

comment on table public.proctoring_events is
  'Metadata and optional consent-based incident-only JPEG snapshots. Snapshot retention target: 30 days; configure deletion/retention operations before live exams.';

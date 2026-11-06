-- SecureTest: proctoring v2 + readiness for ~150 simultaneous candidates.
-- Run AFTER 20261104_camera_proctoring.sql. Safe to run more than once.

alter table public.exam_sessions
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists client_state jsonb not null default '{}'::jsonb,
  add column if not exists reissue_allowed boolean not null default false;

alter table public.proctoring_events
  add column if not exists counted boolean not null default true;

-- Sweeper / live monitor lookups
create index if not exists exam_sessions_status_started_idx
  on public.exam_sessions(status, started_at desc);
create index if not exists proctoring_events_type_idx
  on public.proctoring_events(session_id, event_type, created_at desc);

-- The old 4-argument version must go, otherwise RPC calls become ambiguous.
drop function if exists public.record_proctoring_violation(text, text, jsonb, text);

create or replace function public.record_proctoring_violation(
  p_token_hash text,
  p_event_type text,
  p_details jsonb default '{}'::jsonb,
  p_snapshot_path text default null,
  p_counts boolean default true,
  p_max integer default 3
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
  select * into v_session from public.exam_sessions
    where token_hash = p_token_hash for update;

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

  if p_counts then
    -- One physical action (e.g. Alt-Tab) fires tab_hidden + blur + fullscreen
    -- exit together. Collapse them into a single strike.
    if v_session.last_event_at is not null
       and v_session.last_event_at > now() - interval '5 seconds' then
      return query select false, v_session.violation_count, false, v_session.status;
      return;
    end if;

    v_count := v_session.violation_count + 1;
    v_status := case when v_count >= p_max then 'terminated' else 'active' end;

    update public.exam_sessions
      set violation_count = v_count, last_event_at = now(), status = v_status
      where id = v_session.id;

    insert into public.proctoring_events(
      session_id, event_type, violation_number, details, snapshot_path, snapshot_expires_at, counted)
    values (
      v_session.id, p_event_type, v_count, coalesce(p_details, '{}'::jsonb), p_snapshot_path,
      case when p_snapshot_path is null then null else now() + interval '30 days' end, true);

    return query select true, v_count, (v_count >= p_max), v_status;
  else
    -- Review-only signal: stored for the invigilator, never a strike.
    if exists (select 1 from public.proctoring_events
               where session_id = v_session.id and event_type = p_event_type
                 and created_at > now() - interval '10 seconds') then
      return query select false, v_session.violation_count, false, v_session.status;
      return;
    end if;

    insert into public.proctoring_events(
      session_id, event_type, violation_number, details, snapshot_path, snapshot_expires_at, counted)
    values (
      v_session.id, p_event_type, v_session.violation_count, coalesce(p_details, '{}'::jsonb),
      p_snapshot_path,
      case when p_snapshot_path is null then null else now() + interval '30 days' end, false);

    return query select true, v_session.violation_count, false, v_session.status;
  end if;
end;
$$;

revoke all on function public.record_proctoring_violation(text,text,jsonb,text,boolean,integer) from public, anon, authenticated;
grant execute on function public.record_proctoring_violation(text,text,jsonb,text,boolean,integer) to service_role;

-- SecureTest: require one unique mobile number per registered candidate.
-- First inspect duplicates with the query in docs/MOBILE_NUMBER_UNIQUENESS.md.
-- This migration intentionally fails rather than changing or deleting existing candidate data.

do $$
begin
  if exists (
    select 1
    from public.students
    group by mobile_number
    having count(*) > 1
  ) then
    raise exception 'Duplicate mobile_number values exist in public.students. Resolve them before applying this migration.';
  end if;
end $$;

create unique index if not exists students_mobile_number_unique
  on public.students (mobile_number);

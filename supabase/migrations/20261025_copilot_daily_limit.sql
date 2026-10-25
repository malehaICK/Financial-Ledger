

create table if not exists public.copilot_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  count   integer not null default 0,
  primary key (user_id, day)
);

-- No policies: only use_copilot_quota below can read or write this table.
alter table public.copilot_usage enable row level security;

create or replace function public.use_copilot_quota(p_limit integer)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    return false;
  end if;
  insert into public.copilot_usage (user_id, day, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set count = public.copilot_usage.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

revoke all on function public.use_copilot_quota(integer) from public, anon;
grant execute on function public.use_copilot_quota(integer) to authenticated;

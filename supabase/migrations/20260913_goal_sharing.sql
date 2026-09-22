

create table if not exists public.goal_members (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references public.savings_goals(id) on delete cascade,
  email      text not null check (email = lower(email)),
  user_id    uuid references auth.users(id) on delete cascade,
  added_by   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (goal_id, email)
);
create index if not exists goal_members_goal_idx  on public.goal_members(goal_id);
create index if not exists goal_members_email_idx on public.goal_members(email);

create table if not exists public.goal_invites (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references public.savings_goals(id) on delete cascade,
  token      text not null unique
             default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists goal_invites_goal_idx on public.goal_invites(goal_id);

-- Ownership / membership checks run as SECURITY DEFINER so policies never query
-- each other's tables directly (the cause of the old recursion error).
create or replace function public.is_goal_owner(p_goal uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.savings_goals g where g.id = p_goal and g.user_id = auth.uid());
$$;

create or replace function public.is_goal_member(p_goal uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.goal_members m
    where m.goal_id = p_goal
      and (m.user_id = auth.uid() or m.email = lower(coalesce(auth.jwt() ->> 'email', '')))
  );
$$;


drop policy if exists savings_goals_select_own on public.savings_goals;
create policy savings_goals_select_own on public.savings_goals
  for select to authenticated using (auth.uid() = user_id or public.is_goal_member(id));

alter table public.goal_members enable row level security;
drop policy if exists goal_members_select on public.goal_members;
drop policy if exists goal_members_insert_owner on public.goal_members;
drop policy if exists goal_members_delete on public.goal_members;
create policy goal_members_select on public.goal_members
  for select to authenticated using (public.is_goal_owner(goal_id) or public.is_goal_member(goal_id));
create policy goal_members_insert_owner on public.goal_members
  for insert to authenticated with check (public.is_goal_owner(goal_id) and added_by = auth.uid());
create policy goal_members_delete on public.goal_members
  for delete to authenticated using (
    public.is_goal_owner(goal_id)
    or user_id = auth.uid()
    or email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

alter table public.goal_invites enable row level security;
drop policy if exists goal_invites_owner_select on public.goal_invites;
drop policy if exists goal_invites_owner_insert on public.goal_invites;
drop policy if exists goal_invites_owner_update on public.goal_invites;
create policy goal_invites_owner_select on public.goal_invites
  for select to authenticated using (public.is_goal_owner(goal_id));
create policy goal_invites_owner_insert on public.goal_invites
  for insert to authenticated with check (public.is_goal_owner(goal_id) and created_by = auth.uid());
create policy goal_invites_owner_update on public.goal_invites
  for update to authenticated using (public.is_goal_owner(goal_id)) with check (public.is_goal_owner(goal_id));


create or replace function public.join_goal(p_token text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_goal  uuid;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or v_email = '' then
    raise exception 'Sign in to join this goal.';
  end if;
  select i.goal_id into v_goal
    from public.goal_invites i
   where i.token = p_token and i.revoked_at is null;
  if v_goal is null then
    raise exception 'This invite link is invalid or has been turned off.';
  end if;
  if public.is_goal_owner(v_goal) then
    return v_goal;
  end if;
  insert into public.goal_members (goal_id, email, user_id, added_by)
  values (v_goal, v_email, auth.uid(), auth.uid())
  on conflict (goal_id, email) do update set user_id = excluded.user_id;
  return v_goal;
end;
$$;


create or replace function public.add_to_goal(p_goal uuid, p_amount numeric)
returns numeric language plpgsql security definer set search_path = ''
as $$
declare
  v_saved numeric;
begin
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'Enter an amount greater than zero.';
  end if;
  if not (public.is_goal_owner(p_goal) or public.is_goal_member(p_goal)) then
    raise exception 'You don''t have access to this goal.';
  end if;
  update public.savings_goals
     set saved_amount = saved_amount + round(p_amount, 2),
         status = case when saved_amount + round(p_amount, 2) >= target_amount then 'achieved' else status end
   where id = p_goal
  returning saved_amount into v_saved;
  return v_saved;
end;
$$;

revoke all on function public.is_goal_owner(uuid)        from public, anon;
revoke all on function public.is_goal_member(uuid)       from public, anon;
revoke all on function public.join_goal(text)            from public, anon;
revoke all on function public.add_to_goal(uuid, numeric) from public, anon;
grant execute on function public.is_goal_owner(uuid)        to authenticated;
grant execute on function public.is_goal_member(uuid)       to authenticated;
grant execute on function public.join_goal(text)            to authenticated;
grant execute on function public.add_to_goal(uuid, numeric) to authenticated;

grant select, insert, delete on public.goal_members to authenticated;
grant select, insert, update on public.goal_invites to authenticated;

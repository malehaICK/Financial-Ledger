-- Ledger: consolidated database migration for Phases 1 + 5
-- Run once in Supabase SQL Editor.

alter table public.transactions
  add column if not exists gross_amount numeric(12,2),
  add column if not exists user_share numeric(12,2),
  add column if not exists reimbursement_due numeric(12,2) default 0,
  add column if not exists shared_expense boolean default false;

update public.transactions
set gross_amount = coalesce(gross_amount, amount),
    user_share = coalesce(user_share, amount),
    reimbursement_due = coalesce(reimbursement_due, 0),
    shared_expense = coalesce(shared_expense, false)
where gross_amount is null or user_share is null;

create table if not exists public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric(12,2) not null check (target_amount > 0),
  saved_amount numeric(12,2) not null default 0 check (saved_amount >= 0),
  target_date date not null,
  status text not null default 'active' check (status in ('active','achieved','archived')),
  created_at timestamptz not null default now()
);

create index if not exists savings_goals_user_date_idx on public.savings_goals(user_id,target_date);

alter table public.savings_goals enable row level security;
drop policy if exists savings_goals_select_own on public.savings_goals;
drop policy if exists savings_goals_insert_own on public.savings_goals;
drop policy if exists savings_goals_update_own on public.savings_goals;
drop policy if exists savings_goals_delete_own on public.savings_goals;
create policy savings_goals_select_own on public.savings_goals for select to authenticated using (auth.uid() = user_id);
create policy savings_goals_insert_own on public.savings_goals for insert to authenticated with check (auth.uid() = user_id);
create policy savings_goals_update_own on public.savings_goals for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy savings_goals_delete_own on public.savings_goals for delete to authenticated using (auth.uid() = user_id);

grant select,insert,update,delete on public.savings_goals to authenticated;
grant select,insert,update,delete on public.transactions to authenticated;

-- Phase 5: shared goals. Access is opt-in through shared_goal_members.
create table if not exists public.shared_goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric(12,2) not null check (target_amount > 0),
  total_saved numeric(12,2) not null default 0 check (total_saved >= 0),
  target_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.shared_goal_members (
  id uuid primary key default gen_random_uuid(),
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  member_email text not null,
  role text not null default 'member' check (role in ('member')),
  created_at timestamptz not null default now(),
  unique(shared_goal_id, member_email)
);

create index if not exists shared_goals_owner_idx on public.shared_goals(owner_id);
create index if not exists shared_goal_members_email_idx on public.shared_goal_members(lower(member_email));
create index if not exists shared_goal_members_goal_idx on public.shared_goal_members(shared_goal_id);

alter table public.shared_goals enable row level security;
alter table public.shared_goal_members enable row level security;

drop policy if exists shared_goals_select_access on public.shared_goals;
drop policy if exists shared_goals_insert_owner on public.shared_goals;
drop policy if exists shared_goals_update_owner on public.shared_goals;
drop policy if exists shared_goals_delete_owner on public.shared_goals;
create policy shared_goals_select_access on public.shared_goals for select to authenticated using (
  owner_id = auth.uid() or exists (
    select 1 from public.shared_goal_members m
    where m.shared_goal_id = shared_goals.id
      and lower(m.member_email) = lower(coalesce(auth.jwt()->>'email',''))
  )
);
create policy shared_goals_insert_owner on public.shared_goals for insert to authenticated with check (owner_id = auth.uid());
create policy shared_goals_update_owner on public.shared_goals for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy shared_goals_delete_owner on public.shared_goals for delete to authenticated using (owner_id = auth.uid());

drop policy if exists shared_goal_members_select_access on public.shared_goal_members;
drop policy if exists shared_goal_members_insert_owner on public.shared_goal_members;
drop policy if exists shared_goal_members_delete_owner on public.shared_goal_members;
create policy shared_goal_members_select_access on public.shared_goal_members for select to authenticated using (
  exists (select 1 from public.shared_goals g where g.id = shared_goal_id and (g.owner_id = auth.uid() or lower(member_email) = lower(coalesce(auth.jwt()->>'email',''))))
);
create policy shared_goal_members_insert_owner on public.shared_goal_members for insert to authenticated with check (
  exists (select 1 from public.shared_goals g where g.id = shared_goal_id and g.owner_id = auth.uid())
);
create policy shared_goal_members_delete_owner on public.shared_goal_members for delete to authenticated using (
  exists (select 1 from public.shared_goals g where g.id = shared_goal_id and g.owner_id = auth.uid())
);

grant select,insert,update,delete on public.shared_goals to authenticated;
grant select,insert,delete on public.shared_goal_members to authenticated;

-- Phase 5: individual shared-goal contributions.
create table if not exists public.shared_goal_contributions (
  id uuid primary key default gen_random_uuid(),
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index if not exists shared_goal_contributions_goal_idx on public.shared_goal_contributions(shared_goal_id);

alter table public.shared_goal_contributions enable row level security;
drop policy if exists shared_goal_contributions_select_access on public.shared_goal_contributions;
drop policy if exists shared_goal_contributions_insert_access on public.shared_goal_contributions;
create policy shared_goal_contributions_select_access on public.shared_goal_contributions for select to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from public.shared_goals g where g.id = shared_goal_id and (
      g.owner_id = auth.uid() or exists (
        select 1 from public.shared_goal_members m where m.shared_goal_id=g.id and lower(m.member_email)=lower(coalesce(auth.jwt()->>'email',''))
      )
    )
  )
);
create policy shared_goal_contributions_insert_access on public.shared_goal_contributions for insert to authenticated with check (
  user_id = auth.uid() and exists (
    select 1 from public.shared_goals g where g.id = shared_goal_id and (
      g.owner_id = auth.uid() or exists (
        select 1 from public.shared_goal_members m where m.shared_goal_id=g.id and lower(m.member_email)=lower(coalesce(auth.jwt()->>'email',''))
      )
    )
  )
);
grant select,insert on public.shared_goal_contributions to authenticated;

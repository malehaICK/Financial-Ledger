
-- ----------------------------------------------------------------------------
-- 1. Transactions — the core table. One row per income or expense entry.
-- ----------------------------------------------------------------------------
create table if not exists public.transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  transaction_date  date not null,
  transaction_type  text not null check (transaction_type in ('income','expense')),
  category          text,
  source            text,
  description       text,
  amount            numeric(12,2) not null check (amount >= 0),


  fingerprint       text,

 
  gross_amount      numeric(12,2),
  user_share        numeric(12,2),
  reimbursement_due numeric(12,2) not null default 0,
  shared_expense    boolean not null default false,

  created_at        timestamptz not null default now()
);


create index if not exists transactions_user_date_idx
  on public.transactions(user_id, transaction_date, created_at);


create unique index if not exists transactions_user_fingerprint_idx
  on public.transactions(user_id, fingerprint)
  where fingerprint is not null;

alter table public.transactions enable row level security;

drop policy if exists transactions_select_own on public.transactions;
drop policy if exists transactions_insert_own on public.transactions;
drop policy if exists transactions_update_own on public.transactions;
drop policy if exists transactions_delete_own on public.transactions;

create policy transactions_select_own on public.transactions
  for select to authenticated using (auth.uid() = user_id);
create policy transactions_insert_own on public.transactions
  for insert to authenticated with check (auth.uid() = user_id);
create policy transactions_update_own on public.transactions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy transactions_delete_own on public.transactions
  for delete to authenticated using (auth.uid() = user_id);


-- ----------------------------------------------------------------------------
-- 2. Backfill — only does anything on a database that predates the Phase 1
--    split-expense columns. A no-op on a fresh install.
-- ----------------------------------------------------------------------------
update public.transactions
set gross_amount      = coalesce(gross_amount, amount),
    user_share        = coalesce(user_share, amount),
    reimbursement_due = coalesce(reimbursement_due, 0),
    shared_expense    = coalesce(shared_expense, false)
where gross_amount is null or user_share is null;


-- ----------------------------------------------------------------------------
-- 3. Personal savings goals (Phase 1).
-- ----------------------------------------------------------------------------
create table if not exists public.savings_goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  target_amount numeric(12,2) not null check (target_amount > 0),
  saved_amount  numeric(12,2) not null default 0 check (saved_amount >= 0),
  target_date   date not null,
  status        text not null default 'active' check (status in ('active','achieved','archived')),
  created_at    timestamptz not null default now()
);

create index if not exists savings_goals_user_date_idx
  on public.savings_goals(user_id, target_date);

alter table public.savings_goals enable row level security;

drop policy if exists savings_goals_select_own on public.savings_goals;
drop policy if exists savings_goals_insert_own on public.savings_goals;
drop policy if exists savings_goals_update_own on public.savings_goals;
drop policy if exists savings_goals_delete_own on public.savings_goals;

create policy savings_goals_select_own on public.savings_goals
  for select to authenticated using (auth.uid() = user_id);
create policy savings_goals_insert_own on public.savings_goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy savings_goals_update_own on public.savings_goals
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy savings_goals_delete_own on public.savings_goals
  for delete to authenticated using (auth.uid() = user_id);


-- ----------------------------------------------------------------------------
-- 4. Shared goals (Phase 5). Access is opt-in via shared_goal_members.
-- ----------------------------------------------------------------------------
create table if not exists public.shared_goals (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  target_amount numeric(12,2) not null check (target_amount > 0),
  total_saved   numeric(12,2) not null default 0 check (total_saved >= 0),
  target_date   date not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.shared_goal_members (
  id             uuid primary key default gen_random_uuid(),
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  member_email   text not null,
  role           text not null default 'member' check (role in ('member')),
  created_at     timestamptz not null default now(),
  unique (shared_goal_id, member_email)
);

create index if not exists shared_goals_owner_idx
  on public.shared_goals(owner_id);
create index if not exists shared_goal_members_email_idx
  on public.shared_goal_members(lower(member_email));
create index if not exists shared_goal_members_goal_idx
  on public.shared_goal_members(shared_goal_id);

alter table public.shared_goals        enable row level security;
alter table public.shared_goal_members enable row level security;

drop policy if exists shared_goals_select_access on public.shared_goals;
drop policy if exists shared_goals_insert_owner  on public.shared_goals;
drop policy if exists shared_goals_update_owner  on public.shared_goals;
drop policy if exists shared_goals_delete_owner  on public.shared_goals;

create policy shared_goals_select_access on public.shared_goals
  for select to authenticated using (
    owner_id = auth.uid() or exists (
      select 1 from public.shared_goal_members m
      where m.shared_goal_id = shared_goals.id
        and lower(m.member_email) = lower(coalesce(auth.jwt()->>'email',''))
    )
  );
create policy shared_goals_insert_owner on public.shared_goals
  for insert to authenticated with check (owner_id = auth.uid());
create policy shared_goals_update_owner on public.shared_goals
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy shared_goals_delete_owner on public.shared_goals
  for delete to authenticated using (owner_id = auth.uid());

drop policy if exists shared_goal_members_select_access on public.shared_goal_members;
drop policy if exists shared_goal_members_insert_owner  on public.shared_goal_members;
drop policy if exists shared_goal_members_delete_owner  on public.shared_goal_members;

create policy shared_goal_members_select_access on public.shared_goal_members
  for select to authenticated using (
    exists (
      select 1 from public.shared_goals g
      where g.id = shared_goal_id
        and (g.owner_id = auth.uid()
             or lower(member_email) = lower(coalesce(auth.jwt()->>'email','')))
    )
  );
create policy shared_goal_members_insert_owner on public.shared_goal_members
  for insert to authenticated with check (
    exists (select 1 from public.shared_goals g where g.id = shared_goal_id and g.owner_id = auth.uid())
  );
create policy shared_goal_members_delete_owner on public.shared_goal_members
  for delete to authenticated using (
    exists (select 1 from public.shared_goals g where g.id = shared_goal_id and g.owner_id = auth.uid())
  );


-- ----------------------------------------------------------------------------
-- 5. Shared-goal contributions (Phase 5).
-- ----------------------------------------------------------------------------
create table if not exists public.shared_goal_contributions (
  id             uuid primary key default gen_random_uuid(),
  shared_goal_id uuid not null references public.shared_goals(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  amount         numeric(12,2) not null check (amount > 0),
  created_at     timestamptz not null default now()
);

create index if not exists shared_goal_contributions_goal_idx
  on public.shared_goal_contributions(shared_goal_id);

alter table public.shared_goal_contributions enable row level security;

drop policy if exists shared_goal_contributions_select_access on public.shared_goal_contributions;
drop policy if exists shared_goal_contributions_insert_access on public.shared_goal_contributions;

create policy shared_goal_contributions_select_access on public.shared_goal_contributions
  for select to authenticated using (
    user_id = auth.uid() or exists (
      select 1 from public.shared_goals g
      where g.id = shared_goal_id and (
        g.owner_id = auth.uid() or exists (
          select 1 from public.shared_goal_members m
          where m.shared_goal_id = g.id
            and lower(m.member_email) = lower(coalesce(auth.jwt()->>'email',''))
        )
      )
    )
  );
create policy shared_goal_contributions_insert_access on public.shared_goal_contributions
  for insert to authenticated with check (
    user_id = auth.uid() and exists (
      select 1 from public.shared_goals g
      where g.id = shared_goal_id and (
        g.owner_id = auth.uid() or exists (
          select 1 from public.shared_goal_members m
          where m.shared_goal_id = g.id
            and lower(m.member_email) = lower(coalesce(auth.jwt()->>'email',''))
        )
      )
    )
  );


-- ----------------------------------------------------------------------------
-- 6. Grants. RLS still decides which rows each user can touch.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.transactions              to authenticated;
grant select, insert, update, delete on public.savings_goals             to authenticated;
grant select, insert, update, delete on public.shared_goals              to authenticated;
grant select, insert,         delete on public.shared_goal_members       to authenticated;
grant select, insert                 on public.shared_goal_contributions to authenticated;


-- ----------------------------------------------------------------------------
-- 7. Verify. All five tables should come back with rowsecurity = true.
-- ----------------------------------------------------------------------------
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'transactions','savings_goals','shared_goals',
    'shared_goal_members','shared_goal_contributions'
  )
order by tablename;

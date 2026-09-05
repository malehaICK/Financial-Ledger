-- Ledger database schema for Supabase/PostgreSQL
-- Run this in Supabase SQL Editor.
-- NEVER expose a service_role key in the HTML application.

create extension if not exists pgcrypto;

create table if not exists public.transactions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_date date not null,
  transaction_type text not null check (transaction_type in ('income','expense')),
  category text,
  source text,
  description text,
  amount numeric(14,2) not null check (amount >= 0),
  fingerprint text,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_date_idx
  on public.transactions(user_id, transaction_date);

create index if not exists transactions_user_type_idx
  on public.transactions(user_id, transaction_type);

create unique index if not exists transactions_user_fingerprint_unique
  on public.transactions(user_id, fingerprint)
  where fingerprint is not null;

alter table public.transactions enable row level security;

drop policy if exists "Users can view their own transactions" on public.transactions;
create policy "Users can view their own transactions"
on public.transactions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert their own transactions" on public.transactions;
create policy "Users can insert their own transactions"
on public.transactions
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update their own transactions" on public.transactions;
create policy "Users can update their own transactions"
on public.transactions
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own transactions" on public.transactions;
create policy "Users can delete their own transactions"
on public.transactions
for delete
to authenticated
using (auth.uid() = user_id);

-- Optional: prevent the browser from selecting sensitive columns if you
-- later add any sensitive metadata. This current schema intentionally has
-- no bank account number, card number, street address, or uploaded-file column.

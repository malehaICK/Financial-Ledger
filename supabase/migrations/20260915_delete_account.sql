-- Ledger: "Delete account" in the profile sheet (Sept 2026)
--
-- Lets a signed-in user permanently delete their own account. Every Ledger table
-- references auth.users with ON DELETE CASCADE, so the user's transactions, goals,
-- and those goals' members and invite links are removed with it.
-- Goal memberships added by email before the person ever signed in have no user_id,
-- so they are removed by email first.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  if v_email <> '' then
    delete from public.goal_members where email = v_email;
  end if;

  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

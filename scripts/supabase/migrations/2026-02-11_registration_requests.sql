-- Единая регистрация через Telegram-бота:
-- - мульти-админы
-- - заявки на регистрацию
-- - статусы доступа клиентов

create extension if not exists "pgcrypto";

alter table public.customers
  alter column telegram_id drop not null;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'customers_telegram_id_key'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      drop constraint customers_telegram_id_key;
  end if;
end
$$;

create unique index if not exists customers_telegram_id_unique_not_null
  on public.customers (telegram_id)
  where telegram_id is not null;

alter table public.customers
  add column if not exists access_status text not null default 'active',
  add column if not exists bound_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_access_status_check'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_access_status_check
      check (access_status in ('active', 'blocked'));
  end if;
end
$$;

create table if not exists public.bot_admins (
  telegram_id bigint primary key,
  is_active boolean not null default true,
  added_at timestamptz not null default now(),
  added_by bigint
);

create table if not exists public.registration_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  username text,
  first_name text,
  last_name text,
  status text not null default 'pending',
  claimed_by bigint,
  claimed_at timestamptz,
  resolved_by bigint,
  resolved_at timestamptz,
  email text,
  moysklad_counterparty_id uuid,
  price_tier text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_requests_status_check
    check (status in ('pending', 'claimed', 'approved', 'error', 'rejected')),
  constraint registration_requests_price_tier_check
    check (price_tier is null or price_tier in ('base', 'minus5', 'minus8', 'minus10'))
);

create unique index if not exists registration_requests_one_open_per_user
  on public.registration_requests (telegram_id)
  where status in ('pending', 'claimed');

create index if not exists registration_requests_status_idx
  on public.registration_requests (status);

create index if not exists registration_requests_claimed_by_idx
  on public.registration_requests (claimed_by)
  where claimed_by is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_registration_requests_updated_at
  on public.registration_requests;

create trigger trg_registration_requests_updated_at
before update on public.registration_requests
for each row
execute function public.set_updated_at();


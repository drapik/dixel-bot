-- Supabase schema for DIXEL MVP
create extension if not exists "pgcrypto";

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint,
  email text,
  username text,
  first_name text,
  last_name text,
  moysklad_counterparty_id uuid,
  price_tier text,
  access_status text not null default 'active',
  bound_at timestamptz,
  constraint customers_price_tier_check
    check (price_tier in ('base', 'minus5', 'minus8', 'minus10')),
  constraint customers_access_status_check
    check (access_status in ('active', 'blocked')),
  created_at timestamptz not null default now()
);

create unique index customers_telegram_id_unique_not_null
  on public.customers (telegram_id)
  where telegram_id is not null;

create unique index customers_email_lower_unique
  on public.customers (lower(email))
  where email is not null;

create unique index customers_moysklad_counterparty_id_unique
  on public.customers (moysklad_counterparty_id)
  where moysklad_counterparty_id is not null;

create table public.bot_admins (
  telegram_id bigint primary key,
  is_active boolean not null default true,
  added_at timestamptz not null default now(),
  added_by bigint
);

create table public.registration_requests (
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

create unique index registration_requests_one_open_per_user
  on public.registration_requests (telegram_id)
  where status in ('pending', 'claimed');

create index registration_requests_status_idx
  on public.registration_requests (status);

create index registration_requests_claimed_by_idx
  on public.registration_requests (claimed_by)
  where claimed_by is not null;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  parent_external_id text,
  name text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create index categories_parent_external_id_idx on public.categories(parent_external_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  category_external_id text,
  sku text,
  name text not null,
  base_price numeric(12,2),
  stock integer not null default 0,
  picture_url text,
  moysklad_product_id uuid,
  created_at timestamptz not null default now()
);

create index products_category_external_id_idx on public.products(category_external_id);
create index products_sku_idx on public.products(sku);
create index products_name_idx on public.products(name);
create unique index products_moysklad_product_id_unique
  on public.products (moysklad_product_id)
  where moysklad_product_id is not null;

create view public.product_prices as
select
  id,
  external_id,
  sku,
  name,
  base_price,
  round(base_price * 0.95, 2) as price_minus5,
  round(base_price * 0.92, 2) as price_minus8,
  round(base_price * 0.90, 2) as price_minus10,
  stock,
  category_external_id,
  picture_url
from public.products;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  client_order_id text,
  status text not null default 'pending',
  price_tier text not null default 'minus5',
  total_amount numeric(12,2) not null default 0,
  moysklad_exported boolean not null default false,
  moysklad_order_id uuid,
  moysklad_export_error text,
  created_at timestamptz not null default now()
);

create index orders_customer_id_created_at_idx on public.orders(customer_id, created_at desc);
create unique index orders_customer_client_order_id_unique
  on public.orders(customer_id, client_order_id)
  where client_order_id is not null;
create index orders_moysklad_exported_idx on public.orders(moysklad_exported);
create unique index orders_moysklad_order_id_unique
  on public.orders (moysklad_order_id)
  where moysklad_order_id is not null;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_external_id text,
  sku text,
  name text,
  qty integer not null default 1,
  unit_price numeric(12,2) not null default 0
);

create index order_items_order_id_idx on public.order_items(order_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_registration_requests_updated_at
before update on public.registration_requests
for each row
execute function public.set_updated_at();

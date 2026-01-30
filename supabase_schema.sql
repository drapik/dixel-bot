-- Supabase schema for DIXEL MVP
create extension if not exists "pgcrypto";

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  email text,
  username text,
  first_name text,
  last_name text,
  moysklad_counterparty_id uuid,
  price_tier text,
  constraint customers_price_tier_check
    check (price_tier in ('base', 'minus5', 'minus8', 'minus10')),
  created_at timestamptz not null default now()
);

create unique index customers_email_lower_unique
  on public.customers (lower(email))
  where email is not null;

create unique index customers_moysklad_counterparty_id_unique
  on public.customers (moysklad_counterparty_id)
  where moysklad_counterparty_id is not null;

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
  created_at timestamptz not null default now()
);

create index products_category_external_id_idx on public.products(category_external_id);
create index products_sku_idx on public.products(sku);
create index products_name_idx on public.products(name);

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
  status text not null default 'pending',
  price_tier text not null default 'minus5',
  total_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create index orders_customer_id_created_at_idx on public.orders(customer_id, created_at desc);

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

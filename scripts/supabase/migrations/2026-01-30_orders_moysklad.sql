-- Добавляет отметку выгрузки заказа в МойСклад
alter table public.orders
  add column if not exists moysklad_exported boolean not null default false;

alter table public.orders
  add column if not exists moysklad_order_id uuid;

alter table public.orders
  add column if not exists moysklad_export_error text;

create index if not exists orders_moysklad_exported_idx
  on public.orders (moysklad_exported);

create unique index if not exists orders_moysklad_order_id_unique
  on public.orders (moysklad_order_id)
  where moysklad_order_id is not null;

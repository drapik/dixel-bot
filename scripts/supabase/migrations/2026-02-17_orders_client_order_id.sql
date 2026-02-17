-- Идемпотентность заказов от клиента (защита от повторной отправки)
alter table public.orders
  add column if not exists client_order_id text;

create unique index if not exists orders_customer_client_order_id_unique
  on public.orders (customer_id, client_order_id)
  where client_order_id is not null;

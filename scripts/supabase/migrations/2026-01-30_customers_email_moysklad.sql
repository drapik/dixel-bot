-- Добавляет email и uuid контрагента МойСклад в customers

alter table public.customers
  add column if not exists email text,
  add column if not exists moysklad_counterparty_id uuid;

create unique index if not exists customers_email_lower_unique
  on public.customers (lower(email))
  where email is not null;

create unique index if not exists customers_moysklad_counterparty_id_unique
  on public.customers (moysklad_counterparty_id)
  where moysklad_counterparty_id is not null;


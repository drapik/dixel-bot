-- Добавляет uuid товара МойСклад в products
alter table public.products
  add column if not exists moysklad_product_id uuid;

create unique index if not exists products_moysklad_product_id_unique
  on public.products (moysklad_product_id)
  where moysklad_product_id is not null;

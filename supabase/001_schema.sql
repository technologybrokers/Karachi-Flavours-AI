-- Food WhatsApp AI Agent schema
-- Run this in Supabase SQL Editor once for a new project.

create extension if not exists pgcrypto;

create sequence if not exists public.order_number_seq start 1001;

create table if not exists public.business_settings (
  id integer primary key default 1 check (id = 1),
  business_name text not null default 'Your Food Business',
  pickup_address text,
  pickup_instructions text,
  payment_instructions text,
  phone_display text,
  default_pickup_start time,
  default_pickup_end time,
  business_notes text,
  updated_at timestamptz not null default now()
);

insert into public.business_settings (id) values (1)
on conflict (id) do nothing;

create table if not exists public.menu_offerings (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  item_name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  portion_size text,
  prepared_qty integer not null default 0 check (prepared_qty >= 0),
  reserved_qty integer not null default 0 check (reserved_qty >= 0),
  sold_qty integer not null default 0 check (sold_qty >= 0),
  active boolean not null default true,
  allergens text,
  dietary_notes text,
  pickup_start time,
  pickup_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_not_negative check (reserved_qty + sold_qty <= prepared_qty)
);

create index if not exists ix_menu_offerings_date on public.menu_offerings(service_date, active);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  phone text not null,
  customer_name text,
  status text not null default 'confirmed' check (status in ('confirmed','ready','completed','cancelled')),
  source_message_id text unique,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded','not_required')),
  total_cents integer not null default 0 check (total_cents >= 0),
  pickup_time timestamp without time zone not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_orders_phone on public.orders(phone, created_at desc);
create index if not exists ix_orders_pickup on public.orders(pickup_time);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  offering_id uuid not null references public.menu_offerings(id),
  item_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ix_order_items_order on public.order_items(order_id);

create table if not exists public.conversations (
  phone text primary key,
  customer_name text,
  status text not null default 'ACTIVE',
  summary text,
  openai_previous_response_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.message_log (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null,
  wa_message_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists ix_message_log_phone on public.message_log(phone, created_at desc);

create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text not null unique,
  phone text not null,
  customer_name text,
  body text not null,
  message_type text not null default 'text',
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists ix_inbound_claim on public.inbound_messages(status, next_attempt_at, created_at);

-- Keep tables private from browser clients. The Node backend uses the server-side secret/service role key.
alter table public.business_settings enable row level security;
alter table public.menu_offerings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.conversations enable row level security;
alter table public.message_log enable row level security;
alter table public.inbound_messages enable row level security;

revoke all on public.business_settings from anon, authenticated;
revoke all on public.menu_offerings from anon, authenticated;
revoke all on public.orders from anon, authenticated;
revoke all on public.order_items from anon, authenticated;
revoke all on public.conversations from anon, authenticated;
revoke all on public.message_log from anon, authenticated;
revoke all on public.inbound_messages from anon, authenticated;

grant all on public.business_settings to service_role;
grant all on public.menu_offerings to service_role;
grant all on public.orders to service_role;
grant all on public.order_items to service_role;
grant all on public.conversations to service_role;
grant all on public.message_log to service_role;
grant all on public.inbound_messages to service_role;
grant usage, select on sequence public.order_number_seq to service_role;

-- Atomically claims one queued inbound WhatsApp message. SKIP LOCKED permits safe multi-instance workers.
create or replace function public.claim_next_inbound_message()
returns setof public.inbound_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.inbound_messages
  where (status = 'pending' and next_attempt_at <= now())
     or (status = 'processing' and claimed_at < now() - interval '5 minutes')
  order by created_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.inbound_messages
  set status = 'processing', attempts = attempts + 1, claimed_at = now()
  where id = v_id
  returning *;
end;
$$;

-- Creates a confirmed order and reserves all stock in one DB transaction.
create or replace function public.create_order_atomic(
  p_phone text,
  p_customer_name text,
  p_items jsonb,
  p_pickup_time timestamp without time zone,
  p_order_prefix text,
  p_source_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_order_number text;
  v_total integer := 0;
  v_item record;
  v_off public.menu_offerings%rowtype;
  v_qty integer;
  v_available integer;
  v_settings public.business_settings%rowtype;
begin
  -- Replaying the same WhatsApp confirmation must never create a second order.
  if p_source_message_id is not null then
    select id into v_order_id from public.orders where source_message_id = p_source_message_id limit 1;
    if found then
      return (
        select jsonb_build_object(
          'ok', true, 'idempotent_replay', true, 'order_id', o.id, 'order_number', o.order_number,
          'status', o.status, 'total_cents', o.total_cents,
          'total', '$' || to_char(o.total_cents / 100.0, 'FM999999990.00'),
          'pickup_time', to_char(o.pickup_time, 'YYYY-MM-DD"T"HH24:MI'),
          'items', (select coalesce(jsonb_agg(jsonb_build_object('item_name', oi.item_name, 'quantity', oi.quantity, 'unit_price_cents', oi.unit_price_cents) order by oi.item_name), '[]'::jsonb) from public.order_items oi where oi.order_id = o.id)
        ) from public.orders o where o.id = v_order_id
      );
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  select * into v_settings from public.business_settings where id = 1;
  if v_settings.default_pickup_start is not null and p_pickup_time::time < v_settings.default_pickup_start then
    raise exception 'Pickup time is before the business pickup window.';
  end if;
  if v_settings.default_pickup_end is not null and p_pickup_time::time > v_settings.default_pickup_end then
    raise exception 'Pickup time is after the business pickup window.';
  end if;

  -- Lock requested offerings in deterministic UUID order to avoid overselling/deadlocks.
  perform 1
  from public.menu_offerings m
  where m.id in (
    select distinct (x->>'offering_id')::uuid from jsonb_array_elements(p_items) x
  )
  order by m.id
  for update;

  -- Aggregate duplicate offering IDs before checks/inserts.
  for v_item in
    select (x->>'offering_id')::uuid as offering_id,
           sum((x->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) x
    group by (x->>'offering_id')::uuid
  loop
    v_qty := v_item.quantity;
    if v_qty <= 0 then raise exception 'Quantity must be greater than zero.'; end if;

    select * into v_off from public.menu_offerings where id = v_item.offering_id;
    if not found or not v_off.active then raise exception 'Menu item is unavailable.'; end if;
    if v_off.service_date <> p_pickup_time::date then
      raise exception '% is offered on %, not the selected pickup date.', v_off.item_name, v_off.service_date;
    end if;
    if v_off.pickup_start is not null and p_pickup_time::time < v_off.pickup_start then
      raise exception 'Pickup time is before the available window for %.', v_off.item_name;
    end if;
    if v_off.pickup_end is not null and p_pickup_time::time > v_off.pickup_end then
      raise exception 'Pickup time is after the available window for %.', v_off.item_name;
    end if;

    v_available := v_off.prepared_qty - v_off.reserved_qty - v_off.sold_qty;
    if v_available < v_qty then
      raise exception 'Insufficient stock for %. Requested %, available %.', v_off.item_name, v_qty, v_available;
    end if;
    v_total := v_total + (v_off.price_cents * v_qty);
  end loop;

  v_order_number := upper(coalesce(nullif(trim(p_order_prefix), ''), 'ORD')) || '-' || lpad(nextval('public.order_number_seq')::text, 6, '0');

  insert into public.orders(order_number, phone, customer_name, status, total_cents, pickup_time, source_message_id)
  values (v_order_number, p_phone, p_customer_name, 'confirmed', v_total, p_pickup_time, p_source_message_id)
  returning id into v_order_id;

  for v_item in
    select (x->>'offering_id')::uuid as offering_id,
           sum((x->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) x
    group by (x->>'offering_id')::uuid
  loop
    select * into v_off from public.menu_offerings where id = v_item.offering_id;

    insert into public.order_items(order_id, offering_id, item_name, quantity, unit_price_cents)
    values (v_order_id, v_off.id, v_off.item_name, v_item.quantity, v_off.price_cents);

    update public.menu_offerings
    set reserved_qty = reserved_qty + v_item.quantity, updated_at = now()
    where id = v_off.id;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'status', 'confirmed',
    'total_cents', v_total,
    'total', '$' || to_char(v_total / 100.0, 'FM999999990.00'),
    'pickup_time', to_char(p_pickup_time, 'YYYY-MM-DD"T"HH24:MI'),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'item_name', oi.item_name,
        'quantity', oi.quantity,
        'unit_price_cents', oi.unit_price_cents
      ) order by oi.item_name), '[]'::jsonb)
      from public.order_items oi where oi.order_id = v_order_id
    )
  );
end;
$$;

-- Replaces all items on a customer's active order and optionally changes pickup time.
create or replace function public.modify_order_atomic(
  p_phone text,
  p_order_number text,
  p_items jsonb,
  p_pickup_time timestamp without time zone default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_target_pickup timestamp without time zone;
  v_item record;
  v_old record;
  v_off public.menu_offerings%rowtype;
  v_total integer := 0;
  v_available integer;
  v_settings public.business_settings%rowtype;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  select * into v_order
  from public.orders
  where order_number = p_order_number and phone = p_phone
  for update;

  if not found then raise exception 'Order not found.'; end if;
  if v_order.status not in ('confirmed','ready') then
    raise exception 'Only confirmed or ready orders can be modified.';
  end if;

  v_target_pickup := coalesce(p_pickup_time, v_order.pickup_time);

  select * into v_settings from public.business_settings where id = 1;
  if v_settings.default_pickup_start is not null and v_target_pickup::time < v_settings.default_pickup_start then
    raise exception 'Pickup time is before the business pickup window.';
  end if;
  if v_settings.default_pickup_end is not null and v_target_pickup::time > v_settings.default_pickup_end then
    raise exception 'Pickup time is after the business pickup window.';
  end if;

  -- Lock both old and requested offering rows in one deterministic set.
  perform 1 from public.menu_offerings m
  where m.id in (
    select offering_id from public.order_items where order_id = v_order.id
    union
    select distinct (x->>'offering_id')::uuid from jsonb_array_elements(p_items) x
  )
  order by m.id
  for update;

  -- Release old reservation; transaction rollback restores it if any later check fails.
  for v_old in select offering_id, quantity from public.order_items where order_id = v_order.id loop
    update public.menu_offerings
    set reserved_qty = reserved_qty - v_old.quantity, updated_at = now()
    where id = v_old.offering_id;
  end loop;

  delete from public.order_items where order_id = v_order.id;

  for v_item in
    select (x->>'offering_id')::uuid as offering_id,
           sum((x->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) x
    group by (x->>'offering_id')::uuid
  loop
    if v_item.quantity <= 0 then raise exception 'Quantity must be greater than zero.'; end if;
    select * into v_off from public.menu_offerings where id = v_item.offering_id;
    if not found or not v_off.active then raise exception 'Menu item is unavailable.'; end if;
    if v_off.service_date <> v_target_pickup::date then
      raise exception '% is offered on %, not the selected pickup date.', v_off.item_name, v_off.service_date;
    end if;
    if v_off.pickup_start is not null and v_target_pickup::time < v_off.pickup_start then
      raise exception 'Pickup time is before the available window for %.', v_off.item_name;
    end if;
    if v_off.pickup_end is not null and v_target_pickup::time > v_off.pickup_end then
      raise exception 'Pickup time is after the available window for %.', v_off.item_name;
    end if;

    v_available := v_off.prepared_qty - v_off.reserved_qty - v_off.sold_qty;
    if v_available < v_item.quantity then
      raise exception 'Insufficient stock for %. Requested %, available %.', v_off.item_name, v_item.quantity, v_available;
    end if;

    insert into public.order_items(order_id, offering_id, item_name, quantity, unit_price_cents)
    values (v_order.id, v_off.id, v_off.item_name, v_item.quantity, v_off.price_cents);

    update public.menu_offerings
    set reserved_qty = reserved_qty + v_item.quantity, updated_at = now()
    where id = v_off.id;

    v_total := v_total + (v_off.price_cents * v_item.quantity);
  end loop;

  update public.orders
  set total_cents = v_total, pickup_time = v_target_pickup, status = 'confirmed', updated_at = now()
  where id = v_order.id;

  return jsonb_build_object(
    'ok', true,
    'order_number', v_order.order_number,
    'status', 'confirmed',
    'total_cents', v_total,
    'total', '$' || to_char(v_total / 100.0, 'FM999999990.00'),
    'pickup_time', to_char(v_target_pickup, 'YYYY-MM-DD"T"HH24:MI'),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('item_name', item_name, 'quantity', quantity, 'unit_price_cents', unit_price_cents) order by item_name), '[]'::jsonb)
      from public.order_items where order_id = v_order.id
    )
  );
end;
$$;

create or replace function public.cancel_order_atomic(p_phone text, p_order_number text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
begin
  select * into v_order from public.orders
  where order_number = p_order_number and phone = p_phone
  for update;

  if not found then raise exception 'Order not found.'; end if;
  if v_order.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'order_number', v_order.order_number, 'status', 'cancelled', 'already_cancelled', true);
  end if;
  if v_order.status = 'completed' then raise exception 'Completed orders cannot be cancelled.'; end if;

  perform 1 from public.menu_offerings m
  where m.id in (select offering_id from public.order_items where order_id = v_order.id)
  order by m.id for update;

  for v_item in select offering_id, quantity from public.order_items where order_id = v_order.id loop
    update public.menu_offerings
    set reserved_qty = reserved_qty - v_item.quantity, updated_at = now()
    where id = v_item.offering_id;
  end loop;

  update public.orders set status = 'cancelled', updated_at = now() where id = v_order.id;
  return jsonb_build_object('ok', true, 'order_number', v_order.order_number, 'status', 'cancelled');
end;
$$;

-- Admin transition with correct inventory movement.
create or replace function public.set_order_status_atomic(p_order_id uuid, p_new_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
begin
  if p_new_status not in ('confirmed','ready','completed','cancelled') then
    raise exception 'Invalid order status.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_order.status = p_new_status then
    return jsonb_build_object('ok', true, 'order_number', v_order.order_number, 'status', p_new_status);
  end if;
  if v_order.status in ('completed','cancelled') then
    raise exception 'Completed/cancelled orders cannot transition to another status.';
  end if;
  if p_new_status = 'confirmed' and v_order.status <> 'confirmed' then
    raise exception 'Cannot move an order backwards to confirmed.';
  end if;

  if p_new_status in ('completed','cancelled') then
    perform 1 from public.menu_offerings m
    where m.id in (select offering_id from public.order_items where order_id = v_order.id)
    order by m.id for update;

    for v_item in select offering_id, quantity from public.order_items where order_id = v_order.id loop
      if p_new_status = 'completed' then
        update public.menu_offerings
        set reserved_qty = reserved_qty - v_item.quantity,
            sold_qty = sold_qty + v_item.quantity,
            updated_at = now()
        where id = v_item.offering_id;
      else
        update public.menu_offerings
        set reserved_qty = reserved_qty - v_item.quantity, updated_at = now()
        where id = v_item.offering_id;
      end if;
    end loop;
  end if;

  update public.orders set status = p_new_status, updated_at = now() where id = p_order_id;
  return jsonb_build_object('ok', true, 'order_number', v_order.order_number, 'status', p_new_status);
end;
$$;

revoke all on function public.claim_next_inbound_message() from public, anon, authenticated;
revoke all on function public.create_order_atomic(text,text,jsonb,timestamp without time zone,text,text) from public, anon, authenticated;
revoke all on function public.modify_order_atomic(text,text,jsonb,timestamp without time zone) from public, anon, authenticated;
revoke all on function public.cancel_order_atomic(text,text) from public, anon, authenticated;
revoke all on function public.set_order_status_atomic(uuid,text) from public, anon, authenticated;

grant execute on function public.claim_next_inbound_message() to service_role;
grant execute on function public.create_order_atomic(text,text,jsonb,timestamp without time zone,text,text) to service_role;
grant execute on function public.modify_order_atomic(text,text,jsonb,timestamp without time zone) to service_role;
grant execute on function public.cancel_order_atomic(text,text) to service_role;
grant execute on function public.set_order_status_atomic(uuid,text) to service_role;

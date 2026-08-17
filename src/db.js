import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';
import { config } from './config.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function throwIf(error, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export function localDate() {
  return DateTime.now().setZone(config.timezone).toISODate();
}

export async function enqueueInbound({ waMessageId, phone, customerName, body, messageType = 'text' }) {
  const { error } = await supabase.from('inbound_messages').upsert({
    wa_message_id: waMessageId,
    phone,
    customer_name: customerName || null,
    body,
    message_type: messageType,
  }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
  throwIf(error, 'enqueue inbound message');
}

export async function claimNextInbound() {
  const { data, error } = await supabase.rpc('claim_next_inbound_message');
  throwIf(error, 'claim inbound message');
  return Array.isArray(data) && data.length ? data[0] : null;
}

export async function completeInbound(id) {
  const { error } = await supabase.from('inbound_messages').update({
    status: 'completed', processed_at: new Date().toISOString(), last_error: null,
  }).eq('id', id);
  throwIf(error, 'complete inbound message');
}

export async function retryInbound(id, attempts, errorMessage) {
  const delaySeconds = Math.min(300, Math.max(5, 2 ** attempts * 5));
  const retryAt = DateTime.utc().plus({ seconds: delaySeconds }).toISO();
  const status = attempts >= config.maxInboundAttempts ? 'failed' : 'pending';
  const { error } = await supabase.from('inbound_messages').update({
    status,
    next_attempt_at: retryAt,
    last_error: String(errorMessage).slice(0, 2000),
  }).eq('id', id);
  throwIf(error, 'retry inbound message');
}

export async function logMessage({ phone, direction, body, waMessageId = null }) {
  const { error } = await supabase.from('message_log').upsert({
    phone, direction, body, wa_message_id: waMessageId,
  }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
  throwIf(error, 'log message');
}

export async function getConversation(phone) {
  const { data, error } = await supabase.from('conversations').select('*').eq('phone', phone).maybeSingle();
  throwIf(error, 'get conversation');
  return data;
}

export async function upsertConversation(phone, patch = {}) {
  const { data, error } = await supabase.from('conversations').upsert({
    phone,
    updated_at: new Date().toISOString(),
    ...patch,
  }, { onConflict: 'phone', defaultToNull: false }).select().single();
  throwIf(error, 'upsert conversation');
  return data;
}

export async function recentMessages(phone, limit = 12) {
  const { data, error } = await supabase.from('message_log')
    .select('direction,body,created_at')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);
  throwIf(error, 'get recent messages');
  return (data || []).reverse();
}

export async function getSettings() {
  const { data, error } = await supabase.from('business_settings').select('*').eq('id', 1).single();
  throwIf(error, 'get settings');
  return data;
}

export async function getMenu(date) {
  const { data, error } = await supabase.from('menu_offerings')
    .select('id,service_date,item_name,description,price_cents,portion_size,prepared_qty,reserved_qty,sold_qty,active,allergens,dietary_notes,pickup_start,pickup_end')
    .eq('service_date', date)
    .eq('active', true)
    .order('item_name');
  throwIf(error, 'get menu');
  return (data || []).map(x => ({ ...x, available_qty: Math.max(0, x.prepared_qty - x.reserved_qty - x.sold_qty) }));
}

export async function getOffering(id) {
  const { data, error } = await supabase.from('menu_offerings').select('*').eq('id', id).maybeSingle();
  throwIf(error, 'get offering');
  if (!data) return null;
  return { ...data, available_qty: Math.max(0, data.prepared_qty - data.reserved_qty - data.sold_qty) };
}

export async function createOrderAtomic({ phone, customerName, items, pickupTime, sourceMessageId }) {
  const { data, error } = await supabase.rpc('create_order_atomic', {
    p_phone: phone,
    p_customer_name: customerName || null,
    p_items: items,
    p_pickup_time: pickupTime,
    p_order_prefix: config.orderPrefix,
    p_source_message_id: sourceMessageId,
  });
  throwIf(error, 'create order');
  return data;
}

export async function modifyOrderAtomic({ phone, orderNumber, items, pickupTime }) {
  const { data, error } = await supabase.rpc('modify_order_atomic', {
    p_phone: phone,
    p_order_number: orderNumber,
    p_items: items,
    p_pickup_time: pickupTime || null,
  });
  throwIf(error, 'modify order');
  return data;
}

export async function cancelOrderAtomic({ phone, orderNumber }) {
  const { data, error } = await supabase.rpc('cancel_order_atomic', {
    p_phone: phone,
    p_order_number: orderNumber,
  });
  throwIf(error, 'cancel order');
  return data;
}

export async function getOrderForCustomer(phone, orderNumber) {
  const { data, error } = await supabase.from('orders')
    .select('id,order_number,status,payment_status,total_cents,pickup_time,created_at,order_items(quantity,unit_price_cents,item_name,offering_id)')
    .eq('phone', phone)
    .eq('order_number', orderNumber)
    .maybeSingle();
  throwIf(error, 'get order');
  return data;
}

export async function setConversationStatus(phone, status, summary = null) {
  const { data, error } = await supabase.from('conversations').upsert({
    phone, status, summary, updated_at: new Date().toISOString(),
  }, { onConflict: 'phone' }).select().single();
  throwIf(error, 'set conversation status');
  return data;
}

// ---- Admin ----
export async function adminDashboard(date) {
  const [settings, offerings, orders] = await Promise.all([
    getSettings(),
    getMenuAdmin(date),
    getOrdersAdmin(date),
  ]);
  return { date, settings, offerings, orders };
}

export async function getMenuAdmin(date) {
  const { data, error } = await supabase.from('menu_offerings').select('*').eq('service_date', date).order('item_name');
  throwIf(error, 'admin get menu');
  return (data || []).map(x => ({ ...x, available_qty: Math.max(0, x.prepared_qty - x.reserved_qty - x.sold_qty) }));
}

export async function saveOffering(payload) {
  const clean = {
    service_date: payload.service_date,
    item_name: payload.item_name,
    description: payload.description || null,
    price_cents: Number(payload.price_cents),
    portion_size: payload.portion_size || null,
    prepared_qty: Number(payload.prepared_qty || 0),
    active: payload.active !== false,
    allergens: payload.allergens || null,
    dietary_notes: payload.dietary_notes || null,
    pickup_start: payload.pickup_start || null,
    pickup_end: payload.pickup_end || null,
  };
  const { data, error } = await supabase.from('menu_offerings').insert(clean).select().single();
  throwIf(error, 'save offering');
  return data;
}

export async function updateOffering(id, patch) {
  const allowed = ['item_name','description','price_cents','portion_size','prepared_qty','active','allergens','dietary_notes','pickup_start','pickup_end'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if ('price_cents' in clean) clean.price_cents = Number(clean.price_cents);
  if ('prepared_qty' in clean) clean.prepared_qty = Number(clean.prepared_qty);
  const { data, error } = await supabase.from('menu_offerings').update(clean).eq('id', id).select().single();
  throwIf(error, 'update offering');
  return data;
}

export async function getOrdersAdmin(date) {
  const start = `${date}T00:00:00`;
  const end = DateTime.fromISO(date, { zone: config.timezone }).plus({ days: 1 }).toISODate() + 'T00:00:00';
  const { data, error } = await supabase.from('orders')
    .select('id,order_number,phone,customer_name,status,payment_status,total_cents,pickup_time,created_at,order_items(quantity,item_name,unit_price_cents)')
    .gte('pickup_time', start).lt('pickup_time', end).order('pickup_time');
  throwIf(error, 'admin get orders');
  return data || [];
}

export async function setOrderStatusAdmin(id, status) {
  const { data, error } = await supabase.rpc('set_order_status_atomic', { p_order_id: id, p_new_status: status });
  throwIf(error, 'set order status');
  return data;
}

export async function updateSettingsAdmin(patch) {
  const allowed = ['business_name','pickup_address','pickup_instructions','payment_instructions','phone_display','default_pickup_start','default_pickup_end','business_notes'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (clean.default_pickup_start === '') clean.default_pickup_start = null;
  if (clean.default_pickup_end === '') clean.default_pickup_end = null;
  const { data, error } = await supabase.from('business_settings').update(clean).eq('id', 1).select().single();
  throwIf(error, 'update settings');
  return data;
}

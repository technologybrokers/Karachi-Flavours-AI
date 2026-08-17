import { DateTime } from 'luxon';
import { config } from './config.js';
import {
  localDate, getSettings, getMenu, getOffering, createOrderAtomic,
  modifyOrderAtomic, cancelOrderAtomic, getOrderForCustomer, setConversationStatus,
} from './db.js';

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  name,
  description,
  strict: true,
  parameters: {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  },
});

export const toolDefinitions = [
  fn('get_business_info', 'Get verified pickup, payment and business information. Use this instead of guessing business details.', {}, []),
  fn('get_menu', 'Get the verified live menu and remaining quantity for a specific date.', {
    date: { type: ['string','null'], description: 'Local service date YYYY-MM-DD. Use null for today.' },
  }, ['date']),
  fn('check_availability', 'Check the live remaining quantity of one menu offering immediately before promising or ordering it.', {
    offering_id: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
  }, ['offering_id','quantity']),
  fn('create_order', 'Atomically reserve stock and create a confirmed customer order. Call only after the customer explicitly confirms the final items, quantities and pickup time.', {
    items: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        properties: {
          offering_id: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
        },
        required: ['offering_id','quantity'], additionalProperties: false,
      },
    },
    pickup_time: { type: 'string', description: 'Local ISO datetime YYYY-MM-DDTHH:mm with no timezone offset.' },
  }, ['items','pickup_time']),
  fn('get_order', 'Get one of this customer’s existing orders by order number.', {
    order_number: { type: 'string' },
  }, ['order_number']),
  fn('modify_order', 'Atomically replace items and/or pickup time on an existing confirmed order for this customer, rechecking stock.', {
    order_number: { type: 'string' },
    items: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        properties: {
          offering_id: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
        },
        required: ['offering_id','quantity'], additionalProperties: false,
      },
    },
    pickup_time: { type: ['string','null'], description: 'New local ISO datetime YYYY-MM-DDTHH:mm, or null to keep existing pickup time.' },
  }, ['order_number','items','pickup_time']),
  fn('cancel_order', 'Cancel this customer’s confirmed order and atomically release its reserved food quantity.', {
    order_number: { type: 'string' },
  }, ['order_number']),
  fn('close_conversation', 'Mark the current conversation as completed when no more customer input is required right now.', {
    status: {
      type: 'string',
      enum: ['ORDER_CONFIRMED','ORDER_CANCELLED','SOLD_OUT','CUSTOMER_NOT_ORDERING','REQUEST_DECLINED','COMPLETED'],
    },
    summary: { type: 'string' },
  }, ['status','summary']),
];

function money(cents) { return `$${(Number(cents) / 100).toFixed(2)}`; }

function validatePickupTime(value) {
  const dt = DateTime.fromISO(value, { zone: config.timezone });
  if (!dt.isValid) throw new Error('Invalid pickup_time. Use YYYY-MM-DDTHH:mm.');
  return dt.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export async function executeTool(name, args, context) {
  switch (name) {
    case 'get_business_info': {
      const s = await getSettings();
      return {
        business_name: s.business_name,
        pickup_address: s.pickup_address,
        pickup_instructions: s.pickup_instructions,
        payment_instructions: s.payment_instructions,
        default_pickup_start: s.default_pickup_start,
        default_pickup_end: s.default_pickup_end,
        business_notes: s.business_notes,
        timezone: config.timezone,
        today: localDate(),
      };
    }
    case 'get_menu': {
      const date = args.date || localDate();
      const menu = await getMenu(date);
      return {
        date,
        items: menu.map(m => ({
          offering_id: m.id,
          item_name: m.item_name,
          description: m.description,
          price: money(m.price_cents),
          price_cents: m.price_cents,
          portion_size: m.portion_size,
          available_qty: m.available_qty,
          sold_out: m.available_qty <= 0,
          allergens: m.allergens,
          dietary_notes: m.dietary_notes,
          pickup_start: m.pickup_start,
          pickup_end: m.pickup_end,
        })),
      };
    }
    case 'check_availability': {
      const offering = await getOffering(args.offering_id);
      if (!offering || !offering.active) return { available: false, reason: 'Offering not found or inactive.' };
      return {
        available: offering.available_qty >= args.quantity,
        requested_qty: args.quantity,
        available_qty: offering.available_qty,
        item_name: offering.item_name,
        price: money(offering.price_cents),
        offering_id: offering.id,
      };
    }
    case 'create_order': {
      const result = await createOrderAtomic({
        phone: context.phone,
        customerName: context.customerName,
        items: args.items,
        pickupTime: validatePickupTime(args.pickup_time),
        sourceMessageId: context.waMessageId,
      });
      return result;
    }
    case 'get_order': {
      const order = await getOrderForCustomer(context.phone, args.order_number);
      if (!order) return { found: false };
      return { found: true, ...order, total: money(order.total_cents) };
    }
    case 'modify_order': {
      return await modifyOrderAtomic({
        phone: context.phone,
        orderNumber: args.order_number,
        items: args.items,
        pickupTime: args.pickup_time ? validatePickupTime(args.pickup_time) : null,
      });
    }
    case 'cancel_order': {
      return await cancelOrderAtomic({ phone: context.phone, orderNumber: args.order_number });
    }
    case 'close_conversation': {
      await setConversationStatus(context.phone, args.status, args.summary);
      return { closed: true, status: args.status };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

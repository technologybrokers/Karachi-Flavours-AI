# Karachi Flavour WhatsApp AI Agent — Twilio Edition

Autonomous WhatsApp ordering system using **Twilio WhatsApp**, **OpenAI Responses API**, and **Supabase**.

Customers message WhatsApp; Twilio forwards the inbound message to this service; the AI checks the live menu/stock in Supabase, takes or changes orders, and replies through Twilio. The service uses a durable inbound queue and atomic database functions so retries do not create duplicate orders or oversell stock.

## Architecture

```text
Customer WhatsApp
      |
      v
Twilio WhatsApp
      |
      v
POST /webhook/whatsapp
      |
      v
Supabase inbound queue -----> Worker
                                |
                                v
                         OpenAI Responses API
                           |             |
                           | tool calls  |
                           v             |
                         Supabase <------+
                      menu/orders/stock
                                |
                                v
                     Twilio Messages API
                                |
                                v
                         Customer reply
```

## What is included

- Twilio WhatsApp inbound webhook receiver.
- Twilio `X-Twilio-Signature` request validation in production.
- Async reply through Twilio Programmable Messaging.
- OpenAI tool-calling ordering agent.
- English, Urdu and Roman Urdu conversations.
- Supabase menu, stock, orders, conversations and message queue.
- Atomic stock reservation / modification / cancellation.
- Duplicate-message and duplicate-order protection.
- Mobile/desktop admin dashboard.
- Dockerfile for hosting.

## Required environment variables

Copy `.env.example` and configure these values on your hosting service:

```dotenv
NODE_ENV=production
TIMEZONE=Australia/Melbourne
ADMIN_TOKEN=<long-random-secret>
ORDER_PREFIX=KF
BUSINESS_NAME=Karachi Flavour
PUBLIC_BASE_URL=https://YOUR-SERVICE.onrender.com

OPENAI_API_KEY=<server-side-openai-api-key>
OPENAI_MODEL=gpt-5.6-terra

TWILIO_ACCOUNT_SID=<Twilio Account SID>
TWILIO_AUTH_TOKEN=<Twilio Auth Token>
TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX
DRY_RUN_WHATSAPP=false

SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=<server-side Supabase secret key>
# or, for legacy projects:
SUPABASE_SERVICE_ROLE_KEY=<legacy service-role key>
```

`PUBLIC_BASE_URL` must exactly match the public HTTPS origin used in Twilio, because Twilio signs webhook requests using the webhook URL and request parameters.

## Run locally

```bash
npm install
npm run check
npm start
```

Health check:

```text
GET http://localhost:3000/health
```

Admin dashboard:

```text
http://localhost:3000/admin.html
```

## Deploy on Render

1. Put this project in a Git repository.
2. In Render choose **New > Web Service**.
3. Connect the repository.
4. Runtime: **Node** (or Docker if you prefer).
5. Build command: `npm install`
6. Start command: `npm start`
7. Health check path: `/health`
8. Add all environment variables above in Render's **Environment** page.
9. Deploy.
10. Open `https://YOUR-SERVICE.onrender.com/health` and confirm it reports `ok: true`.
11. Set `PUBLIC_BASE_URL` to that exact origin if it was not known before the first deploy, then redeploy.

## Configure the Twilio WhatsApp Tryout/Sandbox webhook

In Twilio's **Inbound** configuration:

- Auto-reply: **Custom**
- Webhook URL: `https://YOUR-SERVICE.onrender.com/webhook/whatsapp`
- Request method: **POST**

Save the configuration.

Then send a WhatsApp message from a phone that has joined the Twilio Tryout/Sandbox. Twilio will POST the message to the service. The webhook queues it and returns an empty TwiML response quickly; the worker runs the AI and sends the actual response through Twilio.

## Twilio credentials

Keep `TWILIO_AUTH_TOKEN` server-side only. Do not paste it into browser JavaScript or commit it to Git.

`TWILIO_WHATSAPP_FROM` should be copied from the Twilio Tryout/Sandbox screen. Do not assume a particular number because the number shown for an account/testing environment can vary.

## Supabase

The database is the source of truth for menu, prices and stock. The application does not let the language model invent availability.

Core tables:

```text
business_settings
menu_offerings
orders
order_items
conversations
message_log
inbound_messages
```

Available quantity is:

```text
prepared_qty - reserved_qty - sold_qty
```

Order creation and stock reservation are performed atomically in PostgreSQL.

## Admin workflow

Open:

```text
https://YOUR-SERVICE.onrender.com/admin.html
```

Enter the configured `ADMIN_TOKEN`, then maintain today's menu, price, portion size, prepared quantity, pickup details and order status.

## Production notes

- The Twilio Tryout/Sandbox is for testing only; register an approved WhatsApp sender before production use.
- Keep OpenAI, Twilio and Supabase secrets server-side.
- Use HTTPS.
- Set `NODE_ENV=production` so Twilio signature validation is enforced.
- Keep menu, stock, pickup/payment policies and allergen information accurate.
- Test sold-out items, final-stock races, order confirmation, modifications and cancellation before advertising the number.

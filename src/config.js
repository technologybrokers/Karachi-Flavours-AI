import 'dotenv/config';

const dryRunWhatsApp = String(process.env.DRY_RUN_WHATSAPP || 'false').toLowerCase() === 'true';

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  return value ? String(value).replace(/\/+$/, '') : '';
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  timezone: process.env.TIMEZONE || 'Australia/Melbourne',
  adminToken: required('ADMIN_TOKEN'),
  orderPrefix: process.env.ORDER_PREFIX || 'ORD',
  businessName: process.env.BUSINESS_NAME || 'Food Business',
  publicBaseUrl: normalizeBaseUrl(process.env.PUBLIC_BASE_URL || (dryRunWhatsApp ? 'http://localhost:3000' : required('PUBLIC_BASE_URL'))),

  openaiApiKey: required('OPENAI_API_KEY'),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-terra',

  dryRunWhatsApp,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || (dryRunWhatsApp ? 'AC-dry-run' : required('TWILIO_ACCOUNT_SID')),
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || (dryRunWhatsApp ? 'dry-run' : required('TWILIO_AUTH_TOKEN')),
  twilioWhatsAppFrom: process.env.TWILIO_WHATSAPP_FROM || (dryRunWhatsApp ? 'whatsapp:+10000000000' : required('TWILIO_WHATSAPP_FROM')),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || required('SUPABASE_SERVICE_ROLE_KEY'),

  workerPollMs: Number(process.env.WORKER_POLL_MS || 1200),
  maxInboundAttempts: Number(process.env.MAX_INBOUND_ATTEMPTS || 5),
};

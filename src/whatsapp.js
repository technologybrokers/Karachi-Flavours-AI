import twilio from 'twilio';
import { config } from './config.js';

function stripWhatsAppPrefix(value = '') {
  return String(value).replace(/^whatsapp:/i, '');
}

function asWhatsAppAddress(value = '') {
  const text = String(value).trim();
  return /^whatsapp:/i.test(text) ? text : `whatsapp:${text}`;
}

export function verifyTwilioSignature(signatureHeader, params) {
  if (config.dryRunWhatsApp) return true;
  if (!signatureHeader) return false;
  const webhookUrl = `${config.publicBaseUrl}/webhook/whatsapp`;
  return twilio.validateRequest(config.twilioAuthToken, signatureHeader, webhookUrl, params || {});
}


export function buildTwiMLReply(body = '') {
  const response = new twilio.twiml.MessagingResponse();
  if (String(body).trim()) response.message(String(body));
  return response.toString();
}

export function extractInboundMessage(params = {}) {
  const messageSid = params.MessageSid || params.SmsMessageSid || params.SmsSid;
  const from = stripWhatsAppPrefix(params.From || '');
  if (!messageSid || !from) return null;

  const bodyText = String(params.Body || '').trim();
  const mediaCount = Number(params.NumMedia || 0);
  const hasText = bodyText.length > 0;

  let body = bodyText;
  let messageType = hasText ? 'text' : (mediaCount > 0 ? 'media' : 'unknown');
  if (!hasText) {
    body = mediaCount > 0
      ? '[Customer sent a WhatsApp media/voice/image message. Politely ask them to type their order or question as text.]'
      : '[Customer sent a WhatsApp message with no readable text. Politely ask them to type their order or question as text.]';
  }

  return {
    waMessageId: messageSid,
    phone: from,
    customerName: params.ProfileName || null,
    body,
    messageType,
  };
}

// Send directly to Twilio's Messages REST endpoint rather than via the helper
// library's Message builder. This deliberately sends only Body, From and To
// for an in-session WhatsApp free-form reply.
export async function sendWhatsAppText(to, body) {
  if (config.dryRunWhatsApp) {
    console.log(`[DRY RUN WhatsApp -> ${to}] ${body}`);
    return { id: `dry-${Date.now()}` };
  }

  const fromAddress = asWhatsAppAddress(config.twilioWhatsAppFrom);
  const toAddress = asWhatsAppAddress(to);
  const form = new URLSearchParams();
  form.set('Body', String(body));
  form.set('From', fromAddress);
  form.set('To', toAddress);

  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: raw }; }

  if (!response.ok) {
    const error = new Error(`Twilio send failed (${response.status})${data.code ? ` code ${data.code}` : ''}: ${data.message || response.statusText}`);
    error.status = response.status;
    error.code = data.code;
    error.moreInfo = data.more_info || data.moreInfo;
    throw error;
  }

  return { id: data.sid, status: data.status };
}

import twilio from 'twilio';
import { config } from './config.js';

const client = config.dryRunWhatsApp ? null : twilio(config.twilioAccountSid, config.twilioAuthToken);

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

export async function sendWhatsAppText(to, body) {
  if (config.dryRunWhatsApp) {
    console.log(`[DRY RUN WhatsApp -> ${to}] ${body}`);
    return { id: `dry-${Date.now()}` };
  }

  const message = await client.messages.create({
    body,
    from: asWhatsAppAddress(config.twilioWhatsAppFrom),
    to: asWhatsAppAddress(to),
  });

  return { id: message.sid, status: message.status };
}

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { verifyTwilioSignature, extractInboundMessage, buildTwiMLReply } from './whatsapp.js';
import { enqueueInbound, logMessage, adminDashboard, saveOffering, updateOffering, setOrderStatusAdmin, updateSettingsAdmin, localDate } from './db.js';
import { runOrderingAgent } from './agent.js';
import { startWorker, stopWorker } from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'food-whatsapp-ai-agent',
  whatsappProvider: 'twilio',
  twilioReplyMode: config.twilioReplyMode,
}));

// Twilio sends inbound WhatsApp messages as application/x-www-form-urlencoded.
// For Sandbox testing, TWILIO_REPLY_MODE=twiml processes the AI synchronously and
// returns the AI text in TwiML. This avoids a separate outbound Messages API call.
// For async/production operation, TWILIO_REPLY_MODE=rest queues the message and
// lets the worker send the reply through Twilio's Messages REST API.
app.post('/webhook/whatsapp', async (req, res) => {
  if (config.nodeEnv === 'production') {
    const signature = req.get('x-twilio-signature');
    if (!verifyTwilioSignature(signature, req.body)) return res.sendStatus(401);
  }

  try {
    const message = extractInboundMessage(req.body);
    if (!message) {
      return res.status(200).type('text/xml').send(buildTwiMLReply(''));
    }

    if (config.twilioReplyMode === 'twiml') {
      await logMessage({
        phone: message.phone,
        direction: 'inbound',
        body: message.body,
        waMessageId: message.waMessageId,
      });

      const result = await runOrderingAgent({
        phone: message.phone,
        customerName: message.customerName,
        body: message.body,
        waMessageId: message.waMessageId,
      });

      // Prefix with the inbound SID so Twilio retries cannot create duplicate log rows.
      await logMessage({
        phone: message.phone,
        direction: 'outbound',
        body: result.text,
        waMessageId: `twiml-${message.waMessageId}`,
      });

      console.log(`[TWIML WhatsApp -> ${message.phone}] ${result.text}`);
      return res.status(200).type('text/xml').send(buildTwiMLReply(result.text));
    }

    await enqueueInbound(message);
    return res.status(200).type('text/xml').send(buildTwiMLReply(''));
  } catch (error) {
    console.error('WhatsApp webhook failed:', error);
    // Return a customer-facing TwiML fallback in synchronous Sandbox mode.
    if (config.twilioReplyMode === 'twiml') {
      return res.status(200).type('text/xml').send(
        buildTwiMLReply('Sorry, I could not process that message right now. Please try again in a moment.')
      );
    }
    return res.sendStatus(500);
  }
});

function adminAuth(req, res, next) {
  const bearer = req.get('authorization') || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : req.get('x-admin-token');
  if (token !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try { res.json(await adminDashboard(req.query.date || localDate())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/offerings', adminAuth, async (req, res) => {
  try { res.status(201).json(await saveOffering(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/admin/offerings/:id', adminAuth, async (req, res) => {
  try { res.json(await updateOffering(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
  try { res.json(await setOrderStatusAdmin(req.params.id, req.body.status)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json(await updateSettingsAdmin(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (_req, res) => res.redirect('/admin.html'));

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Food WhatsApp AI Agent listening on port ${config.port}`);
  console.log(`Twilio reply mode: ${config.twilioReplyMode}`);

  if (config.twilioReplyMode === 'rest') {
    startWorker().catch(err => {
      console.error('Worker crashed:', err);
      process.exitCode = 1;
    });
  } else {
    console.log('Inbound worker disabled; replies are returned synchronously with TwiML.');
  }
});

function shutdown() {
  stopWorker();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { config } from './config.js';
import { claimNextInbound, completeInbound, retryInbound, logMessage } from './db.js';
import { runOrderingAgent } from './agent.js';
import { sendWhatsAppText } from './whatsapp.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;

export function stopWorker() { stopping = true; }

export async function startWorker() {
  console.log('Inbound worker started');
  while (!stopping) {
    let job = null;
    try {
      job = await claimNextInbound();
      if (!job) {
        await sleep(config.workerPollMs);
        continue;
      }

      // Log after claim; database uniqueness on inbound WA message prevents duplicate jobs.
      await logMessage({ phone: job.phone, direction: 'inbound', body: job.body, waMessageId: job.wa_message_id });

      const result = await runOrderingAgent({
        phone: job.phone,
        customerName: job.customer_name,
        body: job.body,
        waMessageId: job.wa_message_id,
      });

      const wa = await sendWhatsAppText(job.phone, result.text);
      const outboundId = wa?.id || null;
      await logMessage({ phone: job.phone, direction: 'outbound', body: result.text, waMessageId: outboundId });
      await completeInbound(job.id);
    } catch (error) {
      console.error('Worker job failed:', error);
      if (job?.id) {
        try { await retryInbound(job.id, Number(job.attempts || 1), error.message); }
        catch (retryError) { console.error('Failed to record retry:', retryError); }
      } else {
        await sleep(config.workerPollMs);
      }
    }
  }
}

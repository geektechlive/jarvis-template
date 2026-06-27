import { log } from 'ion-sdk'
import type { IonContext, WebhookRequest, WebhookResponse } from 'ion-sdk'
import { logEvent } from '../memory/episodic'
import { runUnifiWatch, runSecurityAnalystAlert, runObservabilityAlert } from '../scheduler'

type Severity = 'critical' | 'warning' | 'info'

export function sanitizeForStorage(text: string): string {
  return text
    .replace(/[<>`]/g, '')
    .replace(/\[INST\]/gi, '')
    .replace(/<\|system\|>/gi, '')
    .replace(/\\n\\nHuman:/gi, '')
    .replace(/\\n\\nAssistant:/gi, '')
}

export function classifySeverity(body: Record<string, unknown>): Severity {
  const key = String(body['key'] ?? body['event'] ?? '').toLowerCase()
  const msg = String(body['message'] ?? body['msg'] ?? '').toLowerCase()

  // IDS/IPS threat, WAN down, honeypot trigger
  if (
    key.includes('ids') ||
    key.includes('ips') ||
    key.includes('threat') ||
    key.includes('honeypot') ||
    key.includes('wan_offline') ||
    key.includes('wan_down') ||
    msg.includes('threat') ||
    msg.includes('ids alert') ||
    msg.includes('honeypot')
  ) {
    return 'critical'
  }

  // Device offline, adoption failed, unknown client
  if (
    key.includes('disconnect') ||
    key.includes('offline') ||
    key.includes('adoption_failed') ||
    key.includes('unknown_client') ||
    msg.includes('disconnected') ||
    msg.includes('offline')
  ) {
    return 'warning'
  }

  return 'info'
}

export async function handleUnifiWebhook(_ctx: IonContext, req: WebhookRequest): Promise<WebhookResponse> {
  let body: Record<string, unknown>
  try {
    body = req.json<Record<string, unknown>>()
  } catch {
    return { status: 400, body: 'invalid json' }
  }

  const severity = classifySeverity(body)
  const eventType = String(body['key'] ?? body['event'] ?? 'unknown')
  const payloadSummary = sanitizeForStorage(req.text().slice(0, 500))

  logEvent('', 'unifi_webhook', { severity, event_type: eventType, payload_summary: payloadSummary })
  log.info('webhooks: unifi event received', { severity, event_type: eventType })

  if (severity === 'critical') {
    void runUnifiWatch().catch((err: unknown) => {
      log.warn('webhooks: unifi_watch trigger failed', { err: String(err) })
      logEvent('', 'unifi_webhook_failed', { type: 'unifi_watch', err: String(err) })
    })
    void runSecurityAnalystAlert().catch((err: unknown) => {
      log.warn('webhooks: security_analyst alert failed', { err: String(err) })
      logEvent('', 'unifi_webhook_failed', { type: 'security_analyst', err: String(err) })
    })
  } else if (severity === 'warning') {
    void runObservabilityAlert().catch((err: unknown) => {
      log.warn('webhooks: observability alert failed', { err: String(err) })
    })
  }

  return { status: 200, body: 'ok' }
}

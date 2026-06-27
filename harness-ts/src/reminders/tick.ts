import { dueReminders, markReminderFired, requeueReminder, escalateReminder, storePendingReminder, lastMessageTs, logEvent } from '../memory/episodic'
import { log, type IonContext } from 'ion-sdk'
import { publishReminder } from '../resources/reminder'
import { classifyUrgency, nextEscalationAt } from './escalation'

const ACTIVE_WINDOW_MS = 5 * 60 * 1000

export async function tickReminders(ctx: IonContext): Promise<void> {
  const due = dueReminders()
  for (const row of due) {
    if (!markReminderFired(row.id)) continue  // idempotency: only deliver if this call wins CAS
    let delivered = false
    let deliveryPath: 'pending' | 'push' = 'push'
    try {
      const lastMsg = lastMessageTs()
      const isActive =
        lastMsg != null && Date.now() - new Date(lastMsg).getTime() < ACTIVE_WINDOW_MS
      if (isActive) {
        deliveryPath = 'pending'
        storePendingReminder(row.message)   // before_prompt hook picks this up on next user turn
      } else {
        await publishReminder(row.id, row.message, ctx)
      }
      delivered = true
    } catch (err) {
      // Delivery failed after CAS win: requeue so the next tick retries.
      // requeueReminder increments attempts and flips to 'failed' at cap (3).
      const outcome = requeueReminder(row.id)
      if (outcome === 'failed') {
        log.error('reminders: delivery permanently failed after max attempts', { id: row.id, err: String(err) })
      } else {
        log.warn('reminders: delivery failed, requeued for retry', { id: row.id, err: String(err) })
      }
    }

    // Telemetry: reminder delivery is otherwise invisible (resources/reminder.ts
    // and escalation.ts emit no agent_events row). Without this, "my reminder
    // didn't fire" can only be diagnosed by SSHing to the Mini and reading the
    // reminders table. Emitted OUTSIDE the delivery try (like escalation below)
    // so a telemetry persistence error can never be mistaken for a delivery
    // failure and trigger a wrong requeue + re-deliver.
    if (delivered) {
      try {
        logEvent('_tick_reminders', 'reminder_fired', {
          id: row.id,
          path: deliveryPath,
          escalation_level: row.escalation_level,
          escalation_cap: row.escalation_cap,
        })
      } catch (err) {
        log.warn('reminders: reminder_fired telemetry failed', { id: row.id, err: String(err) })
      }
    }

    // #542: escalating reminders re-fire on an urgency-tiered schedule until
    // their cap is hit. Runs ONLY after a successful delivery, and OUTSIDE the
    // delivery try -- so a persistence error here can never be mistaken for a
    // delivery failure (which would wrongly requeue + re-deliver). markReminderFired
    // already set status='fired'; for a still-escalating reminder we flip it back
    // to pending with a future next_remind_at (deferred out of overnight quiet
    // hours). A one-shot reminder (cap 0) or one at its cap stays terminally 'fired'.
    if (delivered && row.escalation_cap > 0 && row.escalation_level < row.escalation_cap) {
      try {
        const tier = classifyUrgency(
          new Date(row.fire_at).getTime() - new Date(row.created_at).getTime(),
        )
        const nextLevel = row.escalation_level + 1
        const next = nextEscalationAt(tier, nextLevel, new Date())
        escalateReminder(row.id, next)
        log.info('reminders: escalated', {
          id: row.id, tier, level: nextLevel, next_remind_at: next.toISOString(),
        })
      } catch (err) {
        // Escalation persistence failed after a delivered reminder. Leave it
        // terminally 'fired' rather than risk a double-delivery; the reminder
        // was still delivered this cycle.
        log.warn('reminders: escalation re-queue failed, leaving fired', { id: row.id, err: String(err) })
      }
    }
  }
}

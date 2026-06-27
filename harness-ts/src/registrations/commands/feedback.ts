import type { IonSDK } from 'ion-sdk'
import { logEvent } from '../../memory/episodic'
import { remember } from '../../memory/recall'

// Feedback slash commands: /feedback, /correct, /prefer, /endorse, /escalate.
// All feedback domain events are logged with session='' so recentEvents('', ...)
// in promptPipeline.ts picks them up for injection into the system prompt.
export function registerFeedbackCommands(ion: IonSDK): void {
  ion.registerCommand('feedback', {
    description: 'Rate this session 1-5 with an optional note. Usage: /feedback <1-5> [note]',
    execute: async (args) => {
      const trimmed = args.trim()
      if (!trimmed) {
        logEvent('feedback', 'inbox_item', { routine: 'feedback', text: 'Usage: /feedback <1-5> [note]' })
        return
      }
      const parts = trimmed.split(/\s+/)
      const first = parts[0] ?? ''
      const n = parseInt(first, 10)
      if (isNaN(n) || n < 1 || n > 5) {
        logEvent('feedback', 'inbox_item', {
          routine: 'feedback',
          text: `Invalid rating "${first}". Provide a number from 1 to 5.`,
        })
        return
      }
      const note = parts.slice(1).join(' ')
      logEvent('', 'feedback_rating', { rating: n, note: note, ts: new Date().toISOString() })
      logEvent('feedback', 'inbox_item', {
        routine: 'feedback',
        text: `Rating ${n}/5 logged${note ? ': ' + note : ''}. Thank you.`,
      })
    },
  })

  ion.registerCommand('correct', {
    description: 'Correct something about my behaviour. Usage: /correct <what was wrong>',
    execute: async (args) => {
      const text = args.trim()
      if (!text) {
        logEvent('correct', 'inbox_item', { routine: 'correct', text: 'Usage: /correct <what was wrong>' })
        return
      }
      logEvent('', 'feedback_correction', {
        text,
        detector: 'manual',
        confidence: 1.0,
        ts: new Date().toISOString(),
      })
      try {
        await remember(text, 'user_profile', 'correction', 'user')
      } catch {
        // vec server may be down -- correction is already in episodic
      }
      logEvent('correct', 'inbox_item', {
        routine: 'correct',
        text: "Correction noted. I'll apply this going forward.",
      })
    },
  })

  ion.registerCommand('prefer', {
    description: 'State a preference for me to remember. Usage: /prefer <your preference>',
    execute: async (args) => {
      const text = args.trim()
      if (!text) {
        logEvent('prefer', 'inbox_item', { routine: 'prefer', text: 'Usage: /prefer <your preference>' })
        return
      }
      logEvent('', 'feedback_preference', { text, ts: new Date().toISOString() })
      try {
        const res = await remember(text, 'user_profile', 'preference', 'user')
        if (!res.ok) {
          logEvent('prefer', 'inbox_item', {
            routine: 'prefer',
            text: `Preference logged locally (vec server unavailable: ${res.reason}).`,
          })
          return
        }
      } catch {
        // vec server may be down -- preference is already in episodic
      }
      logEvent('prefer', 'inbox_item', { routine: 'prefer', text: 'Preference stored.' })
    },
  })

  ion.registerCommand('endorse', {
    description: 'Endorse the last action or a named target. Usage: /endorse [target]',
    execute: async (args) => {
      const target = args.trim()
      logEvent('', 'feedback_endorsement', {
        target: target || 'last_action',
        ts: new Date().toISOString(),
      })
      logEvent('endorse', 'inbox_item', {
        routine: 'endorse',
        text: `Endorsement noted${target ? ' for: ' + target : ''}.`,
      })
    },
  })

  ion.registerCommand('escalate', {
    description: 'Flag something as a priority concern. Usage: /escalate <reason>',
    execute: async (args) => {
      const reason = args.trim()
      if (!reason) {
        logEvent('escalate', 'inbox_item', { routine: 'escalate', text: 'Usage: /escalate <reason>' })
        return
      }
      logEvent('', 'feedback_escalation', { reason, ts: new Date().toISOString() })
      logEvent('', 'inbox_item', {
        routine: 'feedback',
        text: 'Escalation: ' + reason,
        priority: 0.9,
      })
      logEvent('escalate', 'inbox_item', {
        routine: 'escalate',
        text: "Escalated. I'll treat this with priority.",
      })
    },
  })
}

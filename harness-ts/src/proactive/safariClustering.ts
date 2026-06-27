// Proactive trigger: Safari research cluster detection.
// Fires when the user has read 5+ pages on the same domain in the last hour.
// Per-domain cooldown of 4 hours is managed internally (not by the engine).
// Informational only -- no action required from the user.

import { log } from 'ion-sdk'
import { logEvent, recentEvents } from '../memory/episodic'
import { summariseSafari } from '../ambient/safari'
import { buildRichEmbed } from '../discord/format'
import { postProactive } from './notify'

const MIN_PAGE_COUNT = 5
const COOLDOWN_HOURS = 4

export async function safariClustering(): Promise<boolean> {
  const summary = summariseSafari(1)

  const qualifying = summary.domainsAggregated.filter((d) => d.count >= MIN_PAGE_COUNT)

  if (qualifying.length === 0) {
    log.debug('proactive: safariClustering -- no qualifying domains', {
      total: summary.domainsAggregated.length,
    })
    return false
  }

  let fired = false

  for (const { domain, count, sampleTitle: _sampleTitle } of qualifying) {
    const cooldownKey = `safari_clustering:${domain}`
    const recent = recentEvents(cooldownKey, 'proactive_fired', COOLDOWN_HOURS)
    if (recent.length > 0) {
      log.debug('proactive: safariClustering -- domain on cooldown', { domain })
      continue
    }

    const narrative = `${count} visit${count === 1 ? '' : 's'} in the past hour. Worth filing a note?`

    const embed = buildRichEmbed({
      emoji: '🔍',
      title: `Research cluster: ${domain}`,
      subtitle: '',
      badges: [],
      narrative,
      color: 0x57f287,
      footerText: `Reply \`note ${domain}\` to file a research note or \`skip ${domain}\` to suppress for 4 hours.`,
    })

    await postProactive(null, { embed })

    logEvent(cooldownKey, 'proactive_fired', {
      trigger: 'safari_clustering',
      domain,
      count,
    })

    log.info('proactive: safariClustering -- fired', { domain, count })
    fired = true
  }

  return fired
}

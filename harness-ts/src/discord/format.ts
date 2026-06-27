// Rich Discord embed builder shared by all autonomy-loop notifications.
// Pure function: no IO, no global state. Produces a DiscordEmbed whose
// description holds the formatted markdown (bold sub-headings, narrative,
// badge line, sections, bullets, footer links).
//
// Modeled on the ion-ops release-bot layout: bold sub-headlines + narrative
// paragraphs + inline-code identifiers, instead of sparse key/value fields.

import type { DiscordEmbed } from './webhook'

// Discord embed.description hard limit.
const DESCRIPTION_LIMIT = 4096
// Per-section soft caps (trimmed before assembly so the most important parts
// always survive truncation at the description level).
const NARRATIVE_LIMIT = 800
const SECTION_BODY_LIMIT = 600
const BULLET_LIMIT = 200

export interface RichEmbedSection {
  heading: string
  body: string
}

export interface RichEmbedBullet {
  label: string                 // pre-formatted; caller adds backticks where wanted
  description?: string
}

export interface RichEmbedFooterLink {
  name: string                  // e.g. "Diff", "Issue", "Run"
  url: string
}

export interface RichEmbedParts {
  emoji: string                              // ✅ ⏳ 🔍 ❌ 💤
  title: string                              // becomes embed.title (bold above description)
  subtitle?: string | undefined              // bold first line of description
  narrative?: string | undefined             // 2–4 sentence prose
  badges?: string[] | undefined              // single ·-separated line under the subtitle
  sectionsHeading?: string | undefined       // bold label rendered once above all sections
  sections?: RichEmbedSection[] | undefined  // bold heading + body each
  bulletsHeading?: string | undefined        // bold label rendered once above all bullets
  bullets?: RichEmbedBullet[] | undefined
  footerText?: string | undefined            // standalone footer line (plain text, no bold)
  footerLinks?: RichEmbedFooterLink[] | undefined
  color: number
}

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Truncate at a word boundary and append an ellipsis only when actually cut.
// Unlike a raw slice, this never leaves a half-word like "tunnel st" dangling.
// Falls back to a hard cut when there is no whitespace within the budget.
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const lastSpace = head.lastIndexOf(' ')
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head
  return cut.trimEnd() + '…'
}

function escapeBacktick(s: string): string {
  // Defensive — backticks inside our markup get escaped so they don't
  // accidentally close an inline-code span set up earlier in the body.
  return s.replace(/`/g, 'ˋ')
}

export function buildRichEmbed(parts: RichEmbedParts): DiscordEmbed {
  const lines: string[] = []

  if (parts.subtitle) {
    lines.push(`**${escapeBacktick(parts.subtitle).trim()}**`)
  }

  if (parts.badges && parts.badges.length > 0) {
    lines.push(parts.badges.map(b => b.trim()).filter(Boolean).join(' · '))
  }

  if (parts.narrative) {
    lines.push('')
    lines.push(clamp(parts.narrative.trim(), NARRATIVE_LIMIT))
  }

  if (parts.sections && parts.sections.length > 0) {
    if (parts.sectionsHeading) {
      lines.push('')
      lines.push(`**${parts.sectionsHeading.trim()}**`)
    }
    for (const s of parts.sections) {
      lines.push('')
      lines.push(`**${s.heading.trim()}**`)
      lines.push(clamp(s.body.trim(), SECTION_BODY_LIMIT))
    }
  }

  if (parts.bullets && parts.bullets.length > 0) {
    lines.push('')
    if (parts.bulletsHeading) {
      lines.push(`**${parts.bulletsHeading.trim()}**`)
    }
    for (const b of parts.bullets) {
      const label = clamp(b.label.trim(), BULLET_LIMIT)
      const desc = b.description ? ` — ${clamp(b.description.trim(), BULLET_LIMIT)}` : ''
      lines.push(`• ${label}${desc}`)
    }
  }

  if (parts.footerText) {
    lines.push('')
    lines.push(parts.footerText.trim())
  }

  if (parts.footerLinks && parts.footerLinks.length > 0) {
    lines.push('')
    for (const link of parts.footerLinks) {
      lines.push(`${link.name}: ${link.url}`)
    }
  }

  const description = clamp(lines.join('\n'), DESCRIPTION_LIMIT)

  return {
    title: clamp(`${parts.emoji} ${parts.title}`.trim(), 256),
    description,
    color: parts.color,
  }
}

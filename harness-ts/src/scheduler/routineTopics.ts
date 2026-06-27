// Shared routine topic map — used by both the prospective gap probe (scheduler)
// and the pre-routine gap probe (proactive engine).
//
// routine ID -> context query string for memory recall.

export const ROUTINE_TOPICS: Record<string, string> = {
  morning_brief:           'morning priorities calendar schedule',
  midday_checkin:          'open items tasks follow-ups',
  evening_journal:         'today accomplishments decisions people',
  overnight_reflection:    'patterns insights week review',
  weekly_curator:          'knowledge patterns weekly themes',
  wellness_checkin:        'energy wellbeing stress calendar density interests::wellness',
  // weekly_newsdesk: omitted — agent does its own recall + web search;
  // a static probe query doesn't match rss_fetch knowledge entries well enough.
  tech_advisor_watch:      'technology tools software decisions interests::tech',
  cfo_watch:               'finances spending subscriptions charges interests::finance',
  portfolio_watch:         'investments portfolio stocks market interests::finance',
  security_watch:          'security vulnerabilities credentials',
  github_watch:            'pull requests issues code review',
  infra_watch:             'infrastructure network Cloudflare UniFi',
  contacts_pulse:          'relationships contacts birthdays',
  home_maintenance_check:  'home maintenance property',
  weekly_entertainment:    'entertainment movies shows recommendations',
  weekly_doc_triage:       'documents files downloads organization',
  commit_activity_summary: 'commits code changes activity summary',
  meeting_prep:            'upcoming meetings calendar events people',
}

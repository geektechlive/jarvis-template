// Pure, dependency-free name normalization. Extracted from roster.ts so that
// low-level modules (memory/episodic, openThreads) can normalize agent names in
// analytics without importing roster.ts (which pulls in config + ion-sdk).
//
// Agent file stems and subagent ids may mix hyphens and underscores. Normalize
// both to hyphens (lowercase) so lookups and usage analytics are stable
// regardless of caller convention (e.g. "Personal_CFO" and "personal-cfo" must
// resolve to the same key).
export function normalizeAgentName(name: string): string {
  return name.trim().replace(/_/g, '-').toLowerCase()
}

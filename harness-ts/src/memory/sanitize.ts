/**
 * Sanitize recalled memory strings to prevent prompt injection.
 *
 * Ingested content (mail, webhooks, prior LLM outputs) can contain control
 * tokens or role-change sequences that model tokenizers treat as structural.
 * Strip them before inserting into the system prompt.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /<\|system\|>/gi,
  /<\|user\|>/gi,
  /<\|assistant\|>/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /\n\nHuman:/g,
  /\n\nAssistant:/g,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  // Llama 3
  /<\|begin_of_text\|>/gi,
  /<\|start_header_id\|>/gi,
  /<\|end_header_id\|>/gi,
  /<\|eot_id\|>/gi,
  // Gemma
  /<start_of_turn>/gi,
  /<end_of_turn>/gi,
  // GPT / tiktoken
  /<\|endoftext\|>/gi,
]

function stripInjectionPatterns(text: string): string {
  let out = text
  for (const re of INJECTION_PATTERNS) {
    out = out.replace(re, '')
  }
  return out
}

/** Strip tokenizer control sequences from recalled memory before system-prompt injection. */
export function sanitizeRecalled(text: string): string {
  return stripInjectionPatterns(text)
}

/**
 * Strip tokenizer control sequences from untrusted external content (mail, webhooks,
 * calendar events, tool results) before the text is inserted into a prompt.
 * Functionally identical to sanitizeRecalled — the distinct name signals the call site
 * is an ingestion boundary, not a recall path.
 */
export function sanitizeUntrusted(text: string): string {
  return stripInjectionPatterns(text)
}

/**
 * High-precision credential/secret detectors. Used to keep secrets OUT of durable
 * memory: a candidate fact that trips one of these is dropped, never stored. This is
 * a write-path safety net behind the extraction prompt (which is told not to extract
 * secrets) — it catches model slips. Precision is favored over recall: a false
 * positive drops one (rare) legit fact, an acceptable cost to never persist a key.
 *
 * Live examples this exists to stop (found polluting the knowledge collection):
 *   "Alex's UniFi controller ... rejecting API key ph1f6EPyOW... with 401"
 *   "Alex uses an Amex card ending 7877."
 *   "Commit af29480 contains a hardcoded OpenRouter API key (sk-or-v1-EXAMPLE0000000000000000...)."
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/i, // Anthropic API keys (sk-ant-api03-...)
  /\bsk-(?:or-)?(?:v\d-)?[A-Za-z0-9]{16,}/i, // OpenAI / OpenRouter API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google API key
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab PAT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i, // bearer token
  // "api key <longtoken>" / "secret: <token>" / "token=<token>" -- 12+ char value
  /\b(?:api[_\s-]?keys?|secret|token|access[_\s-]?key)\b[\s:=]+['"]?[A-Za-z0-9_-]{12,}/i,
  /\b(?:password|passwd|pwd)\b\s*[:=]\s*\S{4,}/i, // explicit password=value
  /(?:\b\d[ -]?){13,19}\b/, // card PAN (13-19 digits, optional space/dash separators)
  /\bcard\s+(?:number|ending)\b[:#\s]*\d{4,}/i, // "card ending 7877"
]

/**
 * True when `text` contains high-confidence credential/secret material that must
 * never be persisted to durable memory. Callers should skip storing such facts.
 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text))
}

/**
 * Detectors for self-identity statements about Jarvis -- that he is (or is not) a
 * "Claude Code session", "the Mini", running on a Mac Mini, an LLM, etc. These are
 * usually the principal correcting Jarvis mid-conversation. They must never be
 * stored as durable facts: when later recalled they re-inject the forbidden
 * vocabulary into Jarvis's own prompt and re-prime the exact identity break they
 * were meant to fix (a feedback loop). Match NARROWLY on Jarvis-identity framing,
 * not every mention of "Claude Code" -- the episodic_journal legitimately records
 * dev work where "Claude Code" is a real subject ("fixed the Claude Code bug").
 *
 * Live example this exists to stop (found being recalled every turn):
 *   "you are not claude code. you are jarvis. ... why do you think you are in a
 *    clause code ses..."
 */
const AGENT_IDENTITY_PATTERNS: RegExp[] = [
  // "you are / you're / I am / Jarvis is" (optionally negated) "... claude code"
  // ("clause" covers the common typo seen in the stored correction).
  /\b(?:you|i|jarvis)\s*(?:'?re|'?m|\s+am|\s+are|\s+is)?\s+(?:not\s+)?(?:a |an |the )?(?:claude|clause)\s*code\b/i,
  // "(a|the) Claude Code (CLI) session" framing
  /\b(?:claude|clause)\s*code\s+(?:cli\s+)?session\b/i,
  // "you are the Mini" / "you are the Mac Mini"
  /\byou'?(?:re|\s+are)\s+(?:the\s+|a\s+)?(?:mac\s+)?mini\b/i,
  // "you are running on a Mac Mini / as an ion session"
  /\byou\s+are\s+(?:running|operating)\s+(?:on|as)\s+(?:a |an |the )?(?:mac\s+mini|ion|claude)\b/i,
  // "you are an ion (engine) session" / "you are a session on the Mac Mini"
  /\byou\s+are\s+(?:a |an |the )?ion\b/i,
  /\byou\s+are\s+(?:a |an |the )?[\w\s]*session\s+on\s+the\s+(?:mac\s+mini|mini)\b/i,
]

/**
 * True when `text` is a self-identity statement about Jarvis (see above). Callers
 * on the memory write path should skip storing such "facts."
 */
export function looksLikeAgentIdentityClaim(text: string): boolean {
  return AGENT_IDENTITY_PATTERNS.some((re) => re.test(text))
}

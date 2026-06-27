// Parse a bullet or numbered list from LLM output into an array of strings.
// Handles: "- item", "1. item", "10. item" (multi-digit numbers).
// Authoritative implementation -- import from here, do not inline.
export function parseList(text: string): string[] {
  const results: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const numMatch = /^(\d+)\.\s/.exec(line)
    if (numMatch) {
      const item = line.slice(numMatch[0].length).trim()
      if (item) results.push(item)
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      const item = line.slice(2).trim()
      if (item) results.push(item)
    }
  }
  return results
}

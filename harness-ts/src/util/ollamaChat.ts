// Minimal Ollama chat utility for one-off LLM calls from non-learning modules.

const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434'

interface OllamaMessage { role: 'system' | 'user' | 'assistant'; content: string }
interface OllamaChatResponse { message?: { content?: string } }

export async function ollamaOneShot(
  model: string,
  systemPrompt: string,
  userContent: string,
  timeoutMs = 30_000,
): Promise<string> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ]
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status}`)
  const data = (await res.json()) as OllamaChatResponse
  return data.message?.content?.trim() ?? ''
}

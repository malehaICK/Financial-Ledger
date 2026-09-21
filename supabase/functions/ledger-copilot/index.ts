// ledger-copilot — answers Copilot questions the in-app keyword answers can't handle.
//
// Ledger sends the question plus a short summary of the user's numbers (monthly totals,
// top categories, goals). No raw transactions or account details are sent. Only signed-in
// users can call this, so the free Gemini quota can't be used by strangers.
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   GEMINI_API_KEY  required, from https://aistudio.google.com/apikey
//   GEMINI_MODEL    optional, defaults to gemini-flash-latest
import { createSupabaseContext } from 'npm:@supabase/server'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const MAX_QUESTION = 500
const MAX_SUMMARY = 8000

const SYSTEM_PROMPT = `You are Ledger Financial Copilot, a friendly personal-finance helper inside the Ledger budgeting app.
Answer using the user's financial summary provided below. Rules:
- Use only the numbers in the summary. Never invent transactions, balances or figures.
- If the summary doesn't contain what's needed, say so and suggest what to record or import in Ledger.
- Averages and forecasts are estimates, not guarantees; say so when you use them.
- Keep answers short: 2 to 6 sentences, or a few "• " bullet lines. Plain text only, no markdown, no headings, no asterisks.
- Be practical and non-judgmental. Give general guidance, not professional financial, tax or legal advice.
- If the user just greets or thanks you, reply warmly in one sentence and suggest a question they could ask.
- If the question is unrelated to money or budgeting, briefly say you can only help with finances.`

export default {
  fetch: async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const { data: ctx, error: authError } = await createSupabaseContext(req, { auth: 'user' })
    if (authError || !ctx) return json({ error: 'Please sign in again.' }, authError?.status ?? 401)

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {
      // Names only, never values: helps spot a secret saved under the wrong name.
      const custom = Object.keys(Deno.env.toObject()).filter((k) => !/^(SUPABASE_|SB_|DENO_|PATH$|HOME$|HOSTNAME$)/.test(k))
      console.error('GEMINI_API_KEY is not set. Other custom secrets:', custom.join(', ') || '(none)')
      return json({ error: 'The Copilot AI isn’t set up yet.' }, 503)
    }

    let body: { question?: unknown; summary?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid request.' }, 400)
    }

    const question = String(body.question ?? '').trim().slice(0, MAX_QUESTION)
    const summary = JSON.stringify(body.summary ?? {}).slice(0, MAX_SUMMARY)
    if (!question) return json({ error: 'Ask a question first.' }, 400)

    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest'
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: `My financial summary:\n${summary}\n\nMy question: ${question}` }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
      }),
    })

    if (!res.ok) {
      console.error('Gemini error', res.status, await res.text())
      return json({ error: res.status === 429 ? 'The Copilot is busy right now. Try again in a minute.' : 'The Copilot couldn’t answer right now.' }, 502)
    }

    const data = await res.json()
    const answer = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? '')
      .join('')
      .trim()
    if (!answer) return json({ error: 'The Copilot couldn’t answer that one.' }, 502)
    return json({ answer })
  },
}

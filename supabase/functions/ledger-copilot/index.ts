
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
const MAX_HISTORY = 10
const MAX_TURN = 1200

const SYSTEM_PROMPT = `You are Ledger Financial Copilot, a friendly personal-finance helper inside the Ledger budgeting app.
Answer using the user's financial summary provided below. Rules:
- Use only the numbers in the summary. Never invent transactions, balances or figures.
- If the summary doesn't contain what's needed, say so and suggest what to record or import in Ledger.
- Averages and forecasts are estimates, not guarantees; say so when you use them.
- Keep answers short: 2 to 6 sentences, or a few "• " bullet lines. Plain text only, no markdown, no headings, no asterisks.
- Be practical and non-judgmental. Give general guidance, not professional financial, tax or legal advice.
- If the user just greets or thanks you, reply warmly in one sentence and suggest a question they could ask.
- If the question is unrelated to money or budgeting, briefly say you can only help with finances.
- You can see the recent conversation. Read the new question in that context: "it", "this" or "the file" usually means what was just discussed.
- summary.recent_upload describes the file the user just uploaded in the chat: how many income and expense rows Ledger found, the months, and a sample of rows. Use it when they ask about the file.

How Ledger works, for explaining things:
- A CSV saved from a spreadsheet (Excel, Google Sheets) contains only the sheet that was open, so income on another sheet is not in the file. The fix is to save that sheet as CSV too and upload it.
- Uploaded statements open in a review table in the Budget tab, where each row's Type (Income or Expense) and Category can be changed before tapping Add.
- Saved entries can be edited with the pencil or deleted with the cross on their row in the Budget tab.
- In this chat the user can type an entry ("I spent $20 on groceries") or upload a receipt, pay stub, statement or CSV with the paperclip button.`

export default {
  fetch: async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const { data: ctx, error: authError } = await createSupabaseContext(req, { auth: 'user' })
    if (authError || !ctx) return json({ error: 'Please sign in again.' }, authError?.status ?? 401)

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) return json({ error: 'The Copilot AI isn’t set up yet.' }, 503)

    let body: { question?: unknown; summary?: unknown; history?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid request.' }, 400)
    }

    const question = String(body.question ?? '').trim().slice(0, MAX_QUESTION)
    const summary = JSON.stringify(body.summary ?? {}).slice(0, MAX_SUMMARY)
    if (!question) return json({ error: 'Ask a question first.' }, 400)

    const turns: { role: 'user' | 'model'; parts: { text: string }[] }[] = []
    for (const t of Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : []) {
      const role = (t as { role?: unknown })?.role === 'model' ? 'model' : 'user'
      const text = String((t as { text?: unknown })?.text ?? '').trim().slice(0, MAX_TURN)
      if (!text) continue
      const last = turns[turns.length - 1]
      if (last && last.role === role) last.parts[0].text += '\n\n' + text
      else turns.push({ role, parts: [{ text }] })
    }
    if (turns[0]?.role === 'model') turns.unshift({ role: 'user', parts: [{ text: '(chat opened)' }] })
    if (turns.length && turns[turns.length - 1].role === 'user') turns.push({ role: 'model', parts: [{ text: '(no reply)' }] })

    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest'
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [...turns, { role: 'user', parts: [{ text: `My financial summary:\n${summary}\n\nMy question: ${question}` }] }],
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

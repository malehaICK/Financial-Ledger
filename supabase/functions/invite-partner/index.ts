
import { createSupabaseContext } from 'npm:@supabase/server'
import { createClient } from 'npm:@supabase/supabase-js@2'

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i


function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    const ok = url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return ok ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function publishableKey(): string {
  const keys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>
    return parsed.default ?? Object.values(parsed)[0]
  }
  return Deno.env.get('SUPABASE_ANON_KEY')!
}

export default {
  fetch: async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const { data: ctx, error: authError } = await createSupabaseContext(req, { auth: 'user' })
    if (authError || !ctx) return json({ error: 'Please sign in again.' }, authError?.status ?? 401)

    let body: { goal_id?: unknown; email?: unknown; redirect_to?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid request.' }, 400)
    }

    const goalId = String(body.goal_id ?? '')
    const email = String(body.email ?? '').trim().toLowerCase()
    if (!UUID_RE.test(goalId) || !EMAIL_RE.test(email)) {
      return json({ error: 'A valid goal and email address are required.' }, 400)
    }

    const callerId = ctx.userClaims?.id
    if (email === String(ctx.userClaims?.email ?? '').toLowerCase()) {
      return json({ error: 'You can’t invite yourself.' }, 400)
    }

    // Both lookups run as the caller, so Row Level Security still applies.
    const { data: goal } = await ctx.supabase
      .from('savings_goals')
      .select('id')
      .eq('id', goalId)
      .eq('user_id', callerId)
      .maybeSingle()
    if (!goal) return json({ error: 'Only the goal owner can send invites.' }, 403)

    const { data: member } = await ctx.supabase
      .from('goal_members')
      .select('id')
      .eq('goal_id', goalId)
      .eq('email', email)
      .maybeSingle()
    if (!member) return json({ error: 'That email isn’t a member of this goal.' }, 403)

    const redirectTo = safeRedirect(body.redirect_to)
    const { error: inviteError } = await ctx.supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { invited_to_goal: goal.id },
    })
    if (!inviteError) return json({ status: 'invited' })

    const alreadyRegistered =
      (inviteError as { code?: string }).code === 'email_exists' ||
      /already (been )?registered/i.test(inviteError.message)
    if (!alreadyRegistered) return json({ error: inviteError.message }, 502)


    const publicClient = createClient(Deno.env.get('SUPABASE_URL')!, publishableKey(), {
      auth: { persistSession: false },
    })
    const { error: linkError } = await publicClient.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    })
    if (linkError) return json({ error: linkError.message }, 502)
    return json({ status: 'existing_user' })
  },
}

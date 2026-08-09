export const runtime = 'nodejs';

// Emails allowed to use the AI endpoint — set ALLOWED_EMAILS (comma-separated)
// in .env.local and in Vercel. If unset, access is denied to everyone.
function allowedEmails() {
  const raw = process.env.ALLOWED_EMAILS;
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Verify the caller's Firebase ID token and check the email against the allowlist.
async function verifyCaller(req) {
  const authz = req.headers.get('authorization') || '';
  const m = authz.match(/^Bearer (.+)$/);
  if (!m) return { ok: false, code: 401, error: 'Sign in required.' };

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) return { ok: false, code: 500, error: 'Server auth is not configured.' };

  let res;
  try {
    res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: m[1] }),
    });
  } catch (e) {
    return { ok: false, code: 502, error: 'Could not verify sign-in.' };
  }
  if (!res.ok) return { ok: false, code: 401, error: 'Session expired — sign in again.' };

  const data = await res.json();
  const u = data.users && data.users[0];
  const email = ((u && u.email) || '').toLowerCase();
  const verified = u && (u.emailVerified === true || u.emailVerified === 'true');
  if (!email || !verified) return { ok: false, code: 403, error: 'Email is not verified.' };
  const allow = allowedEmails();
  if (!allow.length) return { ok: false, code: 500, error: 'AI allowlist not configured (set ALLOWED_EMAILS).' };
  if (!allow.includes(email)) return { ok: false, code: 403, error: 'This account isn’t allowed to use AI here.' };
  return { ok: true, email };
}

const ORGANIZE_SYS =
  "You turn a messy brain dump into a clean to-do list. Rules: split compound thoughts into separate tasks; merge obvious duplicates; rewrite each as a short, concrete, actionable task starting with a verb; keep the user's intent, do not invent tasks that were not implied; no numbering or bullets in the text. Respond with ONLY a JSON array of task strings, nothing else.";

const STEPS_SYS =
  "You break a single to-do item into a clear, ordered checklist of concrete next actions. Keep each step short and doable. Aim for 3-7 steps unless the task clearly needs more or fewer. Respond with ONLY a JSON array of step strings, nothing else.";

// Pull a JSON array of strings out of a model reply (tolerates code fences / prose).
function parseList(txt) {
  let s = (txt || '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a > -1 && b > a) s = s.slice(a, b + 1);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch (e) { /* fall through */ }
  return (txt || '')
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\]\s]+/, '').trim())
    .filter(Boolean);
}

export async function POST(req) {
  const gate = await verifyCaller(req);
  if (!gate.ok) return Response.json({ error: gate.error }, { status: gate.code });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return Response.json({ error: 'Server is missing ANTHROPIC_API_KEY.' }, { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const { action, text, instr, model } = body || {};
  if (!text || !text.trim()) {
    return Response.json({ error: 'Nothing to send.' }, { status: 400 });
  }

  const useModel = process.env.ANTHROPIC_MODEL || model || 'claude-sonnet-4-6';

  let system, user;
  if (action === 'organize') {
    system = ORGANIZE_SYS;
    user = 'Brain dump:\n' + text;
  } else if (action === 'steps') {
    system = STEPS_SYS;
    user = 'Task: "' + text + '"';
    if (instr && instr.trim()) user += '\n\nExtra instructions from the user: ' + instr.trim();
  } else {
    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  }

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) {
    return Response.json({ error: 'Could not reach Claude.' }, { status: 502 });
  }

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error && j.error.message ? j.error.message : ''; } catch (e) {}
    const msg = res.status === 401 ? 'Server API key is invalid.'
      : res.status === 429 ? 'Rate limited or out of credits.'
      : 'Claude error ' + res.status + (detail ? ': ' + detail : '');
    return Response.json({ error: msg }, { status: res.status });
  }

  const data = await res.json();
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return Response.json({ items: parseList(out) });
}

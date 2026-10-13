'use strict';

/* ============================================================
   DATABASE  (Upstash Redis over REST - no packages needed)
   ============================================================ */
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// KEY_PREFIX lets two projects share one free Redis database without mixing data.
const KEY_PREFIX = process.env.KEY_PREFIX || '';

async function redis(...args) {
  if (KEY_PREFIX && args.length > 1) args = [args[0], KEY_PREFIX + args[1], ...args.slice(2)];
  if (!RURL || !RTOKEN) throw new Error('Database not connected. In Vercel: Storage tab > add Upstash Redis.');
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

const parse = (v) => { try { return JSON.parse(v); } catch (e) { return v; } };
async function hgetall(key) {
  const a = (await redis('HGETALL', key)) || [];
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i]] = parse(a[i + 1]);
  return o;
}
const hset = (key, field, val) => redis('HSET', key, field, JSON.stringify(val));
async function hget(key, field) { const v = await redis('HGET', key, field); return v ? parse(v) : null; }
async function get(key) { const v = await redis('GET', key); return v ? parse(v) : null; }
const set = (key, val) => redis('SET', key, JSON.stringify(val));

/* ============================================================
   AUTH
   ============================================================ */
function authed(req) {
  const p = process.env.DASHBOARD_PASSWORD;
  return !!p && req.headers['x-auth'] === p;
}

/* ============================================================
   SETTINGS
   ============================================================ */
const DEFAULT_SETTINGS = {
  perDay: 100,
  cities: ['Raipur', 'Nagpur', 'Indore', 'Bhopal', 'Jaipur', 'Pune', 'Ahmedabad', 'Lucknow', 'Surat', 'Mumbai', 'Delhi', 'Bengaluru'],
  // Phrases searched on Freelancer.com. Someone who posted a project asking for these wants a website, so they are a lead.
  terms: [
    'need a website', 'build a website', 'website for my business', 'business website',
    'wordpress website', 'ecommerce website', 'shopify store', 'website redesign',
    'landing page', 'company website', 'portfolio website', 'website development',
  ],
};
async function getSettings() {
  const saved = (await get('settings')) || {};
  // Search phrases saved while this was a job-board scraper (e.g. "web developer") are dropped for the Freelancer phrases.
  if (Array.isArray(saved.terms) && saved.terms.some((t) => /developer|designer|executive|engineer/i.test(t))) delete saved.terms;
  return { ...DEFAULT_SETTINGS, ...saved };
}
async function saveSettings(b) {
  const list = (x) => (Array.isArray(x) ? x : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 100);
  const cur = await getSettings();
  const next = {
    perDay: Math.min(300, Math.max(1, parseInt(b.perDay, 10) || cur.perDay)),
    cities: list(b.cities).length ? list(b.cities) : cur.cities,
    terms: list(b.terms).length ? list(b.terms) : cur.terms,
  };
  await set('settings', next);
  return next;
}

/* ============================================================
   LEAD SOURCE
   1. A GitHub Action (scripts/scrape.py, official Freelancer.com SDK) finds
      people and businesses that posted a project on Freelancer.com asking for
      a website. Those buyers are the website leads.
   2. The Action sends them in small batches to /api/ingest.
   3. Here we filter agencies, then use Google Places ONLY to find the
      phone number (and website) of each business.
   ============================================================ */
// Same list as scripts/scrape.py (BLOCK_WORDS). A business whose NAME contains any of these words or
// phrases is removed. Matching is whole-word and case-insensitive, so "AI" blocks "AI Labs" but not "Rai Salon".
const BLOCK_WORDS = [
  'Technologies', 'Solutions', 'Systems', 'Digital', 'Innovations', 'Enterprises', 'Networks',
  'Consulting', 'Services', 'Tech', 'Labs', 'AI', 'AI Labs', 'Automations', 'Robotics',
  'Intelligence', 'Software', 'Digital Labs', 'Techworks', 'Media', 'Creative', 'Studios',
  'Marketing', 'Interactive', 'Agency', 'Designs', 'Productions', 'Communications', 'Growth',
  'Web', 'Webworks', 'Web Solutions', 'Web Technologies', 'Web Studio', 'Webcraft',
  'Digital Works', 'Codeworks', 'DevLabs', 'Web Systems', 'Ventures', 'Global', 'Group',
  'Works', 'Collective', 'Dynamics', 'Nexus', 'Sphere', 'Forge', 'Edge', 'Orbit', 'X', 'One',
  'AI Solutions', 'Automation Labs', 'AI Systems', 'Intelligent Systems', 'Agentic AI',
  'AI Works', 'Neural', 'Autopilot', 'Intelligence Labs', 'AI Innovations', 'Co.', 'HQ', 'IO',
  'OS', 'Hub', 'Flow', 'Stack', 'Sync', 'Base', 'Cloud', 'Grid',
  // agency words from the original Lead desk that are not in the list above
  'Agencies', 'SEO', 'Advertising', 'Branding', 'Infotech', 'Info Tech',
];
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const BAD_NAME = new RegExp(
  '(?<![A-Za-z0-9])(?:' + BLOCK_WORDS.slice().sort((a, b) => b.length - a.length).map(escRe).join('|') + ')(?![A-Za-z0-9])',
  'i'
);
const BAD_STAFF = /\b(staffing|recruit\w*|placements?|manpower|consultanc\w*|consultants?|hr\s?solutions?|talent|headhunt\w*|outsourc\w*|job\s?portal)\b/i;
const BAD_HOST = /(digital|marketing|seo|agency|webdesign|webdev|infotech|technolog|softwar)/i;
const BAD_TYPES = ['advertising_agency', 'marketing_agency', 'software_company', 'employment_agency'];

function isAgency(p, name) {
  if (BAD_NAME.test(name) || BAD_STAFF.test(name)) return true;
  if (p) {
    if ((p.types || []).some((t) => BAD_TYPES.includes(t)) || BAD_TYPES.includes(p.primaryType)) return true;
    if (p.websiteUri) {
      try { if (BAD_HOST.test(new URL(p.websiteUri).hostname)) return true; } catch (e) { /* ignore */ }
    }
  }
  return false;
}

function normPhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) { s = s.replace(/^0+/, ''); s = (process.env.DEFAULT_COUNTRY_CODE || '+91') + s; }
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

const slug = (x) => String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const STOP = new Set(['pvt', 'ltd', 'private', 'limited', 'llp', 'inc', 'the', 'and', 'india', 'co', 'company', 'corp', 'group']);
const tokens = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));

// Is the Google place really the same business as the company in the job post?
function sameBusiness(company, placeName) {
  const a = tokens(company), b = new Set(tokens(placeName));
  if (!a.length || !b.size) return false;
  const hit = a.filter((t) => b.has(t)).length;
  return hit >= Math.ceil(a.length / 2);
}

const PHONE_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.internationalPhoneNumber',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.types', 'places.primaryType', 'places.businessStatus',
].join(',');

// Google Places is used only here: company name + city -> phone number.
async function findPhone(company, city) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is missing');
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PHONE_FIELDS },
    body: JSON.stringify({ textQuery: company + ' ' + city, pageSize: 3, regionCode: process.env.PLACES_REGION || 'IN' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Google Places error');
  for (const p of j.places || []) {
    const nm = (p.displayName && p.displayName.text) || '';
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
    if (!sameBusiness(company, nm)) continue;
    const phone = normPhone(p.internationalPhoneNumber || p.nationalPhoneNumber);
    if (phone) return { place: p, phone, placeName: nm };
  }
  return null;
}

// A lead is kept only if its job title is about websites: web / frontend / full stack developers, WordPress,
// Shopify, PHP / Laravel, React / Angular / Vue, UI / UX and web designers. Graphic designers, product managers,
// SEO, Java / Python / Flutter engineers and the like are not web leads. Edit this one line to change that.
const WEB_ROLE = /\b(web|website|websites|wordpress|woocommerce|shopify|magento|wix|webflow|front[\s-]?end|full[\s-]?stack|mern|mean|react|reactjs|react\.js|angular|angularjs|vue|vuejs|vue\.js|next\.?js|nuxt|svelte|html|css|javascript|typescript|node\.?js|php|laravel|codeigniter|ui|ux|ui\s*\/\s*ux|ux\s*\/\s*ui)\b/i;
// Titles with these words are never web leads, even if they also mention a web word.
const NOT_WEB = /\b(graphic|graphics|video|editor|software\s+engineer)\b/i;
function isWebRole(title) {
  const t = String(title || '').trim();
  return !t || (WEB_ROLE.test(t) && !NOT_WEB.test(t)); // no title (manual lead): keep
}

const istDay = (t) => new Date((t || Date.now()) + 19800000).toISOString().slice(0, 10);

// How many leads have come in today (IST), counting ones that were removed afterwards. Saved, so removing
// non-web leads never frees up room for new ones that day.
async function dayUsed(existing) {
  const today = istDay();
  const d = (await get('day')) || {};
  const used = Math.max(d.date === today ? Number(d.count) || 0 : 0, existing.filter((l) => istDay(l.createdAt) === today).length);
  await set('day', { date: today, count: used });
  return used;
}

// Removes leads (still marked "new") whose job title is not about websites, and remembers them for 30 days
// so they are not brought back by a later run.
// Leads from the old job-board scraper (Indeed / Naukri / LinkedIn) are cleared; Freelancer leads are kept.
const OLD_SOURCES = new Set(['indeed', 'naukri', 'linkedin', 'google', 'glassdoor', 'zip_recruiter']);
const isStale = (l) => l.status === 'new' && (OLD_SOURCES.has(String(l.source || '').toLowerCase()) || (l.source !== 'freelancer' && l.jobTitle && !isWebRole(l.jobTitle)));
// Old job-board leads are deleted and do not count against today's budget (the budget restarts from what is left today).
async function purgeOldSources(list) {
  const old = list.filter((l) => OLD_SOURCES.has(String(l.source || '').toLowerCase()));
  if (!old.length) return list;
  for (let i = 0; i < old.length; i += 50) await redis('HDEL', 'leads', ...old.slice(i, i + 50).map((l) => l.id));
  const gone = new Set(old.map((l) => l.id));
  const rest = list.filter((l) => !gone.has(l.id));
  await set('day', { date: istDay(), count: rest.filter((l) => istDay(l.createdAt) === istDay()).length });
  return rest;
}
async function pruneIrrelevant(list) {
  const stale = list.filter(isStale);
  for (let i = 0; i < stale.length; i += 50) {
    const part = stale.slice(i, i + 50);
    await redis('HDEL', 'leads', ...part.map((l) => l.id));
    await Promise.all(part.map((l) => redis('SET', 'irr:' + l.id, '1', 'EX', 60 * 60 * 24 * 30)));
  }
  return stale.map((l) => l.id);
}

async function ingest(body) {
  const items = (Array.isArray(body.leads) ? body.leads : []).slice(0, 40);
  const runId = String(body.runId || 'run_' + new Date().toISOString().slice(0, 10));
  const s = await getSettings();

  let st = await get('lastFetch');
  if (!st || st.runId !== runId) st = { runId, added: 0, skippedAgencies: 0, noPhone: 0, duplicates: 0, irrelevant: 0 };
  st.irrelevant = st.irrelevant || 0;
  st.skippedAgencies += Number(body.preFiltered) || 0;

  let existing = await purgeOldSources(Object.values(await hgetall('leads')));

  // DAILY BUDGET: perDay leads come in per day (IST). Leads that turn out not to be web-related are removed
  // but they still use up that day's budget, and nothing is added to replace them.
  const today = istDay();
  let used = await dayUsed(existing);

  const removed = await pruneIrrelevant(existing);
  if (removed.length) { st.irrelevant += removed.length; existing = existing.filter((l) => !removed.includes(l.id)); }

  const seenIds = new Set(existing.map((l) => l.id));
  const seenPhones = new Set(existing.map((l) => l.phone).filter(Boolean));
  const fresh = [];
  let taken = 0; // new leads this call that use up today's budget (saved or dropped as not web-related)
  const budgetLeft = () => used + taken < s.perDay;
  // No Google key: leads are saved without a phone number and you add the number by hand on the dashboard.
  const usePlaces = !!process.env.GOOGLE_PLACES_API_KEY;

  for (let i = 0; i < items.length && budgetLeft(); i += 5) {
    const chunk = items.slice(i, i + 5);
    const out = await Promise.all(chunk.map(async (it) => {
      const name = String(it.name || '').trim().slice(0, 120);
      const city = String(it.city || '').trim().slice(0, 80);
      if (!name) return { skip: 'bad' };
      const id = 'j_' + slug(name);
      if (seenIds.has(id)) return { skip: 'dup' };
      if (isAgency(null, name)) return { skip: 'agency' };
      if (await redis('EXISTS', 'irr:' + id)) return { skip: 'dup' };
      if (it.source !== 'freelancer' && !isWebRole(it.jobTitle)) return { id, irrelevant: true };
      if (!usePlaces) return { id, name, city, found: { place: null, phone: '' }, it };
      if (await redis('EXISTS', 'np:' + id)) return { skip: 'nophone' };
      let found = null;
      try { found = await findPhone(name, city); } catch (e) { return { skip: 'error', error: e.message }; }
      if (!found) { await redis('SET', 'np:' + id, '1', 'EX', 60 * 60 * 24 * 30); return { skip: 'nophone' }; }
      if (isAgency(found.place, name)) { await redis('SET', 'np:' + id, '1', 'EX', 60 * 60 * 24 * 30); return { skip: 'agency' }; }
      return { id, name, city, found, it };
    }));

    for (const o of out) {
      if (o.skip === 'dup') st.duplicates++;
      else if (o.skip === 'agency') st.skippedAgencies++;
      else if (o.skip === 'nophone') st.noPhone++;
      else if (o.skip === 'error') { st.lastError = o.error; st.errors = (st.errors || 0) + 1; }
      else if (o.irrelevant) {
        if (!budgetLeft() || seenIds.has(o.id)) continue;
        taken++; st.irrelevant++; seenIds.add(o.id);
        await redis('SET', 'irr:' + o.id, '1', 'EX', 60 * 60 * 24 * 30);
      } else if (o.id) {
        if (seenIds.has(o.id) || (o.found.phone && seenPhones.has(o.found.phone))) { st.duplicates++; continue; }
        if (!budgetLeft()) continue;
        const p = o.found.place || {};
        fresh.push({
          id: o.id, name: o.name, phone: o.found.phone, city: o.city,
          category: String(o.it.jobTitle || 'Wants a website').slice(0, 120),
          jobTitle: String(o.it.jobTitle || '').slice(0, 120),
          source: String(o.it.source || '').slice(0, 30),
          jobUrl: String(o.it.jobUrl || '').slice(0, 500),
          email: String(o.it.email || '').slice(0, 120),
          address: p.formattedAddress || '', website: p.websiteUri || String(o.it.website || '').slice(0, 200),
          status: 'new', createdAt: Date.now(),
        });
        taken++; seenIds.add(o.id); if (o.found.phone) seenPhones.add(o.found.phone);
      }
    }
  }

  if (fresh.length) {
    const flat = [];
    for (const l of fresh) flat.push(l.id, JSON.stringify(l));
    await redis('HSET', 'leads', ...flat);
  }
  used += taken;
  await set('day', { date: today, count: used });
  st.added += fresh.length;
  st.at = Date.now();
  await set('lastFetch', st);
  return { ...st, addedNow: fresh.length, perDay: s.perDay, usedToday: used, full: used >= s.perDay };
}

// Dashboard button: ask GitHub to run the scraper workflow now.
async function triggerScrape() {
  const repo = process.env.GH_REPO, token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('Set GH_REPO and GH_TOKEN in Vercel to use this button. The daily run works without them.');
  const r = await fetch('https://api.github.com/repos/' + repo + '/actions/workflows/daily-leads.yml/dispatches', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'leaddesk',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: process.env.GH_BRANCH || 'main' }),
  });
  if (r.status !== 204) {
    const j = await r.json().catch(() => ({}));
    throw new Error('GitHub: ' + (j.message || r.status));
  }
  return { started: true };
}

/* ============================================================
   VOICE PROVIDER
   Default is Rasen when RASEN_* keys are set; otherwise Vapi.
   startCall must return { id }. parseWebhook must return the
   normalized object shown in the vapi branch.
   ============================================================ */
function rasenKey() {
  return process.env.RASEN_WORKSPACE_KEY || process.env.RASEN_API_KEY || process.env.RASEN_KEY || '';
}
function rasenAgentId() {
  return process.env.RASEN_AGENT_ID || process.env.RASEN_ASSISTANT_ID || process.env.VOICE_AGENT_ID || '';
}
function rasenBase() {
  const raw = process.env.RASEN_API_BASE || process.env.RASEN_BASE_URL || process.env.RASEN_CALL_URL ||
    'https://kalpa-api-454269687527.asia-south1.run.app/api/rasen/workspace';
  return String(raw).replace(/\/calls\/?$/, '').replace(/\/+$/, '');
}
const PROVIDER = () => {
  const p = String(process.env.VOICE_PROVIDER || '').toLowerCase();
  if (p) return p;
  if (rasenKey() && rasenAgentId()) return 'rasen';
  return 'vapi';
};

function rasenErr(j) {
  const v = j && (j.detail || j.error || j.message || j.errors);
  if (!v) return JSON.stringify(j || {}).slice(0, 280);
  if (typeof v === 'string') return v;
  if (v.message) return String(v.message);
  return JSON.stringify(v).slice(0, 280);
}

async function rasenFetch(path, opts) {
  const key = rasenKey();
  if (!key) throw new Error('Set RASEN_WORKSPACE_KEY (workspace key rkw_live_...) in Vercel.');
  const res = await fetch(rasenBase() + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(opts && opts.headers),
    },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Rasen ' + res.status + ': ' + rasenErr(j));
  return j;
}

function rasenCallId(j) {
  const d = (j && (j.data || j.call || j)) || {};
  return d.call_id || d.callId || d.id || d.session_id || d.conversation_id || '';
}

async function startCall({ number, name, jobTitle, city, leadId }) {
  if (PROVIDER() === 'vapi') {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.VAPI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: process.env.VAPI_ASSISTANT_ID,
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: { number, name: name || undefined },
        assistantOverrides: { variableValues: { leadName: name || 'there', jobTitle: jobTitle || 'a web role' } },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Voice provider: ' + (Array.isArray(j.message) ? j.message.join(', ') : j.message || r.status));
    return { id: j.id };
  }
  if (PROVIDER() === 'rasen') {
    const agentId = rasenAgentId();
    if (!agentId) throw new Error('Set RASEN_AGENT_ID (published Rasen agent) in Vercel.');
    const payload = {
      agent_id: agentId,
      to: number,
      variables: {
        business_name: name || 'there',
        job_title: jobTitle || 'a web role',
        city: city || '',
        service_needed: 'Website design and development',
      },
      metadata: { lead_id: leadId || '' },
    };
    if (process.env.RASEN_PHONE_NUMBER_ID) payload.phone_number_id = process.env.RASEN_PHONE_NUMBER_ID;
    const j = await rasenFetch('/calls', { method: 'POST', body: JSON.stringify(payload) });
    const id = rasenCallId(j);
    if (!id) throw new Error('Rasen did not return a call id. Response: ' + JSON.stringify(j).slice(0, 150));
    return { id: String(id) };
  }
  throw new Error('Unknown VOICE_PROVIDER');
}

function parseWebhook(body) {
  if (PROVIDER() === 'vapi') {
    const m = (body && body.message) || {};
    if (m.type !== 'end-of-call-report') return null;
    const a = m.artifact || {};
    let dur = Number(m.durationSeconds);
    if (!dur && m.startedAt && m.endedAt) dur = (new Date(m.endedAt) - new Date(m.startedAt)) / 1000;
    return {
      callId: m.call && m.call.id,
      endedReason: m.endedReason || (m.call && m.call.endedReason) || '',
      durationSec: Math.round(dur || 0),
      recordingUrl: m.recordingUrl || a.recordingUrl || '',
      transcript: m.transcript || a.transcript || '',
      startedAt: m.startedAt || null,
      customerNumber: (m.customer && m.customer.number) || (m.call && m.call.customer && m.call.customer.number) || '',
    };
  }
  if (PROVIDER() === 'rasen') {
    // Rasen payload: { event: 'call.completed', call: { id, status, detailed_status, duration_ms,
    //   recording_url, transcript: [{ turn_idx, user, agent }], variables, metadata, started_at } }
    const b = body || {};
    const event = String(b.event || '').toLowerCase();
    if (event !== 'call.completed' && event !== 'call.failed') return null; // call.analyzed adds nothing we need
    const d = b.call || {};
    if (!d.id) return null;
    let tr = '';
    if (Array.isArray(d.transcript)) {
      tr = d.transcript.map((t) => [t.user ? 'User: ' + t.user : '', t.agent ? 'AI: ' + t.agent : ''].filter(Boolean).join('\n')).filter(Boolean).join('\n');
    }
    const vars = d.variables || {}, meta = d.metadata || {};
    const started = d.started_at ? String(d.started_at).replace(' ', 'T') + 'Z' : null;
    return {
      callId: String(d.id),
      endedReason: String(d.detailed_status || d.status || event),
      durationSec: Math.round((Number(d.duration_ms) || 0) / 1000),
      recordingUrl: typeof d.recording_url === 'string' ? d.recording_url : '',
      transcript: tr,
      startedAt: started && !isNaN(new Date(started).getTime()) ? started : null,
      customerNumber: '', // Rasen only sends the last 4 digits, so we match by metadata / variables instead
      leadId: String(meta.lead_id || vars.lead_id || ''),
      businessName: String(vars.business_name || ''),
    };
  }
  return null;
}

/* ============================================================
   AI CLASSIFIER  (reads the transcript of the recording)
   ============================================================ */
async function classify({ transcript, endedReason, durationSec }) {
  const spoke = /(^|\n)\s*(user|customer|human)\s*:/i.test(transcript || '');
  if (!transcript || !spoke) {
    return { temperature: 'not_picked', summary: 'Call was not answered or the person did not speak.', reason: endedReason || 'No speech from the lead', nextStep: 'Try again at a different time' };
  }
  const system = 'You grade outbound sales call outcomes for a website design and development service. Calls may be in Hindi, English or Hinglish. Reply with ONLY a JSON object, no markdown.';
  const prompt =
    'Call transcript:\n' + transcript.slice(0, 12000) +
    '\n\nCall ended because: ' + endedReason + ' | duration: ' + durationSec + 's\n\n' +
    'Return JSON with keys:\n' +
    '"temperature": one of "hot" (clear interest, asked for price/meeting/proposal or agreed to next step), "warm" (some interest, needs follow-up), "cold" (not interested or dismissive), "callback" (asked to be called later), "do_not_call" (angry, asked to stop, wrong number), "other".\n' +
    '"summary": 1-2 sentences in English.\n"reason": why you chose that temperature, one sentence.\n"nextStep": a short recommended action.';
  const ok = ['hot', 'warm', 'cold', 'callback', 'do_not_call', 'other'];
  const shape = (o) => ({ temperature: ok.includes(o.temperature) ? o.temperature : 'other', summary: o.summary || '', reason: o.reason || '', nextStep: o.nextStep || '' });
  const parseJson = (text) => JSON.parse(String(text).replace(/```json|```/g, '').trim());

  try {
    // 1) Gemini: free key from aistudio.google.com
    if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 600, temperature: 0.2 },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Gemini error ' + r.status);
      const text = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
      return shape(parseJson(text || '{}'));
    }
    // 2) Anthropic (paid, optional)
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages: [{ role: 'user', content: prompt }] }),
      });
      const j = await r.json();
      return shape(parseJson((j.content && j.content[0] && j.content[0].text) || '{}'));
    }
  } catch (e) {
    return { ...keywordGrade(transcript), reason: 'AI unavailable (' + String(e.message).slice(0, 80) + '), graded by keywords.' };
  }
  // 3) No key at all: simple keyword grading
  return keywordGrade(transcript);
}

// Free fallback that needs no AI. Less accurate, but always works.
function keywordGrade(transcript) {
  const user = String(transcript || '').split('\n').filter((l) => /^\s*(user|customer|human)\s*:/i.test(l)).join(' ').toLowerCase();
  const has = (re) => re.test(user);
  let t = 'warm', reason = 'Person spoke with the assistant; no clear signal either way.', next = 'Listen to the recording and follow up';
  if (has(/(do not call|don't call|stop calling|mat karo|band karo|remove my number|wrong number)/)) { t = 'do_not_call'; reason = 'Asked to stop calls or wrong number.'; next = 'Do not call again'; }
  else if (has(/(call (me )?(back|later)|baad mein|baad me|abhi busy|later|kal call|tomorrow)/)) { t = 'callback'; reason = 'Asked to be called later.'; next = 'Call back at a better time'; }
  else if (has(/(price|cost|kitna|rate|charges|interested|send (me )?(details|proposal)|whatsapp|meeting|demo|sure|haan|yes)/) && !has(/(not interested|no thanks|nahi chahiye|zarurat nahi)/)) { t = 'hot'; reason = 'Showed interest or asked about price or next step.'; next = 'Send details on WhatsApp and book the free call'; }
  else if (has(/(not interested|no thanks|nahi chahiye|zarurat nahi|no need|nahi)/)) { t = 'cold'; reason = 'Said they are not interested.'; next = 'Try again after a few months'; }
  return { temperature: t, summary: 'Graded by keywords (no AI key set).', reason, nextStep: next };
}

/* ============================================================
   CALLING + AUTO-CALL QUEUE
   ============================================================ */
function inWindow() {
  const [a, b] = (process.env.CALL_WINDOW || '10-19').split('-').map(Number);
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: process.env.CALL_TZ || 'Asia/Kolkata' }).format(new Date())) % 24;
  return h >= a && h < b;
}

async function dialLead(lead) {
  const { id } = await startCall({ number: lead.phone, name: lead.name, jobTitle: lead.jobTitle, city: lead.city, leadId: lead.id });
  await hset('callmap', id, lead.id);
  lead.status = 'calling'; lead.lastCallId = id; lead.calledAt = Date.now(); delete lead.error;
  await hset('leads', lead.id, lead);
  return id;
}

async function callNext() {
  for (let i = 0; i < 5; i++) {
    const auto = (await get('auto')) || { running: false };
    if (!auto.running) return null;
    if (!inWindow()) { await set('auto', { running: false, note: 'Stopped: outside calling hours' }); return null; }
    const id = await redis('LPOP', 'queue');
    if (!id) { await set('auto', { running: false, note: 'Finished: every new lead has been called' }); return null; }
    const lead = await hget('leads', id);
    if (!lead || lead.status !== 'new') continue;
    try { return await dialLead(lead); } catch (e) {
      lead.status = 'error'; lead.error = String(e.message).slice(0, 200);
      await hset('leads', id, lead);
    }
  }
  return null;
}

async function startAuto() {
  if (!inWindow()) throw new Error('Outside calling hours (' + (process.env.CALL_WINDOW || '10-19') + ' ' + (process.env.CALL_TZ || 'Asia/Kolkata') + ')');
  const leads = Object.values(await hgetall('leads')).filter((l) => l.status === 'new' && l.phone).sort((a, b) => a.createdAt - b.createdAt);
  if (!leads.length) throw new Error('No new leads to call');
  await redis('DEL', 'queue');
  await redis('RPUSH', 'queue', ...leads.map((l) => l.id));
  await set('auto', { running: true, startedAt: Date.now(), note: 'Running' });
  await callNext();
}
const stopAuto = () => set('auto', { running: false, note: 'Stopped by you' });

/* ============================================================
   WEBHOOK  (voice provider tells us a call has ended)
   ============================================================ */
function callEndedStatus(status, detail) {
  const st = String(status || '').toLowerCase();
  const dt = String(detail || '').toLowerCase();
  return /ended|failed|completed|busy|no_answer|no-answer|voicemail|hung_up|canceled|cancelled|error/.test(st + ' ' + dt);
}

async function saveEndedCall(ev) {
  if (!ev || !ev.callId) return { ignored: true };
  const first = await redis('SET', 'done:' + ev.callId, '1', 'NX', 'EX', 86400);
  if (!first) return { duplicate: true };

  const leadId = (await hget('callmap', ev.callId)) || ev.leadId || null;
  let lead = leadId ? await hget('leads', leadId) : null;
  if (!lead && (ev.customerNumber || ev.businessName)) {
    const all = Object.values(await hgetall('leads'));
    const ph = ev.customerNumber ? normPhone(ev.customerNumber) : null;
    lead = (ph && all.find((l) => l.phone === ph)) ||
      (ev.businessName && all.filter((l) => l.name === ev.businessName).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0]) || null;
  }
  const ai = await classify(ev);

  const call = {
    id: ev.callId, leadId: lead ? lead.id : null,
    name: lead ? lead.name : (ev.businessName || 'Unknown caller'), phone: lead ? lead.phone : (ev.customerNumber || ''),
    city: lead ? lead.city : '', category: lead ? lead.category : '',
    jobTitle: lead ? lead.jobTitle || '' : '', website: lead ? lead.website || '' : '',
    email: lead ? lead.email || '' : '', source: lead ? lead.source || '' : '', address: lead ? lead.address || '' : '',
    startedAt: ev.startedAt ? new Date(ev.startedAt).getTime() : Date.now(),
    createdAt: Date.now(), durationSec: ev.durationSec, endedReason: ev.endedReason,
    recordingUrl: ev.recordingUrl, transcript: ev.transcript,
    temperature: ai.temperature, summary: ai.summary, reason: ai.reason, nextStep: ai.nextStep,
  };
  await hset('calls', ev.callId, call);

  if (lead) {
    lead.status = 'called'; lead.temperature = ai.temperature;
    await hset('leads', lead.id, lead);
  }

  const auto = await get('auto');
  if (auto && auto.running) await callNext();
  return { saved: true };
}

async function handleWebhook(req, res) {
  const secret = process.env.WEBHOOK_SECRET;
  if (req.method !== 'POST') return res.status(405).end();
  if (!secret || req.query.key !== secret) return res.status(401).json({ error: 'Bad key' });

  const ev = parseWebhook(req.body || {});
  if (!ev || !ev.callId) return res.status(200).json({ ignored: true });
  return res.status(200).json(await saveEndedCall(ev));
}

/* ============================================================
   API ROUTER
   ============================================================ */
async function handleApi(req, res) {
  const action = req.query.action;
  if (action === 'webhook') return handleWebhook(req, res);

  // The GitHub Action talks to us with INGEST_SECRET; everything else needs the dashboard password.
  if (action === 'ingest' || action === 'config') {
    const k = process.env.INGEST_SECRET;
    if (!k || req.headers['x-ingest-key'] !== k) return res.status(401).json({ error: 'Bad ingest key' });
    if (action === 'config') return res.json(await getSettings());
    if (req.method !== 'POST') return res.status(405).end();
    return res.json(await ingest(req.body && typeof req.body === 'object' ? req.body : {}));
  }
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  switch (action) {
    case 'leads': {
      let all = await purgeOldSources(Object.values(await hgetall('leads')));
      // Clear non-web leads automatically, keeping today's count so nothing new takes their place.
      if (all.some((l) => isStale(l))) {
        await dayUsed(all);
        const gone = new Set(await pruneIrrelevant(all));
        all = all.filter((l) => !gone.has(l.id));
      }
      const leads = all.sort((a, b) => b.createdAt - a.createdAt);
      const auto = (await get('auto')) || { running: false };
      const queue = await redis('LLEN', 'queue');
      const lastFetch = await get('lastFetch');
      return res.json({ leads, auto, queue, lastFetch });
    }
    case 'calls': {
      const calls = Object.values(await hgetall('calls')).sort((a, b) => b.createdAt - a.createdAt);
      return res.json({ calls });
    }
    case 'cleanup': {
      const all = Object.values(await hgetall('leads'));
      await dayUsed(all); // keep today's count before removing anything
      const removed = await pruneIrrelevant(all);
      return res.json({ removed: removed.length });
    }
    case 'fetch-leads':
      return res.json(await triggerScrape());
    case 'lead-update': {
      const lead = await hget('leads', body.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (body.phone !== undefined) {
        const ph = normPhone(body.phone);
        if (!ph) return res.status(400).json({ error: 'Enter a valid phone number' });
        lead.phone = ph;
      }
      if (['new', 'skipped'].includes(body.status)) lead.status = body.status;
      await hset('leads', lead.id, lead);
      return res.json({ ok: true });
    }
    case 'call': {
      let lead;
      if (body.leadId) {
        lead = await hget('leads', body.leadId);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        if (!lead.phone) return res.status(400).json({ error: 'This lead has no phone number yet. Tap Add phone first.' });
      } else {
        const phone = normPhone(body.number);
        if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
        lead = { id: 'manual_' + Date.now(), name: (body.name || '').trim() || 'Manual call', phone, city: '', category: 'manual', status: 'new', createdAt: Date.now() };
      }
      const callId = await dialLead(lead);
      return res.json({ ok: true, callId, name: lead.name });
    }
    case 'callstatus': {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'No call id' });
      if (PROVIDER() !== 'rasen') return res.json({ status: 'unknown' });
      try {
        const j = await rasenFetch('/calls/' + encodeURIComponent(id));
        const d = j.call || j.data || j;
        const lines = [];
        if (Array.isArray(d.transcript)) {
          for (const t of d.transcript.slice(-6)) {
            if (t.user) lines.push({ who: 'them', text: String(t.user).slice(0, 200) });
            if (t.agent) lines.push({ who: 'ai', text: String(t.agent).slice(0, 200) });
          }
        }
        const status = String(d.status || '').toLowerCase();
        const detail = String(d.detailed_status || '').toLowerCase();
        if (callEndedStatus(status, detail)) {
          const ev = parseWebhook({ event: status === 'failed' ? 'call.failed' : 'call.completed', call: d });
          if (ev && ev.callId) saveEndedCall(ev).catch(() => {});
        }
        return res.json({
          status,
          detail,
          durationSec: Math.round((Number(d.duration_ms) || 0) / 1000),
          lines: lines.slice(-4),
        });
      } catch (e) {
        return res.json({ status: 'unknown', note: String(e.message || 'status failed').slice(0, 160) });
      }
    }
    case 'hangup': {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'No call id' });
      if (PROVIDER() !== 'rasen') return res.status(400).json({ error: 'Hangup is only wired for Rasen.' });
      try {
        await rasenFetch('/calls/' + encodeURIComponent(id) + '/hangup', { method: 'POST', body: '{}' });
        return res.json({ ok: true });
      } catch (e) {
        return res.status(400).json({ error: String(e.message || 'Hangup failed').slice(0, 220) });
      }
    }
    case 'auto': {
      if (body.op === 'start') {
        // Auto-call is locked with its own password, kept in Vercel (never in the code).
        const lock = process.env.AUTOCALL_PASSWORD;
        if (!lock) return res.status(403).json({ error: 'Auto-call is locked. Set AUTOCALL_PASSWORD in Vercel first.' });
        if (String(body.lockPassword || '') !== lock) return res.status(403).json({ error: 'Wrong auto-call password.' });
        await startAuto();
      } else if (body.op === 'stop') await stopAuto();
      return res.json({ ok: true });
    }
    case 'settings': {
      if (req.method === 'POST') return res.json(await saveSettings(body));
      return res.json(await getSettings());
    }
    default:
      return res.status(404).json({ error: 'Unknown action' });
  }
}

module.exports = { handleApi };

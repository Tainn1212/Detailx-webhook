const express = require('express');
const Database = require('better-sqlite3');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());

const db = new Database('leads.db');

// Create leads table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
    meta_id     TEXT UNIQUE,
    name        TEXT,
    phone       TEXT,
    email       TEXT,
    vehicle     TEXT,
    job_type    TEXT,
    urgency     TEXT,
    location    TEXT,
    lead_source TEXT,
    created_at  TEXT,
    synced_at   TEXT
  )
`);

const META_TOKEN = process.env.META_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ── Webhook verification (Meta calls this when you first connect) ──────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Receive lead notifications from Meta ───────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'leadgen') continue;

      const leadId = change.value?.leadgen_id;
      if (!leadId) continue;

      try {
        await fetchAndStoreLead(leadId);
      } catch (err) {
        console.error('Failed to fetch lead', leadId, err.message);
      }
    }
  }
});

// ── Fetch full lead data from Meta and store it ────────────────────────────
async function fetchAndStoreLead(leadId) {
  const url = `https://graph.facebook.com/v19.0/${leadId}?fields=id,created_time,field_data&access_token=${META_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    console.error('Meta API error:', data.error.message);
    return;
  }

  const fields = {};
  for (const f of (data.field_data || [])) {
    fields[f.name.toLowerCase()] = (f.values || [])[0] || '';
  }

  const name     = fields['full_name'] || fields['name'] || 'Unknown';
  const phone    = (fields['phone_number'] || fields['phone'] || '').replace(/^p:/i, '').trim();
  const email    = fields['email'] || '';
  const vehicle  = fields["my_cars_make_and_model_is?"] || fields['vehicle'] || fields['car'] || '';
  const rawJob   = fields["the_type_of_detail_i'm_looking_for_is?"] || fields['job_type'] || '';
  const rawUrg   = fields["how_soon_are_you_wanting_it_done?"] || '';
  const rawLoc   = fields["where_in_auckland_are_you_based?"] || '';

  const jobType  = mapJobType(rawJob);
  const urgency  = mapUrgency(rawUrg);
  const location = mapLocation(rawLoc);
  const source   = 'Meta Ad';
  const createdAt = data.created_time ? new Date(data.created_time).toISOString() : new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leads
      (id, meta_id, name, phone, email, vehicle, job_type, urgency, location, lead_source, created_at, synced_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    data.id,
    data.id,
    name, phone, email, vehicle,
    jobType, urgency, location, source,
    createdAt,
    new Date().toISOString()
  );

  console.log(`Stored lead: ${name} (${phone})`);
}

// ── GET /leads — CRM calls this to pull all stored leads ──────────────────
app.get('/leads', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(rows);
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('DetailX webhook server running'));

// ── Helpers ───────────────────────────────────────────────────────────────
function mapJobType(raw) {
  if (!raw) return '';
  const v = raw.toLowerCase();
  if (v.includes('interior') && v.includes('exterior')) return 'Full Detail';
  if (v.includes('interior')) return 'Interior';
  if (v.includes('exterior')) return 'Exterior';
  if (v.includes('polish') || v.includes('ceramic')) return 'Polish & Ceramic';
  return 'Other';
}

function mapUrgency(raw) {
  if (!raw) return '';
  const v = raw.toLowerCase().replace(/_/g, ' ');
  if (v.includes('asap')) return 'ASAP';
  if (v.includes('2 week')) return 'Within 2 weeks';
  if (v.includes('no rush') || v.includes('looking')) return 'No rush / just looking';
  return raw.replace(/_/g, ' ').trim();
}

function mapLocation(raw) {
  if (!raw) return '';
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

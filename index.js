const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const DB_FILE = path.join(__dirname, 'leads.json');

function loadLeads() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveLeads(leads) {
  fs.writeFileSync(DB_FILE, JSON.stringify(leads, null, 2));
}

const META_TOKEN = process.env.META_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ── Webhook verification ───────────────────────────────────────────────────
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
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of (body.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'leadgen') continue;
      const leadId = change.value?.leadgen_id;
      if (!leadId) continue;
      try { await fetchAndStoreLead(leadId); } catch (err) { console.error('Failed to fetch lead', leadId, err.message); }
    }
  }
});

// ── Fetch full lead from Meta and store ────────────────────────────────────
async function fetchAndStoreLead(leadId) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${leadId}?fields=id,created_time,field_data&access_token=${META_TOKEN}`);
  const data = await res.json();

  if (data.error) { console.error('Meta API error:', data.error.message); return; }

  const fields = {};
  for (const f of (data.field_data || [])) fields[f.name.toLowerCase()] = (f.values || [])[0] || '';

  const name     = fields['full_name'] || fields['name'] || 'Unknown';
  const phone    = (fields['phone_number'] || fields['phone'] || '').replace(/^p:/i, '').trim();
  const email    = fields['email'] || '';
  const vehicle  = fields["my_cars_make_and_model_is?"] || fields['vehicle'] || fields['car'] || '';
  const rawJob   = fields["the_type_of_detail_i'm_looking_for_is?"] || fields['job_type'] || '';
  const rawUrg   = fields["how_soon_are_you_wanting_it_done?"] || '';
  const rawLoc   = fields["where_in_auckland_are_you_based?"] || '';

  const lead = {
    id: data.id,
    meta_id: data.id,
    name,
    phone,
    email,
    vehicle,
    job_type: mapJobType(rawJob),
    urgency: mapUrgency(rawUrg),
    location: mapLocation(rawLoc),
    lead_source: 'Meta Ad',
    created_at: data.created_time ? new Date(data.created_time).toISOString() : new Date().toISOString(),
    synced_at: new Date().toISOString(),
  };

  const leads = loadLeads();
  if (!leads.find(l => l.meta_id === lead.meta_id)) {
    leads.unshift(lead);
    saveLeads(leads);
    console.log(`Stored lead: ${name} (${phone})`);
  }
}

// ── GET /leads — CRM calls this to pull stored leads ─────────────────────
app.get('/leads', (req, res) => res.json(loadLeads()));

// ── Health check ─────────────────────────────────────────────────────────
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

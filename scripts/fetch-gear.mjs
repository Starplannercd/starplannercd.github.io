// Fetches equipped gear for every character in data/roster.json from the
// Blizzard API (MoP Classic / classic progression) and writes data/gear.json.
//
// Runs in GitHub Actions (see .github/workflows/fetch-gear.yml) and locally:
//   BLIZZARD_CLIENT_ID=xxx BLIZZARD_CLIENT_SECRET=yyy node scripts/fetch-gear.mjs
//
// Behavior on failure:
//   - token fetch fails  -> exit 1, gear.json untouched
//   - one character fails -> ok:false + error message, previous items carried
//     forward so the page can show stale data with a warning

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER = path.join(root, 'data', 'roster.json');
const GEAR = path.join(root, 'data', 'gear.json');
const ILVL_CACHE = path.join(root, 'data', 'item-levels.json');
const ILVL_HISTORY = path.join(root, 'data', 'ilvl-history.json');
// upgrade_id -> +ilvl from the game's ItemUpgrade table (wago.tools, build 5.5.4)
const UPGRADE_LEVELS = JSON.parse(fs.readFileSync(path.join(root, 'data', 'upgrade-levels.json'), 'utf8'));

const clientId = process.env.BLIZZARD_CLIENT_ID;
const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET environment variables.');
  console.error('(In GitHub: repo Settings -> Secrets and variables -> Actions.)');
  process.exit(1);
}

const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
let previous = { characters: {} };
try { previous = JSON.parse(fs.readFileSync(GEAR, 'utf8')); } catch { /* first run */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function friendlyError(status, name, realm) {
  if (status === 404) return `HTTP 404: character not found — check spelling of "${name}" and realm slug "${realm}" in data/roster.json`;
  if (status === 403) return 'HTTP 403: API client lacks access (check the Blizzard API client setup)';
  if (status === 401) return 'HTTP 401: authentication failed mid-run';
  return `HTTP ${status}`;
}

async function fetchCharacter(token, region, realm, name) {
  const url = `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${name.toLowerCase()}` +
    `/equipment?namespace=profile-classic-${region}&locale=en_US`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(friendlyError(res.status, name, realm)), { status: res.status });
  const data = await res.json();
  return (data.equipped_items || []).map((it) => ({
    slot: it.slot && it.slot.type,
    id: it.item && it.item.id,
    name: typeof it.name === 'string' ? it.name : (it.name && it.name.en_US) || '',
    ilvl: 0, // the classic equipment API has no item level — filled in below from static item data
    upgrade: UPGRADE_LEVELS[it.upgrade_id] || 0, // valor upgrade bonus (+8/+14 etc.)
    quality: (it.quality && it.quality.type) || '',
    invType: (it.inventory_type && it.inventory_type.type) || '', // TWOHWEAPON = fills both weapon slots
  })).filter((it) => it.slot && it.id);
}

// The classic profile API omits item level, so look up each distinct item's base
// ilvl from the static item endpoint. Cached in data/item-levels.json so repeat
// runs only fetch items we haven't seen before.
async function fillItemLevels(token, region, characters) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(ILVL_CACHE, 'utf8')); } catch { /* first run */ }
  const needed = new Set();
  for (const entry of Object.values(characters)) {
    for (const it of entry.items || []) {
      if (cache[it.id] === undefined) needed.add(it.id);
    }
  }
  let fetched = 0;
  for (const id of needed) {
    try {
      const res = await fetch(
        `https://${region}.api.blizzard.com/data/wow/item/${id}?namespace=static-classic-${region}&locale=en_US`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        cache[id] = (await res.json()).level || 0;
        fetched++;
      } else if (res.status === 404) {
        cache[id] = 0; // unknown item: cache it so we don't retry forever
      }
    } catch { /* leave uncached, retried next run */ }
    await sleep(150);
  }
  if (fetched) fs.writeFileSync(ILVL_CACHE, JSON.stringify(cache, null, 2) + '\n');
  for (const entry of Object.values(characters)) {
    // effective ilvl = base item level + valor upgrade bonus
    for (const it of entry.items || []) it.ilvl = (cache[it.id] || 0) && (cache[it.id] + (it.upgrade || 0));
  }
  console.log(`Item levels: ${fetched} newly fetched, ${Object.keys(cache).length} cached total`);
}

let token;
try {
  token = await getToken();
} catch (e) {
  console.error('FATAL: ' + e.message);
  console.error('gear.json left untouched.');
  process.exit(1);
}

const out = { fetchedAt: previous.fetchedAt || null, characters: {} };
let okCount = 0;
let changed = false;

for (const ch of roster.characters) {
  const realm = ch.realm || roster.defaultRealm;
  const prev = (previous.characters && previous.characters[ch.name]) || null;
  try {
    const items = await fetchCharacter(token, roster.region, realm, ch.name);
    out.characters[ch.name] = { ok: true, fetchedAt: new Date().toISOString(), items };
    okCount++;
    console.log(`  OK   ${ch.name} (${items.length} items)`);
  } catch (e) {
    out.characters[ch.name] = {
      ok: false,
      error: e.message,
      fetchedAt: prev ? prev.fetchedAt : null,
      items: prev ? prev.items || [] : [],
    };
    console.log(`  FAIL ${ch.name}: ${e.message}`);
  }
  await sleep(250);
}

await fillItemLevels(token, roster.region, out.characters);

// change detection (after ilvl fill so comparisons see final data)
for (const ch of roster.characters) {
  const entry = out.characters[ch.name];
  const prev = (previous.characters && previous.characters[ch.name]) || null;
  if (entry.ok) {
    if (!prev || !prev.ok || JSON.stringify(prev.items) !== JSON.stringify(entry.items)) changed = true;
    else entry.fetchedAt = prev.fetchedAt; // identical -> keep old timestamp, keep diff quiet
  } else if (!prev || prev.ok || prev.error !== entry.error) {
    changed = true;
  }
}

if (okCount === 0) {
  console.error('FATAL: every character failed — gear.json left untouched.');
  process.exit(1);
}

if (changed) out.fetchedAt = new Date().toISOString();

fs.writeFileSync(GEAR, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote data/gear.json (${okCount}/${roster.characters.length} characters OK, changed=${changed})`);

// ── ilvl history: one entry per calendar day, latest run wins ──
// Records each raider's average equipped ilvl so bis.html can chart progress.
{
  let history = [];
  try { history = JSON.parse(fs.readFileSync(ILVL_HISTORY, 'utf8')); } catch { /* first run */ }
  const day = new Date().toISOString().slice(0, 10);
  const chars = {};
  for (const [name, entry] of Object.entries(out.characters)) {
    const ilvls = (entry.items || [])
      .filter((it) => it.slot !== 'SHIRT' && it.slot !== 'TABARD')
      .map((it) => it.ilvl).filter((n) => n > 0);
    if (ilvls.length) chars[name] = +(ilvls.reduce((a, b) => a + b, 0) / ilvls.length).toFixed(1);
  }
  const avgs = Object.values(chars);
  if (avgs.length) {
    const point = {
      date: day,
      team: +(avgs.reduce((a, b) => a + b, 0) / avgs.length).toFixed(1),
      chars,
    };
    const idx = history.findIndex((h) => h.date === day);
    if (idx >= 0) history[idx] = point; else history.push(point);
    fs.writeFileSync(ILVL_HISTORY, JSON.stringify(history, null, 2) + '\n');
    console.log(`Wrote data/ilvl-history.json (${history.length} days, team avg ${point.team})`);
  }
}

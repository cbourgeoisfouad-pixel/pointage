// Rappels Pointage — calcule ce qui reste à faire et l'envoie en notification push.
// Lancé par GitHub Actions à 8h30 (sauf dimanche) et 19h30, heure de Paris.
import webpush from "web-push";

const SB_URL = "https://iicxvdjhlwjwlbacjqgk.supabase.co/rest/v1";
const SB_KEY = "sb_publishable_0Wb2TsVn-NJE4JllWS4nEQ_RtjLnM_Q";
const VAPID_PUBLIC = "BMhHWkoLsnsWEMrJZ0D6G9B6Qy8GCvXZ0Cnngug95dB6FXmu1MI_L2l7oZvhu8qIwqBdaeuAmkMNQcvkT15BipM";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PRIVATE) { console.error("VAPID_PRIVATE_KEY manquant"); process.exit(1); }

// --- Garde-fou horaire (les crons GitHub sont en UTC, Paris change d'heure) ---
const paris = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
const hour = paris.getHours(), day = paris.getDay(); // 0 = dimanche
const slot = process.env.SLOT; // "matin" ou "soir"
if (slot === "matin" && (hour !== 8 || day === 0)) { console.log(`skip (matin) h=${hour} d=${day}`); process.exit(0); }
if (slot === "soir" && hour !== 19) { console.log(`skip (soir) h=${hour}`); process.exit(0); }

const get = async t => (await fetch(`${SB_URL}/${t}?select=*`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } })).json();
const [emps, recs, vals, sigs, ovrs, subs] = await Promise.all([
  get("employees"), get("records"), get("validations"), get("week_signatures"), get("overrides"), get("push_subs")]);
if (!subs.length) { console.log("aucun appareil abonné"); process.exit(0); }

const key = d => d.toISOString().slice(0, 10);
const mondayOf = d => { const x = new Date(d); const g = (x.getDay() + 6) % 7; x.setDate(x.getDate() - g); return x; };
const actives = emps.filter(e => !e.archived);
const recMap = {}; recs.forEach(r => { (recMap[r.date] = recMap[r.date] || {})[r.emp_id] = r; });
const ovrMap = {}; ovrs.forEach(o => { (ovrMap[o.date] = ovrMap[o.date] || {})[o.emp_id] = o; });
const valSet = new Set(vals.map(v => v.date));
const sigSet = new Set(sigs.map(s => s.week + "|" + s.emp_id));

const since = e => (e.template && e.template.since) || null;
const bornBy = (e, dk) => { const s = since(e); return !s || key(mondayOf(new Date(dk + "T12:00:00"))) >= s; };
const planned = (dk, e) => {
  const s = since(e); if (s && key(mondayOf(new Date(dk + "T12:00:00"))) < s) return { work: false };
  const o = ovrMap[dk] && ovrMap[dk][e.id]; if (o) return { work: !!o.work };
  const wd = new Date(dk + "T12:00:00").getDay();
  const t = (e.template || {})[wd]; return { work: !!(t && t.work) };
};
const dayDone = r => { if (!r) return false;
  if (r.arr_status === "absent") return !!r.abs_motif;
  if (!r.arr_status) return false;
  if (r.dep_status === "parti" || r.dep_status === "avance") return true;
  if (r.dep_status === "heuresup") return (r.hs_min || 0) > 0;
  return false; };

const today = new Date(paris); today.setHours(12, 0, 0, 0);
const curWeek = key(mondayOf(today));
let nSig = 0, nDays = 0, nMiss = 0;
for (let w = 1; w <= 8; w++) {
  const ws = mondayOf(today); ws.setDate(ws.getDate() - 7 * w);
  const wk = key(ws); if (wk >= curWeek) continue;
  const parts = new Set();
  sigs.filter(s => s.week === wk).forEach(s => parts.add(s.emp_id));
  for (let i = 0; i < 6; i++) { const d = new Date(ws); d.setDate(ws.getDate() + i);
    const m = recMap[key(d)] || {}; Object.keys(m).forEach(id => parts.add(id)); }
  parts.forEach(id => { const e = emps.find(x => x.id === id); if (e && !sigSet.has(wk + "|" + id)) nSig++; });
}
for (let i = 1; i <= 14; i++) {
  const d = new Date(today); d.setDate(today.getDate() - i);
  if (d.getDay() === 0) continue;
  const dk = key(d); if (valSet.has(dk)) continue;
  const all = actives.filter(e => bornBy(e, dk)).filter(e => planned(dk, e).work || (recMap[dk] && recMap[dk][e.id] && recMap[dk][e.id].arr_status));
  if (!all.length) continue;
  const miss = all.filter(e => !dayDone(recMap[dk] && recMap[dk][e.id])).length;
  if (miss) { nDays++; nMiss += miss; } else nDays++;
}
const nTel = actives.filter(e => !e.tel).length;
const total = nSig + nDays + nTel;
if (!total) { console.log("rien à signaler 🎉"); process.exit(0); }

const parts = [];
if (nSig) parts.push(`${nSig} signature${nSig > 1 ? "s" : ""} de semaine en attente`);
if (nDays) parts.push(`${nDays} journée${nDays > 1 ? "s" : ""} à compléter/signer`);
if (nTel) parts.push(`${nTel} fiche${nTel > 1 ? "s" : ""} sans téléphone`);
const body = parts.join(" · ");
const title = slot === "matin" ? "☀️ Pointage — à faire aujourd'hui" : "🌙 Pointage — avant de fermer";

webpush.setVapidDetails("mailto:cbourgeoisfouad@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);
const payload = JSON.stringify({ title, body, url: "/?goto=afaire" });
let ok = 0;
for (const s of subs) {
  try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); ok++; }
  catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) // abonnement mort → nettoyage
      await fetch(`${SB_URL}/push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    else console.error("envoi KO", err.statusCode || err.message);
  }
}
console.log(`envoyé à ${ok}/${subs.length} appareil(s) : ${body}`);

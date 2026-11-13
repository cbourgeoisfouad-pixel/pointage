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
if (slot === "menage" && (hour !== 8 || day === 0) && process.env.FORCE !== "1") { console.log(`skip (menage) h=${hour} d=${day}`); process.exit(0); }

// Supabase limite à 1000 lignes par requête : pagination pour tout récupérer
const get = async t => {
  const out = [];
  for (let page = 0; page < 50; page++) {
    const r = await fetch(`${SB_URL}/${t}?select=*&limit=1000&offset=${page * 1000}`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    const data = await r.json();
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
};
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

/* ---- Créneau "menage" (8h45) : qui fait le nettoyage aujourd'hui ----
   Réplique EXACTE de la rotation du planning (printWeekPlanningPDF). */
if (slot === "menage") {
  const toMin = t => { if (!t || !t.includes(":")) return null; const [a, b] = t.split(":").map(Number); return a * 60 + b; };
  const posteOf = e => e.poste === "laveur" ? "finition" : (e.poste || "finition");
  const roster = actives.filter(e => ["aspirateur", "finition"].includes(posteOf(e)));
  const cmpMat = (a, b) => String(a.matricule || "").localeCompare(String(b.matricule || ""), "fr", { numeric: true });
  const plannedFull = (dk, e) => {
    const t = e.template || {};
    const monday = key(mondayOf(new Date(dk + "T12:00:00")));
    if (t.since && monday < t.since) return { work: false };
    if (t.until && dk > t.until) return { work: false };
    const o = ovrMap[dk] && ovrMap[dk][e.id];
    if (o) return { work: !!o.work, arr: o.arr || "", dep: o.dep || "" };
    const wd = new Date(dk + "T12:00:00").getDay();
    const x = t[wd]; return x ? { work: !!x.work, arr: x.arr || "", dep: x.dep || "" } : { work: false };
  };
  const eligMorning = dk => roster.filter(e => {
    const p = plannedFull(dk, e), en = (recMap[dk] && recMap[dk][e.id]) || {};
    return p.work && p.arr === "09:00" && !(en.arr_status === "absent");
  });
  const eligEve = dk => roster.filter(e => {
    const p = plannedFull(dk, e), en = (recMap[dk] && recMap[dk][e.id]) || {};
    return p.work && p.dep && toMin(p.dep) !== null && toMin(p.dep) >= toMin("18:00") && !(en.arr_status === "absent");
  });
  const starts9 = e => { const t = e.template || {}; for (let d = 1; d <= 6; d++) { const x = t[d]; if (x && x.work && x.arr === "09:00") return true; } return false; };
  const EPOCH = new Date("2026-09-09T12:00:00");
  const target = new Date(paris); target.setHours(12, 0, 0, 0);
  const targetKey = key(target);
  const nT = {}, lT = {}, nE = {}, lE = {};
  let morningId = null, eveId = null, n = 0;
  for (let d = new Date(EPOCH); key(d) <= targetKey && n < 800; d.setDate(d.getDate() + 1), n++) {
    if (d.getDay() === 0) continue;
    const dk = key(d);
    const em = eligMorning(dk);
    let mId = null;
    if (em.length) {
      em.sort((a, b) => (nT[a.id] || 0) - (nT[b.id] || 0) || (lT[a.id] || 0) - (lT[b.id] || 0) || cmpMat(a, b));
      const c = em[0]; nT[c.id] = (nT[c.id] || 0) + 1; lT[c.id] = n + 1; mId = c.id;
    }
    if (d.getDay() === 6) {
      let ev = eligEve(dk).filter(e => e.id !== mId);
      if (!ev.length) ev = eligEve(dk);
      if (ev.length) {
        ev.sort((a, b) => (starts9(a) ? 1 : 0) - (starts9(b) ? 1 : 0) || (nE[a.id] || 0) - (nE[b.id] || 0) || (lE[a.id] || 0) - (lE[b.id] || 0) || cmpMat(a, b));
        const c = ev[0]; nE[c.id] = (nE[c.id] || 0) + 1; lE[c.id] = n + 1;
        if (dk === targetKey) eveId = c.id;
      }
    }
    if (dk === targetKey) morningId = mId;
  }
  const nameOf = id => { const e = emps.find(x => x.id === id); return e ? `${e.prenom} ${e.nom}`.trim() : null; };
  const mName = morningId && nameOf(morningId), eName = eveId && nameOf(eveId);
  if (!mName && !eName) { console.log("personne d'éligible aujourd'hui"); process.exit(0); }
  let body = mName ? `9h00-9h15 : ${mName}` : "";
  if (eName) body += (body ? "\n" : "") + `17h45-18h00 : ${eName}`;
  // Un tap sur la notification → WhatsApp s'ouvre sur le salarié, message pré-écrit
  const waIntl = t => { let n = String(t || "").replace(/[^\d+]/g, ""); if (n.startsWith("+")) n = n.slice(1); else if (n.startsWith("00")) n = n.slice(2); else if (n.startsWith("0")) n = "33" + n.slice(1); return n; };
  const waTarget = emps.find(x => x.id === (morningId || eveId));
  let url = "/";
  if (waTarget && waTarget.tel) {
    const prenom = (waTarget.prenom || "").trim();
    const creneau = morningId ? "de 9h00 à 9h15" : "de 17h45 à 18h00";
    const msg = `🧹 Salut ${prenom}, c'est ton tour aujourd'hui : nettoyage de l'espace de pause et des toilettes ${creneau}. Merci !`;
    url = `https://wa.me/${waIntl(waTarget.tel)}?text=${encodeURIComponent(msg)}`;
  }
  body += "\n👆 Touche pour lui envoyer le WhatsApp";
  webpush.setVapidDetails("mailto:cbourgeoisfouad@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title: "🧹 Ménage du jour", body, url });
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); ok++; }
    catch (err) { console.error("envoi KO", err.statusCode || err.message); }
  }
  console.log(`menage → envoyé à ${ok}/${subs.length} : ${body.replace("\n", " · ")}`);
  process.exit(0);
}

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

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore(), KEY = defineSecret("GEMINI_API_KEY");
const opt = { secrets: [KEY], region: "us-central1", maxInstances: 10 };
const bad = (c, m) => new HttpsError(c, m);
const uidOf = (a) => { if (!a) throw bad("unauthenticated", "Login required"); return a.uid; };
const str = (x, n = 300) => String(x || "").trim().slice(0, n);

async function gemini(parts) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY.value() },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } }),
  });
  const j = await r.json();
  if (j.error) throw bad("internal", j.error.message);
  return JSON.parse(j.candidates[0].content.parts[0].text);
}
// max 20 AI calls per user per hour
async function rate(uid) {
  const ref = db.doc(`rl/${uid}`), h = Math.floor(Date.now() / 36e5), d = (await ref.get()).data() || {};
  const c = d.h === h ? d.c : 0;
  if (c >= 20) throw bad("resource-exhausted", "Too many requests, try later");
  await ref.set({ h, c: c + 1 });
}
const tok = (t) => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

exports.analyzePhoto = onCall(opt, async ({ auth, data }) => {
  const uid = uidOf(auth); await rate(uid);
  const img = String(data.image || "");
  if (!img || img.length > 1.5e6) throw bad("invalid-argument", "Bad image");
  return gemini([
    { text: 'Describe this item for a lost-and-found post. Return JSON {"title":"short","category":"Electronics|Wallets|Documents|Keys|Bags|Other","desc":"colour, brand, visible features; no personal data"}' },
    { inlineData: { mimeType: "image/jpeg", data: img } },
  ]);
});

exports.createItem = onCall(opt, async ({ auth, data: d }) => {
  const uid = uidOf(auth); await rate(uid);
  const it = { type: d.type === "Found" ? "Found" : "Lost", title: str(d.title, 100), desc: str(d.desc), category: str(d.category, 20) || "Other", location: str(d.location, 100), owner: uid, status: "Pending", ts: Date.now() };
  const phone = str(d.phone, 20);
  if (!it.title || !phone) throw bad("invalid-argument", "Missing fields");
  const ref = db.collection("items").doc();
  if (it.type === "Found") {
    const secret = str(d.secret, 600);
    if (secret.length < 15) throw bad("invalid-argument", "Add more secret details");
    let qs = await gemini([{ text: `Secret details of a found item: "${secret}". Write 3-5 multiple-choice questions to verify the real owner. Never reveal the secret inside a question. Each has exactly 4 options: 1 true detail + 3 plausible wrong ones. Return JSON array: [{"q":{"en":"","hi":"","mr":""},"o":[{"en":"","hi":"","mr":""}],"a":<index of true option>}] (hi = Hindi, mr = Marathi).` }]);
    qs = (Array.isArray(qs) ? qs : []).filter((x) => x.q && x.o?.length === 4 && x.o[x.a]).slice(0, 5).map((x) => {
      const right = x.o[x.a], o = [...x.o].sort(() => Math.random() - 0.5);
      return { q: x.q, o, a: o.indexOf(right) };
    });
    if (qs.length < 2) throw bad("failed-precondition", "AI could not make questions. Add more detail.");
    await ref.collection("private").doc("v").set({ phone, qs });
  } else it.phone = phone;
  await ref.set(it);
  // smart matching: same category, opposite type, word overlap
  const A = tok(it.title + " " + it.desc);
  const snap = await db.collection("items").where("type", "==", it.type === "Lost" ? "Found" : "Lost").where("category", "==", it.category).where("status", "==", "Pending").limit(50).get();
  const matches = snap.docs.map((s) => {
    const B = tok(s.data().title + " " + s.data().desc), inter = [...A].filter((w) => B.has(w)).length;
    return { id: s.id, title: s.data().title, score: inter / (A.size + B.size - inter || 1) };
  }).filter((m) => m.score > 0.15).sort((a, b) => b.score - a.score).slice(0, 3);
  return { id: ref.id, matches };
});

async function load(id, uid) {
  const ref = db.doc(`items/${id}`);
  const [it, p, c] = await Promise.all([ref.get(), ref.collection("private").doc("v").get(), ref.collection("claims").doc(uid).get()]);
  if (!it.exists || !p.exists || it.data().status !== "Pending") throw bad("failed-precondition", "Not available");
  if (it.data().owner === uid) throw bad("failed-precondition", "Own item");
  const fails = c.data()?.fails || 0;
  if (fails >= 3) throw bad("permission-denied", "locked");
  return { ref, p: p.data(), fails };
}
exports.startClaim = onCall({ region: "us-central1" }, async ({ auth, data }) => {
  const { p } = await load(data.id, uidOf(auth));
  return { questions: p.qs.map(({ q, o }) => ({ q, o })) }; // correct answers never leave the server
});
exports.submitClaim = onCall({ region: "us-central1" }, async ({ auth, data }) => {
  const uid = uidOf(auth), { ref, p, fails } = await load(data.id, uid);
  const a = data.answers;
  if (!Array.isArray(a) || a.length !== p.qs.length) throw bad("invalid-argument", "Answer all");
  if (!p.qs.every((q, i) => q.a === a[i])) {
    await ref.collection("claims").doc(uid).set({ fails: fails + 1 });
    return { ok: false, left: 2 - fails };
  }
  await ref.update({ status: "Resolved", resolvedAt: Date.now(), claimer: uid });
  await ref.collection("private").doc("v").update({ claimerPhone: str(data.phone, 20) });
  return { ok: true, phone: p.phone };
});

exports.setStatus = onCall({ region: "us-central1" }, async ({ auth, data }) => {
  const uid = uidOf(auth), ref = db.doc(`items/${data.id}`), s = await ref.get();
  if (!s.exists || s.data().owner !== uid) throw bad("permission-denied", "Not yours");
  if (data.action === "delete") await db.recursiveDelete(ref);
  else await ref.update(data.action === "resolve" ? { status: "Resolved", resolvedAt: Date.now() } : { status: "Pending", resolvedAt: null });
  return { ok: true };
});

exports.cleanup = onSchedule({ schedule: "every 24 hours", region: "us-central1" }, async () => {
  const s = await db.collection("items").where("resolvedAt", "<", Date.now() - 30 * 864e5).get();
  for (const d of s.docs) await db.recursiveDelete(d.ref);
});

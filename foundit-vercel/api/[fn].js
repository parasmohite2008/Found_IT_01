const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
class E extends Error { constructor(m, c = 400) { super(m); this.c = c; } }
const str = (x, n = 300) => String(x || "").trim().slice(0, n);
const tok = (t) => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

async function gemini(parts) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } }),
  });
  const j = await r.json();
  if (j.error) throw new E(j.error.message, 500);
  return JSON.parse(j.candidates[0].content.parts[0].text);
}
async function rate(uid) { // max 20 AI calls per user per hour
  const ref = db.doc(`rl/${uid}`), h = Math.floor(Date.now() / 36e5), d = (await ref.get()).data() || {};
  const c = d.h === h ? d.c : 0;
  if (c >= 20) throw new E("Too many requests, try later", 429);
  await ref.set({ h, c: c + 1 });
}
async function load(id, uid) {
  const ref = db.doc(`items/${str(id, 40)}`);
  const [it, p, c] = await Promise.all([ref.get(), ref.collection("private").doc("v").get(), ref.collection("claims").doc(uid).get()]);
  if (!it.exists || !p.exists || it.data().status !== "Pending") throw new E("Not available");
  if (it.data().owner === uid) throw new E("This is your own item");
  const fails = c.data()?.fails || 0;
  if (fails >= 3) throw new E("Locked after 3 failed attempts", 403);
  return { ref, p: p.data(), fails };
}

const H = {
  async analyzePhoto(uid, d) {
    await rate(uid);
    const img = String(d.image || "");
    if (!img || img.length > 1.5e6) throw new E("Bad image");
    return gemini([
      { text: 'Describe this item for a lost-and-found post. Return JSON {"title":"short","category":"Electronics|Wallets|Documents|Keys|Bags|Other","desc":"colour, brand, visible features; no personal data"}' },
      { inlineData: { mimeType: "image/jpeg", data: img } },
    ]);
  },
  async createItem(uid, d) {
    await rate(uid);
    const it = { type: d.type === "Found" ? "Found" : "Lost", title: str(d.title, 100), desc: str(d.desc), category: str(d.category, 20) || "Other", location: str(d.location, 100), owner: uid, status: "Pending", ts: Date.now() };
    const phone = str(d.phone, 20);
    if (!it.title || !phone) throw new E("Missing fields");
    const ref = db.collection("items").doc();
    if (it.type === "Found") {
      const secret = str(d.secret, 600);
      if (secret.length < 15) throw new E("Add more secret details");
      let qs = await gemini([{ text: `Secret details of a found item: "${secret}". Write 3-5 multiple-choice questions to verify the real owner. Never reveal the secret inside a question. Each has exactly 4 options: 1 true detail + 3 plausible wrong ones. Return JSON array: [{"q":{"en":"","hi":"","mr":""},"o":[{"en":"","hi":"","mr":""}],"a":<index of true option>}] (hi = Hindi, mr = Marathi).` }]);
      qs = (Array.isArray(qs) ? qs : []).filter((x) => x.q && x.o?.length === 4 && x.o[x.a]).slice(0, 5).map((x) => {
        const right = x.o[x.a], o = [...x.o].sort(() => Math.random() - 0.5);
        return { q: x.q, o, a: o.indexOf(right) };
      });
      if (qs.length < 2) throw new E("AI could not make questions. Add more detail.");
      await ref.collection("private").doc("v").set({ phone, qs });
    } else it.phone = phone;
    await ref.set(it);
    const A = tok(it.title + " " + it.desc);
    const snap = await db.collection("items").where("type", "==", it.type === "Lost" ? "Found" : "Lost").where("category", "==", it.category).where("status", "==", "Pending").limit(50).get();
    const matches = snap.docs.map((s) => {
      const B = tok(s.data().title + " " + s.data().desc), n = [...A].filter((w) => B.has(w)).length;
      return { id: s.id, title: s.data().title, score: n / (A.size + B.size - n || 1) };
    }).filter((m) => m.score > 0.15).sort((a, b) => b.score - a.score).slice(0, 3);
    return { id: ref.id, matches };
  },
  async startClaim(uid, d) {
    const { p } = await load(d.id, uid);
    return { questions: p.qs.map(({ q, o }) => ({ q, o })) }; // correct answers never leave the server
  },
  async submitClaim(uid, d) {
    const { ref, p, fails } = await load(d.id, uid), a = d.answers;
    if (!Array.isArray(a) || a.length !== p.qs.length) throw new E("Answer all questions");
    if (!p.qs.every((q, i) => q.a === a[i])) {
      await ref.collection("claims").doc(uid).set({ fails: fails + 1 });
      return { ok: false, left: 2 - fails };
    }
    await ref.update({ status: "Resolved", resolvedAt: Date.now(), claimer: uid });
    await ref.collection("private").doc("v").update({ claimerPhone: str(d.phone, 20) });
    return { ok: true, phone: p.phone };
  },
  async setStatus(uid, d) {
    const ref = db.doc(`items/${str(d.id, 40)}`), s = await ref.get();
    if (!s.exists || s.data().owner !== uid) throw new E("Not yours", 403);
    if (d.action === "delete") await db.recursiveDelete(ref);
    else await ref.update(d.action === "resolve" ? { status: "Resolved", resolvedAt: Date.now() } : { status: "Pending", resolvedAt: null });
    return { ok: true };
  },
};

module.exports = async (req, res) => {
  try {
    const fn = req.query.fn;
    if (fn === "cleanup") { // daily cron: delete items resolved 30+ days ago
      if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new E("Forbidden", 401);
      const s = await db.collection("items").where("resolvedAt", "<", Date.now() - 30 * 864e5).get();
      for (const d of s.docs) await db.recursiveDelete(d.ref);
      return res.json({ deleted: s.size });
    }
    if (req.method !== "POST" || !H[fn]) throw new E("Not found", 404);
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const uid = (await admin.auth().verifyIdToken(token).catch(() => { throw new E("Please login again", 401); })).uid;
    res.json(await H[fn](uid, req.body || {}));
  } catch (e) { res.status(e.c || 500).json({ error: e.message }); }
};

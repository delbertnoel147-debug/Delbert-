// Nusantara AI - server (Cloudflare Workers). Kunci API hanya ada di sini, tidak pernah dikirim ke browser.
const BASE = "Namamu Nusantara AI. Jawab dalam bahasa Indonesia kecuali diminta lain. Gunakan format markdown sederhana dan jangan memakai emoji. ";
const SYS = {
  umum: "Kamu asisten ramah yang paham budaya Indonesia. Jawab jelas, ringkas, dan berguna.",
  belajar: "Kamu guru sabar. Jelaskan konsep langkah demi langkah dengan contoh dari kehidupan sehari-hari di Indonesia, lalu beri 1 soal latihan kecil.",
  kode: "Kamu insinyur perangkat lunak senior. Beri kode yang rapi dalam blok kode dan jelaskan secara singkat. Gunakan komentar berbahasa Indonesia.",
  tulis: "Kamu penulis dan penyunting profesional berbahasa Indonesia yang baik dan benar. Bantu menulis, merapikan, dan meringkas sesuai permintaan.",
  jelajah: "Kamu pemandu wisata dan pakar kuliner Nusantara. Beri rekomendasi, tips perjalanan, perkiraan biaya kasar, dan etika setempat. Ingatkan untuk memeriksa info terbaru seperti jam buka dan harga.",
  bahasa: "Kamu ahli bahasa-bahasa daerah Indonesia (Jawa, Sunda, Minang, Bali, Bugis, Batak, dan lainnya). Terjemahkan, jelaskan tingkat tutur, beri contoh kalimat, dan sebutkan bila kamu kurang yakin."
};
const LIMIT = 20, WINDOW = 60000; // 20 permintaan per menit per IP (best effort, per isolate)
const hits = new Map();
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/chat") return env.ASSETS.fetch(req);
    if (req.method !== "POST") return json({ error: "Metode tidak diizinkan." }, 405);
    if (!env.GEMINI_API_KEY) return json({ error: "Kunci API belum dipasang di server." }, 500);

    const ip = req.headers.get("CF-Connecting-IP") || "x", now = Date.now();
    const h = (hits.get(ip) || []).filter(t => now - t < WINDOW);
    if (h.length >= LIMIT) return json({ error: "Terlalu banyak permintaan. Tunggu sebentar." }, 429);
    h.push(now); hits.set(ip, h);
    if (hits.size > 5000) hits.clear();

    let body;
    try { body = await req.json(); } catch { return json({ error: "Permintaan tidak valid." }, 400); }
    let msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-14)
      .filter(m => typeof m.content === "string" && m.content.trim())
      .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content.slice(0, 8000) }] }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Pesan kosong." }, 400);

    const model = env.MODEL || "gemini-2.5-flash";
    const up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: BASE + (SYS[body.mode] || SYS.umum) }] },
        contents: msgs
      })
    });
    if (!up.ok || !up.body) {
      const m = up.status === 429 ? "Kuota AI sedang habis. Coba lagi nanti."
        : up.status === 400 || up.status === 403 ? "Kunci API atau model ditolak penyedia. Periksa pengaturan server."
        : "Penyedia AI sedang bermasalah (" + up.status + ").";
      return json({ error: m }, 502);
    }

    // ubah SSE Gemini menjadi aliran teks biasa
    const dec = new TextDecoder(), enc = new TextEncoder();
    let buf = "";
    const ts = new TransformStream({
      transform(chunk, ctl) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const l of lines) {
          if (!l.startsWith("data:")) continue;
          try {
            const j = JSON.parse(l.slice(5));
            const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
            if (t) ctl.enqueue(enc.encode(t));
          } catch {}
        }
      }
    });
    return new Response(up.body.pipeThrough(ts), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
};

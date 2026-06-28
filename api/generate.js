// ✅ CommonJS format (NOT ESM) — required for Vercel .js serverless functions
// ESM "export default" in a .js file causes env var timing issues on Vercel

module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── READ API KEY ──────────────────────────────────────────────────────────
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  // ✅ DEBUG LOG — visible in Vercel Function Logs tab
  console.log('[CaptionAI] Key present:', !!apiKey);
  console.log('[CaptionAI] Key prefix:', apiKey ? apiKey.substring(0, 8) + '...' : 'NONE');
  console.log('[CaptionAI] Node version:', process.version);
  console.log('[CaptionAI] All env keys:', Object.keys(process.env).filter(k => k.includes('GEMINI')));

  if (!apiKey) {
    return res.status(500).json({
      error: 'API_KEY_MISSING',
      message: 'GEMINI_API_KEY not found in Vercel Environment Variables. Add it in Vercel → Settings → Environment Variables, then Redeploy.'
    });
  }

  // ── VALIDATE REQUEST BODY ─────────────────────────────────────────────────
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return res.status(400).json({ error: 'PROMPT_MISSING', message: 'Prompt is required.' });
  }

  // ── MODEL FALLBACK CHAIN ──────────────────────────────────────────────────
  // Try models in order until one works on the free tier
  // gemini-2.0-flash-lite → gemini-1.5-flash → gemini-1.5-flash-8b
  const MODELS = [
    'gemini-2.5-flash',   // Most generous free tier (30 RPM, 1500 RPD)
    'gemini-2.5-flash',        // Fallback (15 RPM, 1500 RPD)
    'gemini-2.5-flash',     // Last resort (15 RPM, 1500 RPD)
  ];

  // ── CALL GEMINI WITH FALLBACK ─────────────────────────────────────────────
  let lastError = null;

  for (const MODEL of MODELS) {
    // ✅ CORRECT endpoint: v1beta + key as query param only
    // Do NOT add Authorization header — that triggers Vertex AI auth (paid)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

    console.log(`[CaptionAI] Trying model: ${MODEL}`);

    try {
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ✅ NO Authorization header — AI Studio key auth via ?key= param only
          // Adding Authorization would route to Vertex AI (paid) instead of AI Studio (free)
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt.trim() }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1024,
            candidateCount: 1
          }
        })
      });

      const data = await geminiRes.json();
      const errMsg    = data?.error?.message || '';
      const errStatus = data?.error?.status  || '';
      const errCode   = data?.error?.code    || geminiRes.status;

      console.log(`[CaptionAI] Model ${MODEL} → HTTP ${geminiRes.status}, errStatus: ${errStatus || 'none'}`);

      // If quota exceeded on this model → try next model
      if (
        errStatus === 'RESOURCE_EXHAUSTED' ||
        errMsg.toLowerCase().includes('quota') ||
        geminiRes.status === 429
      ) {
        console.log(`[CaptionAI] ${MODEL} quota exceeded — trying next model`);
        lastError = { type: 'QUOTA_EXCEEDED', model: MODEL, msg: errMsg };
        continue; // try next model
      }

      // Invalid key → no point retrying other models
      if (errCode === 400 && errMsg.toLowerCase().includes('api key')) {
        return res.status(401).json({
          error: 'INVALID_API_KEY',
          message: 'Invalid API key. Make sure GEMINI_API_KEY in Vercel is a valid AI Studio key from aistudio.google.com (starts with "AIzaSy...").'
        });
      }

      // Not authorized / billing issue → no point retrying
      if (errCode === 403) {
        return res.status(403).json({
          error: 'KEY_NOT_AUTHORIZED',
          message: 'API key not authorized. This usually means the key is from Google Cloud Console (NOT AI Studio). Please create a fresh key at aistudio.google.com and update GEMINI_API_KEY in Vercel.'
        });
      }

      // Other non-OK error
      if (!geminiRes.ok) {
        console.log(`[CaptionAI] ${MODEL} error: ${errCode} ${errMsg}`);
        lastError = { type: 'GEMINI_ERROR', model: MODEL, msg: errMsg };
        continue; // try next model
      }

      // ✅ SUCCESS — extract text
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) {
        lastError = { type: 'EMPTY_RESPONSE', model: MODEL };
        continue;
      }

      console.log(`[CaptionAI] ✅ Success with model: ${MODEL}`);
      return res.status(200).json({ text, model: MODEL });

    } catch (fetchErr) {
      console.log(`[CaptionAI] Fetch error on ${MODEL}:`, fetchErr.message);
      lastError = { type: 'NETWORK_ERROR', model: MODEL, msg: fetchErr.message };
      continue;
    }
  }

  // ── ALL MODELS FAILED ─────────────────────────────────────────────────────
  console.log('[CaptionAI] All models failed. Last error:', JSON.stringify(lastError));

  if (lastError?.type === 'QUOTA_EXCEEDED') {
    return res.status(429).json({
      error: 'QUOTA_EXCEEDED',
      message: `All free-tier models quota exhausted for today. Free limit is 1500 requests/day. Please try again tomorrow.\n\nTried: ${MODELS.join(', ')}`
    });
  }

  return res.status(500).json({
    error: lastError?.type || 'UNKNOWN_ERROR',
    message: lastError?.msg || 'All models failed. Please try again later.'
  });
};

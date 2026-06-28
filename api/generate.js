// CommonJS — required for Vercel .js serverless functions
module.exports = async function handler(req, res) {

  // ── CORS ────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── API KEY ──────────────────────────────────────────────────────────────
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  console.log('[CaptionAI] Key present:', !!apiKey, '| prefix:', apiKey.substring(0, 8) || 'NONE');

  if (!apiKey) {
    return res.status(500).json({
      error: 'API_KEY_MISSING',
      message: 'GEMINI_API_KEY not set in Vercel Environment Variables.'
    });
  }

  // ── REQUEST BODY ─────────────────────────────────────────────────────────
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'PROMPT_MISSING', message: 'Prompt is required.' });
  }

  // ── HELPERS ──────────────────────────────────────────────────────────────

  // Parse + validate Gemini raw text → structured object or null
  function parseGeminiText(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // Strip BOM + whitespace
    let s = raw.replace(/^\uFEFF/, '').trim();

    // Strip ALL markdown fences (handles nested / multiple)
    s = s.replace(/```(?:json)?\s*/gi, '').replace(/```/gi, '').trim();

    // Candidates to try in order
    const candidates = [s];

    // Also try: slice from first { to last }
    const first = s.indexOf('{');
    const last  = s.lastIndexOf('}');
    if (first !== -1 && last > first) {
      candidates.push(s.slice(first, last + 1));
    }

    // Also try: extract via greedy regex
    const m = s.match(/\{[\s\S]*\}/);
    if (m) candidates.push(m[0]);

    for (const candidate of candidates) {
      try {
        const obj = JSON.parse(candidate);
        // Validate structure
        if (
          obj &&
          Array.isArray(obj.captions) &&
          obj.captions.length >= 1 &&
          obj.captions.every(c => typeof c === 'string' && c.trim().length > 0) &&
          Array.isArray(obj.hashtags) &&
          obj.hashtags.length >= 1
        ) {
          return obj;
        }
      } catch (_) {}
    }

    return null; // unparseable or invalid structure
  }

  // Call Gemini once — returns { ok, data, errType, errMsg }
  async function callGemini(model, promptText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.7,          // lower = more predictable JSON output
            maxOutputTokens: 1200,     // enough for 3 captions + 10 hashtags
            candidateCount: 1,
            responseMimeType: 'application/json'  // force JSON mode where supported
          }
        })
      });

      const data = await r.json();
      const errMsg    = data?.error?.message || '';
      const errStatus = data?.error?.status  || '';
      const errCode   = data?.error?.code    || r.status;

      if (errStatus === 'RESOURCE_EXHAUSTED' || errMsg.toLowerCase().includes('quota') || r.status === 429) {
        return { ok: false, errType: 'QUOTA_EXCEEDED', errMsg };
      }
      if (errCode === 400 && errMsg.toLowerCase().includes('api key')) {
        return { ok: false, errType: 'INVALID_API_KEY', errMsg };
      }
      if (errCode === 403) {
        return { ok: false, errType: 'KEY_NOT_AUTHORIZED', errMsg };
      }
      if (!r.ok) {
        return { ok: false, errType: 'GEMINI_ERROR', errMsg: errMsg || `HTTP ${r.status}` };
      }

      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return { ok: true, raw };

    } catch (e) {
      return { ok: false, errType: 'NETWORK_ERROR', errMsg: e.message };
    }
  }

  // ── MODELS + RETRY CONFIG ────────────────────────────────────────────────
  const MODELS = [
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ];
  const MAX_JSON_RETRIES = 2; // per model: if Gemini returns bad JSON, retry prompt

  // Prompt instructs Gemini to return ONLY raw JSON — no prose, no fences
  const SYSTEM_PROMPT = `${prompt.trim()}

CRITICAL OUTPUT RULES — YOU MUST FOLLOW EXACTLY:
- Output ONLY a single raw JSON object. Nothing else.
- No markdown. No backticks. No code fences. No explanation. No extra text before or after.
- The JSON must start with { and end with } on the last character of your response.
- Every string value must be properly escaped.
- Required structure (fill with real content):
{"captions":["caption one","caption two","caption three"],"hashtags":["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8","#tag9","#tag10"]}`;

  // ── MAIN LOOP: model × retry ──────────────────────────────────────────────
  let lastErrType = 'UNKNOWN_ERROR';
  let lastErrMsg  = '';

  for (const model of MODELS) {
    console.log(`[CaptionAI] Trying model: ${model}`);

    for (let attempt = 1; attempt <= MAX_JSON_RETRIES; attempt++) {
      console.log(`[CaptionAI]   attempt ${attempt}/${MAX_JSON_RETRIES}`);

      const result = await callGemini(model, SYSTEM_PROMPT);

      if (!result.ok) {
        console.log(`[CaptionAI]   API error: ${result.errType} — ${result.errMsg}`);
        lastErrType = result.errType;
        lastErrMsg  = result.errMsg;

        // Fatal errors — stop everything, no point retrying any model
        if (result.errType === 'INVALID_API_KEY' || result.errType === 'KEY_NOT_AUTHORIZED') {
          return res.status(result.errType === 'INVALID_API_KEY' ? 401 : 403).json({
            error: result.errType,
            message: result.errMsg
          });
        }

        // Quota on this model — skip to next model immediately
        if (result.errType === 'QUOTA_EXCEEDED') break;

        // Other errors — retry same model
        continue;
      }

      // Got a raw text response — try to parse it
      console.log(`[CaptionAI]   raw text length: ${result.raw.length}`);
      console.log(`[CaptionAI]   raw preview: ${result.raw.substring(0, 120).replace(/\n/g, ' ')}`);

      const parsed = parseGeminiText(result.raw);

      if (parsed) {
        console.log(`[CaptionAI] ✅ Valid JSON on model=${model} attempt=${attempt}`);
        // Return clean validated structure — frontend gets ONLY this
        return res.status(200).json({
          captions: parsed.captions.slice(0, 3),   // max 3
          hashtags: parsed.hashtags.slice(0, 10),  // max 10
          model
        });
      }

      // Bad JSON — log and retry
      console.log(`[CaptionAI]   JSON parse/validation failed on attempt ${attempt}. Raw:`, result.raw.substring(0, 300));
      lastErrType = 'BAD_JSON';
      lastErrMsg  = 'Gemini returned incomplete or malformed JSON';
      // loop continues → next attempt with same model
    }

    console.log(`[CaptionAI] Model ${model} exhausted all attempts — trying next model`);
  }

  // ── ALL MODELS + RETRIES FAILED ──────────────────────────────────────────
  console.log('[CaptionAI] ❌ All models failed. Last error:', lastErrType, lastErrMsg);

  if (lastErrType === 'QUOTA_EXCEEDED') {
    return res.status(429).json({
      error: 'QUOTA_EXCEEDED',
      message: 'Free quota exceeded (1,500 req/day). Please try again tomorrow.'
    });
  }

  return res.status(500).json({
    error: lastErrType,
    message: lastErrMsg || 'All models failed after retries. Please try again.'
  });
};


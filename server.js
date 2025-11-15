// server.js — robust multi-model Replicate proxy with diagnostics
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || null;

if (!REPLICATE_API_KEY) {
  console.warn('WARNING: REPLICATE_API_KEY is NOT set. Set it in Render environment or .env');
}

// Models list: primary first, then fallbacks
const MODELS = [
  // primary (works for many): t2v-openjourney
  { model: process.env.REPLICATE_MODEL || 'talesofai/t2v-openjourney',
    version: process.env.REPLICATE_MODEL_VERSION || 'ddeb9cb588b955f1924613840b3c7282f17a0fbb4f6b8b6bc47cf8ae6dc07d29' },

  // fallback 1 (black-forest / flux)
  { model: 'black-forest-labs/flux-1.1-pro',
    version: process.env.REPLICATE_FLUX_V || 'f34a624e35e21f21252bc9d1c2ced0ce8d22aaf152b725dfbe13259d1e8bb068' },

  // fallback 2 (another popular one — may require credits)
  { model: 'zsxkib/zeroscope-v2-xl',
    version: process.env.REPLICATE_ZEROSCOPE_V || 'e5a849f5c5311f250e8a5ef4f7fda2ae39ebdedd4a4bf038f13f95d516a58752' }
];

// helper to sleep
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.use(cors());
app.use(bodyParser.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * POST /generate
 * Body: { prompt: string, duration?: number (sec), fps?: number, resolution?: string }
 */
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    const duration = Number(req.body?.duration || 4); // seconds
    const fps = Number(req.body?.fps || 12);
    const resolution = req.body?.resolution || '640x640';

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing prompt (string)' });
    }
    if (!REPLICATE_API_KEY) {
      return res.status(500).json({ error: 'REPLICATE_API_KEY not set on server (configure in Render env)' });
    }

    const results = []; // collect per-model diagnostics

    // Try each model in sequence until one returns video
    for (const m of MODELS) {
      const model = m.model;
      const version = m.version;
      const createUrl = `https://api.replicate.com/v1/models/${encodeURIComponent(model)}/versions/${encodeURIComponent(version)}/predictions`;

      console.log(`Attempting model: ${model}@${version}`);

      // Build input object — many models accept prompt / fps / duration / resolution, but not all; it's OK if model ignores extras
      const input = { prompt, duration, fps, resolution };

      // Create
      let createResp;
      try {
        createResp = await axios.post(createUrl, { input }, {
          headers: {
            Authorization: `Token ${REPLICATE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30_000
        });
        console.log(`[create][${model}] response:`, JSON.stringify(createResp.data));
      } catch (err) {
        const body = err?.response?.data || err.message;
        console.error(`[create][${model}] ERROR:`, body);
        results.push({ model, version, stage: 'create', ok: false, error: body });
        // try next model
        continue;
      }

      const predictionId = createResp.data?.id;
      if (!predictionId) {
        console.error(`[create][${model}] no prediction id. full createResp:`, createResp.data);
        results.push({ model, version, stage: 'create', ok: false, createResp: createResp.data });
        continue;
      }

      // Poll
      const pollUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
      let attempts = 0;
      let final = null;
      let lastPoll = null;
      while (attempts < 150) { // up to ~6 minutes with 2.5s wait
        attempts++;
        try {
          const pollResp = await axios.get(pollUrl, {
            headers: { Authorization: `Token ${REPLICATE_API_KEY}` },
            timeout: 30_000
          });
          lastPoll = pollResp.data;
          console.log(`[poll][${model}][${attempts}] status:`, pollResp.data.status);

          if (['succeeded', 'failed'].includes(pollResp.data.status)) {
            // log the final poll body for debugging
            console.log(`[poll][${model}] final poll response:`, JSON.stringify(pollResp.data));
          }

          if (pollResp.data.status === 'succeeded') {
            final = pollResp.data.output;
            results.push({ model, version, stage: 'poll', ok: true, attempts, poll: pollResp.data });
            break;
          }

          if (pollResp.data.status === 'failed') {
            results.push({ model, version, stage: 'poll', ok: false, attempts, poll: pollResp.data });
            break;
          }
        } catch (err) {
          const body = err?.response?.data || err.message;
          console.error(`[poll][${model}] ERROR:`, body);
          results.push({ model, version, stage: 'poll', ok: false, error: body });
          break;
        }

        // wait
        await sleep(2500);
      } // end poll loop

      // If final has content, check it
      if (final) {
        // final can be string or array; some models return array of frames or a URL list
        console.log(`[success][${model}] output:`, final);
        // Normalize: if array -> use first element
        const videoUrl = Array.isArray(final) ? final[0] : final;
        // respond success including which model produced it
        return res.json({ ok: true, model: `${model}@${version}`, video: videoUrl, trace: results });
      }

      // if we reached here, this model did not produce video; push last poll for debug and continue to next model
      results.push({ model, version, stage: 'no_output', lastPoll });
      console.log(`[no_output][${model}] trying next model if available...`);
      // short pause before next model
      await sleep(1500);
    } // end for each model

    // If we get here, all models failed or returned null
    console.error('All models tried; no video produced. Results:', JSON.stringify(results, null, 2));
    return res.status(500).json({
      ok: false,
      error: 'No video returned by any tried model',
      note: 'Check your Replicate account credits, API key validity, and model availability.',
      trace: results
    });

  } catch (err) {
    console.error('Unexpected server error:', err?.response?.data || err.message || err);
    return res.status(500).json({ ok: false, error: 'Server unexpected error', details: err?.response?.data || err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

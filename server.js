// server.js — verbose diagnostics for missing video output
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || null;

// Primary model (you can change this to another known working model)
const MODEL = process.env.REPLICATE_MODEL || 'zsxkib/zeroscope-v2-xl';
const MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION || 'e5a849f5c5311f250e8a5ef4f7fda2ae39ebdedd4a4bf038f13f95d516a58752';

console.log('Server starting...');
console.log('PORT:', PORT);
console.log('MODEL:', MODEL);
console.log('MODEL_VERSION:', MODEL_VERSION);
console.log('REPLICATE_API_KEY set?', !!REPLICATE_API_KEY);

app.use(cors());
app.use(bodyParser.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.post('/generate', async (req, res) => {
  try {
    if (!REPLICATE_API_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set on server' });

    const { prompt, duration = 4, fps = 24, resolution = '768x768' } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing prompt (string) in request body.' });
    }

    const createUrl = `https://api.replicate.com/v1/models/${encodeURIComponent(MODEL)}/versions/${encodeURIComponent(MODEL_VERSION)}/predictions`;
    console.log('[generate] creating prediction:', { prompt: prompt.slice(0,300), duration, fps, resolution });

    // create prediction
    const createResp = await axios.post(createUrl, {
      input: { prompt, duration, fps, resolution }
    }, {
      headers: {
        Authorization: `Token ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30_000
    }).catch(err => {
      console.error('[Replicate create] error status:', err?.response?.status);
      console.error('[Replicate create] error body:', err?.response?.data || err.message);
      throw err;
    });

    console.log('[Replicate create] response:', JSON.stringify(createResp.data, null, 2));

    const predictionId = createResp.data.id;
    if (!predictionId) {
      return res.status(500).json({ error: 'No prediction id returned by Replicate', createResponse: createResp.data });
    }

    // poll prediction
    const pollUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
    let final = null;
    let attempts = 0;

    while (attempts < 120) { // max ~5 minutes with 2.5s sleep
      attempts++;
      const pollResp = await axios.get(pollUrl, {
        headers: { Authorization: `Token ${REPLICATE_API_KEY}` },
        timeout: 30_000
      }).catch(err => {
        console.error('[Replicate poll] error:', err?.response?.data || err.message);
        throw err;
      });

      console.log(`[Replicate poll][${attempts}] status:`, pollResp.data.status);

      // Log the entire poll response when completed or failed for diagnosis
      if (['succeeded', 'failed'].includes(pollResp.data.status)) {
        console.log('[Replicate poll] final response:', JSON.stringify(pollResp.data, null, 2));
      }

      if (pollResp.data.status === 'succeeded') {
        final = pollResp.data.output;
        break;
      }

      if (pollResp.data.status === 'failed') {
        return res.status(500).json({
          error: 'Replicate prediction failed',
          prediction: pollResp.data
        });
      }

      // wait before next poll
      await new Promise(r => setTimeout(r, 2500));
    }

    if (!final) {
      // didn't finish in time or no output — return the last known prediction object for debugging
      const lastResp = await axios.get(pollUrl, {
        headers: { Authorization: `Token ${REPLICATE_API_KEY}` }
      }).catch(err => {
        console.error('[Replicate final fetch] error:', err?.response?.data || err.message);
        return null;
      });

      console.error('[generate] No final output. Last poll response:', lastResp ? JSON.stringify(lastResp.data, null, 2) : null);

      return res.status(500).json({
        error: 'No video returned (prediction completed with null output or timed out)',
        note: 'Check model availability, account credits, or model-specific input parameters',
        lastPrediction: lastResp ? lastResp.data : null
      });
    }

    // Success — return video (could be array or string)
    return res.json({ video: final });

  } catch (err) {
    console.error('[generate] unexpected error:', err?.response?.data || err.message || err);
    const details = err?.response?.data || err?.message || String(err);
    return res.status(500).json({ error: 'Server error during generation', details });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

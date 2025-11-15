// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

// DEBUG LOG
console.log("REPLICATE_API_KEY loaded?", REPLICATE_API_KEY ? "YES" : "NO");

app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// POST /generate
app.post("/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // call replicate API
    const job = await axios.post(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/versions/f34a624e35e21f21252bc9d1c2ced0ce8d22aaf152b725dfbe13259d1e8bb068/predictions",
      {
        input: {
          prompt: prompt,
          fps: 24,
          resolution: "768x768",
          duration: 4
        }
      },
      {
        headers: {
          Authorization: `Bearer ${REPLICATE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const predictionId = job.data.id;

    // Poll prediction
    let result = null;

    while (true) {
      const poll = await axios.get(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: {
            Authorization: `Bearer ${REPLICATE_API_KEY}`
          }
        }
      );

      if (poll.data.status === "succeeded") {
        result = poll.data.output;
        break;
      }

      if (poll.data.status === "failed") {
        return res.status(500).json({ error: "Video generation failed." });
      }

      await new Promise(r => setTimeout(r, 2500));
    }

    // result contains mp4 video URL
    return res.json({ video: result });

  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// fallback → frontend
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () => console.log("Server running on port", PORT));

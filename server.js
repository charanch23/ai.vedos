require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

// Stable Text-to-Video model (Zeroscope)
const MODEL = "zsxkib/zeroscope-v2-xl";
const MODEL_VERSION = "e5a849f5c5311f250e8a5ef4f7fda2ae39ebdedd4a4bf038f13f95d516a58752";

console.log("Server starting...");
console.log("REPLICATE_API_KEY loaded?", REPLICATE_API_KEY ? "YES" : "NO");

app.use(cors());
app.use(bodyParser.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));

app.post("/generate", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!REPLICATE_API_KEY)
      return res.status(500).json({ error: "REPLICATE_API_KEY not set" });

    if (!prompt)
      return res.status(400).json({ error: "Prompt is required" });

    // Create replicate job
    const create = await axios.post(
      `https://api.replicate.com/v1/models/${MODEL}/versions/${MODEL_VERSION}/predictions`,
      {
        input: {
          prompt,
          fps: 24,
          duration: 4,
          resolution: "768x768"
        }
      },
      {
        headers: {
          Authorization: `Token ${REPLICATE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const id = create.data.id;

    // Poll replicate
    let result = null;

    while (true) {
      const check = await axios.get(
        `https://api.replicate.com/v1/predictions/${id}`,
        { headers: { Authorization: `Token ${REPLICATE_API_KEY}` } }
      );

      if (check.data.status === "succeeded") {
        result = check.data.output;
        break;
      }

      if (check.data.status === "failed") {
        return res.status(500).json({ error: "Generation failed" });
      }

      await new Promise(r => setTimeout(r, 2500));
    }

    return res.json({ video: result });

  } catch (err) {
    console.error("Backend error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

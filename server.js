require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

// WORKING TEXT → VIDEO MODEL (2025)
const MODEL = "talesofai/t2v-openjourney";
const MODEL_VERSION = "ddeb9cb588b955f1924613840b3c7282f17a0fbb4f6b8b6bc47cf8ae6dc07d29";

console.log("API KEY SET?", !!REPLICATE_API_KEY);

app.use(cors());
app.use(bodyParser.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.json({ error: "Missing prompt" });
    if (!REPLICATE_API_KEY) return res.json({ error: "Missing API Key" });

    // create prediction
    const create = await axios.post(
      `https://api.replicate.com/v1/models/${MODEL}/versions/${MODEL_VERSION}/predictions`,
      {
        input: {
          prompt,
          num_frames: 48,
          fps: 12,
          guidance_scale: 7.5,
          seed: 42
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

    // poll
    let output = null;
    while (true) {
      const poll = await axios.get(
        `https://api.replicate.com/v1/predictions/${id}`,
        { headers: { Authorization: `Token ${REPLICATE_API_KEY}` } }
      );

      const status = poll.data.status;

      if (status === "succeeded") {
        output = poll.data.output;
        break;
      }

      if (status === "failed") {
        return res.json({ error: "Video generation failed", details: poll.data });
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (!output) {
      return res.json({
        error: "No video returned by model.",
        details: "Try a different prompt or check account credits."
      });
    }

    return res.json({ video: output });

  } catch (err) {
    console.log("SERVER ERROR:", err?.response?.data || err.message);
    return res.json({ error: "server_error", details: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(PORT, () => console.log("RUNNING ON PORT", PORT));

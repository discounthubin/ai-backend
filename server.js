const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// 🔐 CONFIG (API key backend me hi rahegi)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ✅ CORRECT Gemini HTTPS Model URL
const GEMINI_MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";

// Health check
app.get("/", (req, res) => {
  res.send("Node.js backend running 🚀");
});

// 🔥 MAIN AI ROUTE
app.post("/generate", async (req, res) => {
  try {
    const userPrompt = req.body.prompt;

    if (!userPrompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const geminiResponse = await fetch(
      `${GEMINI_MODEL_URL}?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: userPrompt }]
            }
          ]
        })
      }
    );

    const data = await geminiResponse.json();

    res.json({
      success: true,
      response: data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});


const express = require("express");
const cors = require("cors"); // New: CORS import
const fetch = require("node-fetch");

const app = express();

// 🔓 CORS CONFIGURATION (Frontend ko allow karne ke liye)
app.use(cors({
    origin: "*", // Filhal sabke liye allow kar rahe hain taki error na aaye
    methods: ["GET", "POST"]
}));

app.use(express.json());

// 🔐 CONFIG (API KEY)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ✅ CORRECT Gemini HTTPS Model URL
const GEMINI_MODEL_URL = 
"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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

        // Check if Gemini returned an error
        if (data.error) {
            console.error("Gemini API Error:", data.error);
            return res.status(500).json({ success: false, error: data.error.message });
        }

        // Extract text correctly based on Gemini response structure
        let aiText = "No response text found.";
        if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts) {
            aiText = data.candidates[0].content.parts[0].text;
        }

        res.json({
            success: true,
            response: aiText
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

const express = require("express");
const app = express();

app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("Node.js backend running 🚀");
});

// API route (future me yahin Gemini connect hoga)
app.post("/generate", (req, res) => {
  const prompt = req.body.prompt || "";
  res.json({
    success: true,
    received: prompt
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});

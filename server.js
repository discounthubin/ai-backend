const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(cors());

// Upload setup (Temp storage)
const upload = multer({ dest: 'uploads/' });

// API Key from Environment Variables (Render settings se uthayega)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

app.get('/', (req, res) => {
    res.send('AI Audio Server is Running! 🚀');
});

// Main Processing Route
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = `uploads/output-${Date.now()}.mp3`;

    try {
        // 1. Read File for Gemini
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');

        // 2. Ask Gemini for Timestamps
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `
        You are a professional audio editor. 
        Context: The user speaks in Hindi/Hinglish and makes multiple retakes.
        Task: Identify ONLY the timestamps of the FINAL PERFECT TAKE for each sentence.
        Ignore stammers, retakes, silence, and angry outbursts.
        
        STRICT OUTPUT FORMAT (JSON ONLY):
        {
          "segments": [
            {"start": "00:00:05", "end": "00:00:10"},
            {"start": "00:00:15", "end": "00:00:25"}
          ]
        }
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: "audio/mp3" } }
        ]);

        const responseText = result.response.text();
        // Clean markdown if present
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        const segments = JSON.parse(jsonStr).segments;

        console.log("Segments to keep:", segments);

        if (!segments || segments.length === 0) {
            throw new Error("No valid segments found by AI");
        }

        // 3. Process with FFmpeg (Server Side)
        // Construct Complex Filter for trimming and merging
        const filterComplex = segments.map((seg, i) => {
            return `[0:a]trim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`;
        });
        
        const inputs = segments.map((_, i) => `[a${i}]`).join('');
        const complexFilterString = `${filterComplex.join(';')};${inputs}concat=n=${segments.length}:v=0:a=1[out]`;

        ffmpeg(inputPath)
            .complexFilter(complexFilterString)
            .map('[out]')
            .on('end', () => {
                console.log('Processing finished!');
                // Send file back to user
                res.download(outputPath, 'edited-audio.mp3', (err) => {
                    // Cleanup files after sending
                    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg Error:', err);
                res.status(500).send('Audio Processing Failed');
            })
            .save(outputPath);

    } catch (error) {
        console.error(error);
        res.status(500).send('Error: ' + error.message);
        // Cleanup on error
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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

// --- 1. UPLOAD SETUP (Temp Storage) ---
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
            cb(null, 'uploads/')
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
        }
    })
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

app.get('/', (req, res) => res.send('AI Audio Server is ONLINE 🟢'));

// --- 2. MAIN PROCESSING ROUTE ---
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = `uploads/output-${Date.now()}.mp3`;

    try {
        console.log(`[Start] Processing: ${req.file.originalname}`);

        // A. File Read & MimeType Fix
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');
        
        let mimeType = req.file.mimetype;
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) {
            mimeType = ext === '.m4a' ? 'audio/m4a' : `audio/${ext.substring(1)}`;
        }

        // B. AI CONFIGURATION (THE MILLISECOND FIX)
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
        
        // Is PROMPT mein magic hai. Hum strict seconds maang rahe hain.
        const prompt = `
        You are an expert audio editor.
        Context: The user records retakes. Only the LAST take of a sentence is good.
        Task: Identify start/end times of the FINAL PERFECT TAKE for each sentence.
        
        CRITICAL INSTRUCTION:
        - Output strictly in DECIMAL SECONDS (e.g., 5.432), NOT HH:MM:SS.
        - Be precise to the millisecond.
        - Ignore silence/retakes.

        STRICT JSON FORMAT:
        {
          "segments": [
            {"start": 1.253, "end": 4.501},
            {"start": 6.100, "end": 12.854}
          ]
        }
        `;

        console.log("[AI] Analyzing Audio...");
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: mimeType } }
        ]);

        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        
        let segments = [];
        try {
            segments = JSON.parse(jsonStr).segments;
        } catch (e) {
            throw new Error(`AI JSON Failed. Response: ${responseText.substring(0, 50)}...`);
        }

        if (!segments || segments.length === 0) {
            throw new Error("AI found no valid segments.");
        }

        // C. VALIDATION (Crash Proofing)
        console.log(`[AI] Found ${segments.length} segments. Validating...`);
        
        const validSegments = segments.map(s => ({
            start: parseFloat(s.start), // Text ko Number banana
            end: parseFloat(s.end)
        })).filter(s => 
            !isNaN(s.start) && !isNaN(s.end) && s.end > s.start
        ).sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No valid timestamps found.");

        // D. FFmpeg PRECISE CUTTING
        console.log(`[FFmpeg] Cutting with Millisecond Precision...`);

        // Filter Logic: trim=start=1.234:end=5.678
        const filterStr = validSegments.map((seg, i) => 
            `[0:a]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
        ).join(';');

        const concatStr = validSegments.map((_, i) => `[a${i}]`).join('') + 
                          `concat=n=${validSegments.length}:v=0:a=1[out]`;

        const complexFilter = `${filterStr};${concatStr}`;

        ffmpeg(inputPath)
            .complexFilter(complexFilter)
            .map('[out]')
            .on('end', () => {
                console.log("✅ DONE! Sending file.");
                res.download(outputPath, 'edited_audio.mp3', () => {
                    cleanup(inputPath, outputPath);
                });
            })
            .on('error', (err) => {
                console.error("❌ FFmpeg Failed:", err.message);
                res.status(500).send("Audio Processing Failed inside FFmpeg.");
                cleanup(inputPath, outputPath);
            })
            .save(outputPath);

    } catch (error) {
        console.error("❌ SERVER ERROR:", error.message);
        res.status(500).send("Error: " + error.message);
        if (req.file) cleanup(req.file.path);
    }
});

// Helper to delete files
function cleanup(...files) {
    files.forEach(f => {
        if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch(e){}
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

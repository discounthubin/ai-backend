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

// --- CONFIGURATION ---
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

// --- MAIN PROCESS ---
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = `uploads/output-${Date.now()}.mp3`;

    try {
        console.log(`[1/4] Starting: ${req.file.originalname}`);

        // 1. Prepare File for AI
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');
        
        // Smart MimeType Detection
        let mimeType = req.file.mimetype;
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext === '.mp3') mimeType = 'audio/mp3';
        else if (ext === '.wav') mimeType = 'audio/wav';
        else if (ext === '.aac') mimeType = 'audio/aac';
        else if (ext === '.m4a') mimeType = 'audio/m4a';

        // 2. Ask Gemini (New Prompt for Seconds)
        console.log(`[2/4] Sending to AI (Mime: ${mimeType})...`);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `
        You are an expert audio editor.
        Context: The user records retakes. Only the LAST take of a sentence is good.
        Task: Identify start/end times of the FINAL PERFECT TAKE for each sentence.
        
        IMPORTANT:
        - Be precise to milliseconds.
        - Output strictly in SECONDS (e.g., 5.432), NOT HH:MM:SS.
        - Ignore silence/retakes.

        STRICT JSON FORMAT:
        {
          "segments": [
            {"start": 1.25, "end": 4.50},
            {"start": 6.10, "end": 12.85}
          ]
        }
        `;

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
            throw new Error(`AI JSON Error: ${responseText.substring(0, 50)}...`);
        }

        if (!segments || segments.length === 0) {
            throw new Error("AI found no valid segments to keep.");
        }

        // 3. Validate & Sort Segments
        console.log(`[3/4] AI Found ${segments.length} segments.`);
        
        // Safety Clean-up (Ensure numbers are valid)
        const validSegments = segments.map(s => ({
            start: parseFloat(s.start),
            end: parseFloat(s.end)
        })).filter(s => 
            !isNaN(s.start) && !isNaN(s.end) && s.end > s.start
        ).sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No valid time segments found.");

        // 4. FFmpeg Precise Cutting
        console.log(`[4/4] Cutting Audio...`);

        // Filter Complex Logic
        // [0:a]trim=start=1.2:end=3.4,asetpts=PTS-STARTPTS[a0];
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
                res.status(500).send("Audio Processing Failed");
                cleanup(inputPath, outputPath);
            })
            .save(outputPath);

    } catch (error) {
        console.error("❌ SERVER ERROR:", error.message);
        res.status(500).send("Error: " + error.message);
        if (req.file) cleanup(req.file.path);
    }
});

function cleanup(...files) {
    files.forEach(f => {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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

// --- UPLOAD CONFIG ---
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
            cb(null, 'uploads/')
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `raw-${Date.now()}${ext}`); 
        }
    })
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// --- PRO SETTINGS (Smoothness) ---
const PADDING_START = 0.19; // 0.3s (Requested: Words ka start nahi katega)
const PADDING_END = 0.18;   // 0.2s (End mein saans lene ki awaz safe rahegi)

app.get('/', (req, res) => res.send('AI Audio Server PRO is ONLINE 🟢'));

// --- HELPER: GET DURATION ---
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// --- HELPER: CUT CHUNK (Robust) ---
function cutSegment(inputFile, start, end, index) {
    return new Promise((resolve, reject) => {
        const outputFile = `uploads/chunk_${index}_${Date.now()}.mp3`;
        
        // Logic: Padding lagao par 0 se neeche mat jao
        let safeStart = Math.max(0, start - PADDING_START);
        let duration = (end + PADDING_END) - safeStart;

        ffmpeg(inputFile)
            .setStartTime(safeStart)
            .setDuration(duration)
            .audioCodec('libmp3lame')
            .on('end', () => resolve(outputFile))
            .on('error', (err) => reject(err))
            .save(outputFile);
    });
}

// --- HELPER: MERGE CHUNKS ---
function mergeChunks(chunkFiles, finalOutput) {
    return new Promise((resolve, reject) => {
        const merged = ffmpeg();
        chunkFiles.forEach(file => merged.input(file));
        
        merged.on('end', () => resolve(finalOutput))
            .on('error', (err) => reject(err))
            .mergeToFile(finalOutput, 'uploads/');
    });
}

// --- MAIN PROCESS ---
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const finalOutputPath = `uploads/final-${Date.now()}.mp3`;
    let chunkPaths = [];

    try {
        console.log(`[Start] Processing: ${req.file.originalname}`);
        const totalDuration = await getAudioDuration(inputPath);

        // 1. AI Analysis
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // --- THE "SEMANTIC BRAIN" PROMPT ---
        const prompt = `
        You are an elite Audio Editor specializing in "Semantic Narrative Reconstruction".
        
        GOAL: Create a seamless story by removing retakes and mistakes, but ensuring NO plot points are lost.

        CRITICAL LOGIC (SEMANTIC MATCHING):
        1. **Detect Retakes by MEANING, not just words:**
           - Example 1: "She ran fast"
           - Example 2: "She ran very fast"
           -> These are the SAME thought. Keep only Example 2 (the better one). Discard Example 1.
        
        2. **The "Best Take" Rule:**
           - If a user stammers or fumbles, ignore that part completely.
           - If a sentence is repeated 3 times, pick the LAST, most confident version.
        
        3. **Do NOT Delete Unique Content:**
           - If a sentence adds NEW information (even if it sounds similar), KEEP IT. 
           - Be careful not to over-cut. If unsure, KEEP the clip.

        4. **Precision:**
           - Identify start/end timestamps strictly in DECIMAL SECONDS.
           - Ignore long silences (>2s) between takes.

        STRICT JSON OUTPUT:
        { "segments": [ {"start": 1.25, "end": 4.60} ] }
        `;

        console.log("[AI] Analyzing Semantic Context...");
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: "audio/mp3" } }
        ]);

        let jsonStr = result.response.text().replace(/```json|```/g, '');
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);

        let segments = [];
        try {
            segments = JSON.parse(jsonStr).segments;
        } catch (e) {
            throw new Error("AI could not generate valid JSON.");
        }

        // Validate
        const validSegments = segments
            .map(s => ({ start: parseFloat(s.start), end: parseFloat(s.end) }))
            .filter(s => !isNaN(s.start) && !isNaN(s.end) && s.end > s.start && s.start < totalDuration)
            .sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No usable segments found.");

        // 2. Cutting (Chunk & Stitch - The Safe Method)
        console.log(`[Processing] Cutting ${validSegments.length} segments...`);
        
        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            const safeEnd = Math.min(seg.end, totalDuration);
            const chunkPath = await cutSegment(inputPath, seg.start, safeEnd, i);
            chunkPaths.push(chunkPath);
        }

        // 3. Merging
        console.log(`[Processing] Merging Story...`);
        await mergeChunks(chunkPaths, finalOutputPath);

        console.log("✅ PRO Editing Done!");
        res.download(finalOutputPath, 'pro_edited_audio.mp3', () => {
            cleanup(inputPath, finalOutputPath, ...chunkPaths);
        });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).send("Processing Error: " + error.message);
        cleanup(inputPath, finalOutputPath, ...chunkPaths);
    }
});

function cleanup(...files) {
    files.forEach(f => {
        if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch(e){}
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

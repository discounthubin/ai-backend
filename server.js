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

// --- YOUR EDITING STYLE SETTINGS ---
// Aapke edit mein cuts tight the, par natural.
const PAD_START = 0.15; // Attack safe rakhne ke liye
const PAD_END_FLOW = 0.08; // Tight cut for flow
const PAD_END_STOP = 0.3; // Saans lene ki jagah

app.get('/', (req, res) => res.send('AI Audio Server (Waveform Smart) is ONLINE 🟢'));

// --- HELPER: GET DURATION ---
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// --- HELPER: CUT CHUNK (Smart Padding) ---
function cutSegment(inputFile, start, end, type, index) {
    return new Promise((resolve, reject) => {
        const outputFile = `uploads/chunk_${index}_${Date.now()}.mp3`;
        
        let endPadding = (type === 'flow') ? PAD_END_FLOW : PAD_END_STOP;
        let safeStart = Math.max(0, start - PAD_START);
        let duration = (end + endPadding) - safeStart;

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

        // --- THE "AUDIO ENGINEER" PROMPT ---
        // Ye prompt aapke editing style ko copy karega.
        const prompt = `
        You are an expert Audio Editor mimicking a specific human editing style.
        
        INPUT ANALYSIS:
        The user records multiple takes.
        - Example: "Bhai kya... Bhai kya tum... Bhai kya tum bhi subah..."
        
        YOUR JOB (Logic):
        1. **Detect the "Winning Take":** Find the LAST, COMPLETE, and CONFIDENT version of each sentence.
        2. **Discard Garbage:** Throw away all stammers, incomplete starts, and intermediate breaths.
        3. **Waveform Sensitivity:** - Identify if a sentence ends with a "Full Stop" feel (needs a pause) or a "Comma" feel (needs quick flow).
           - Mark them as "stop" or "flow".

        STRICT RULES:
        - Do not merge retakes. Pick ONE best version.
        - If the user says "Garam nahi... Garam nahi...", keep the second one.
        - Output strictly in DECIMAL SECONDS.

        FORMAT:
        { 
          "segments": [ 
            {"start": 1.25, "end": 4.60, "type": "flow"}, 
            {"start": 5.10, "end": 8.20, "type": "stop"}
          ] 
        }
        `;

        console.log("[AI] Analyzing Waveform & Intent...");
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
            throw new Error("AI could not understand the editing logic.");
        }

        // Validate
        const validSegments = segments
            .map(s => ({ 
                start: parseFloat(s.start), 
                end: parseFloat(s.end),
                type: s.type || 'stop' 
            }))
            .filter(s => !isNaN(s.start) && !isNaN(s.end) && s.end > s.start && s.start < totalDuration)
            .sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No usable segments found.");

        // 2. Cutting (Applying Your Style)
        console.log(`[Processing] Cutting ${validSegments.length} segments (Engineer Style)...`);
        
        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            const safeEnd = Math.min(seg.end, totalDuration);
            const chunkPath = await cutSegment(inputPath, seg.start, safeEnd, seg.type, i);
            chunkPaths.push(chunkPath);
        }

        // 3. Merging
        console.log(`[Processing] Stitching Final Audio...`);
        await mergeChunks(chunkPaths, finalOutputPath);

        console.log("✅ Engineered Audio Ready!");
        res.download(finalOutputPath, 'engineered_audio.mp3', () => {
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

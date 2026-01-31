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

// --- UPLOAD CONFIG (SAME AS BEFORE) ---
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

// --- DYNAMIC PADDING SETTINGS (NEW) ---
const PAD_START_DEFAULT = 0.25; // Default safe start
const PAD_END_FLOW = 0.05;      // Very tight cut for "Flow" (aur, lekin...)
const PAD_END_STOP = 0.25;      // Relaxed cut for "Stop" (full stop)

app.get('/', (req, res) => res.send('AI Audio Server MASTERCLASS is ONLINE 🟢'));

// --- HELPER: GET DURATION ---
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// --- HELPER: CUT CHUNK (UPDATED FOR DYNAMIC PADDING) ---
function cutSegment(inputFile, start, end, type, index) {
    return new Promise((resolve, reject) => {
        const outputFile = `uploads/chunk_${index}_${Date.now()}.mp3`;
        
        // 1. Determine Padding based on AI's "type"
        let endPadding = (type === 'flow') ? PAD_END_FLOW : PAD_END_STOP;
        
        // 2. Logic: Safe Start + Dynamic End
        let safeStart = Math.max(0, start - PAD_START_DEFAULT);
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

// --- HELPER: MERGE CHUNKS (SAME AS BEFORE) ---
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

        // --- THE "MASTERCLASS FLOW" PROMPT ---
        const prompt = `
        You are an elite Audio Director.
        
        GOAL: Edit a raw recording into a MASTERCLASS STORY.
        
        CRITICAL INSTRUCTIONS:
        1. **Semantic Selection:** If there are retakes, keep only the BEST, most confident version. Ignore stammers.
        2. **Flow Detection (THE MAGIC):**
           - For each segment, decide if the sentence ENDS there (Full stop) or FLOWS into the next (comma, "and", "but").
           - Label each segment as "stop" or "flow".
           - "stop": Sentence ends. Needs a breath pause.
           - "flow": Sentence continues. Needs a tight cut.

        FORMAT:
        { 
          "segments": [ 
            {"start": 1.2, "end": 4.5, "type": "stop"}, 
            {"start": 5.1, "end": 6.8, "type": "flow"}
          ] 
        }
        `;

        console.log("[AI] Analyzing Flow & Context...");
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
            .map(s => ({ 
                start: parseFloat(s.start), 
                end: parseFloat(s.end),
                type: s.type || 'stop' // Default to stop if undefined
            }))
            .filter(s => !isNaN(s.start) && !isNaN(s.end) && s.end > s.start && s.start < totalDuration)
            .sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No usable segments found.");

        // 2. Cutting (With Dynamic Logic)
        console.log(`[Processing] Cutting ${validSegments.length} segments with Dynamic Flow...`);
        
        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            const safeEnd = Math.min(seg.end, totalDuration);
            // Pass the 'type' to the cutter function
            const chunkPath = await cutSegment(inputPath, seg.start, safeEnd, seg.type, i);
            chunkPaths.push(chunkPath);
        }

        // 3. Merging
        console.log(`[Processing] Merging Masterclass...`);
        await mergeChunks(chunkPaths, finalOutputPath);

        console.log("✅ MASTERCLASS Editing Done!");
        res.download(finalOutputPath, 'masterclass_audio.mp3', () => {
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

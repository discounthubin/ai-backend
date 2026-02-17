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

// --- DYNAMIC PADDING (Natural Flow) ---
const PAD_START = 0.2;       // Words ka attack bachane ke liye
const PAD_END_FLOW = 0.05;   // Flow ke liye tight cut
const PAD_END_STOP = 0.25;   // Full stop par saans lene ka waqt

app.get('/', (req, res) => res.send('AI Audio Director is ONLINE 🔴'));

// --- HELPER: GET DURATION ---
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// --- HELPER: CUT CHUNK ---
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
function mergeChunks(chunkFiles, tempOutput) {
    return new Promise((resolve, reject) => {
        const merged = ffmpeg();
        chunkFiles.forEach(file => merged.input(file));
        merged.on('end', () => resolve(tempOutput))
            .on('error', (err) => reject(err))
            .mergeToFile(tempOutput, 'uploads/');
    });
}

// --- HELPER: MASTERING (The Studio Touch) ---
// Applies EQ, Compression, and YouTube Standard Normalization (-14 LUFS)
function applyMastering(inputFile, finalOutput) {
    return new Promise((resolve, reject) => {
        console.log("[Mastering] Applying Studio Effects...");
        ffmpeg(inputFile)
            .audioFilters([
                'highpass=f=80', // Remove low rumble/noise below 80Hz
                'treble=g=2',    // Slight clarity boost
                'compand=attacks=0:points=-80/-900|-45/-15|-27/-9|0/-7|20/-7:gain=2', // Vocal Compression
                'loudnorm=I=-14:TP=-1.5:LRA=11' // YouTube Standard Loudness
            ])
            .save(finalOutput)
            .on('end', () => resolve(finalOutput))
            .on('error', (err) => reject(err));
    });
}

// --- MAIN PROCESS ---
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const tempMergedPath = `uploads/temp_merged-${Date.now()}.mp3`;
    const finalMasteredPath = `uploads/final_master-${Date.now()}.mp3`;
    let chunkPaths = [];

    try {
        console.log(`[Start] Director processing: ${req.file.originalname}`);
        const totalDuration = await getAudioDuration(inputPath);

        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // --- THE "DIRECTOR" PROMPT (Yours + Strict JSON) ---
        const prompt = `
        You are a PROFESSIONAL Human-Level Audio Director and Editor.
        Your job is to FULLY AUTOMATE high-quality YouTube voice editing.

        STEP 1 — DEEP AUDIO ANALYSIS
        - Listen to the FULL audio. Understand speaker intent, confidence, and retakes.
        - You must THINK before cutting.

        STEP 2 — INTELLIGENT RETAKE DETECTION
        - User says: "Guys today I… guys today I will… guys today I will show you..."
        - RULE: Always keep ONLY the LAST complete and confident take.
        - Remove previous attempts. Never stitch partial phrases.

        STEP 3 — SENTENCE INTENT CLASSIFICATION
        For every final sentence, classify "type":
        - "flow" → continues naturally (comma feel)
        - "stop" → emotional/full stop (needs breathing space)

        STEP 4 — PROFESSIONAL EDITING RULES
        - Remove filler words (um, uh, matlab) unless crucial for emotion.
        - Keep natural breathing where needed. Do NOT robotic trim.

        OUTPUT FORMAT (STRICT JSON ONLY):
        {
          "segments": [
            { "start": 12.45, "end": 16.82, "type": "flow" },
            { "start": 17.10, "end": 20.05, "type": "stop" }
          ]
        }
        `;

        console.log("[AI] Director is thinking...");
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
            throw new Error("AI Director failed to produce a valid edit list.");
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

        if (validSegments.length === 0) throw new Error("Director found no usable takes.");

        // 1. Cutting
        console.log(`[Processing] Director selected ${validSegments.length} perfect takes...`);
        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            const safeEnd = Math.min(seg.end, totalDuration);
            const chunkPath = await cutSegment(inputPath, seg.start, safeEnd, seg.type, i);
            chunkPaths.push(chunkPath);
        }

        // 2. Merging
        console.log(`[Processing] Stitching sequence...`);
        await mergeChunks(chunkPaths, tempMergedPath);

        // 3. Mastering (NEW STEP)
        console.log(`[Processing] Applying Final Mastering (EQ, Compression, -14 LUFS)...`);
        await applyMastering(tempMergedPath, finalMasteredPath);

        console.log("✅ Final Studio Audio Ready!");
        res.download(finalMasteredPath, 'studio_mastered.mp3', () => {
            cleanup(inputPath, tempMergedPath, finalMasteredPath, ...chunkPaths);
        });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).send("Director Error: " + error.message);
        cleanup(inputPath, tempMergedPath, finalMasteredPath, ...chunkPaths);
    }
});

function cleanup(...files) {
    files.forEach(f => {
        if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch(e){}
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

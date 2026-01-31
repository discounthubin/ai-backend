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
const PADDING = 0.5; // 0.12s extra start/end mein (Words katna band ho jayega)

app.get('/', (req, res) => res.send('AI Audio Server is ONLINE 🟢'));

// --- HELPER: GET DURATION ---
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// --- HELPER: CUT A SINGLE CHUNK (With Padding) ---
function cutSegment(inputFile, start, end, index) {
    return new Promise((resolve, reject) => {
        const outputFile = `uploads/chunk_${index}_${Date.now()}.mp3`;
        
        // Calculate Padded Times
        let safeStart = Math.max(0, start - PADDING); // 0 se kam na ho
        let duration = (end + PADDING) - safeStart;   // End mein bhi padding

        ffmpeg(inputFile)
            .setStartTime(safeStart)
            .setDuration(duration)
            .audioCodec('libmp3lame')
            .on('end', () => resolve(outputFile))
            .on('error', (err) => reject(err))
            .save(outputFile);
    });
}

// --- HELPER: MERGE FILES ---
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

        // IMPROVED PROMPT (Duplicate Hatane Ke Liye)
        const prompt = `
        You are a strict audio editor.
        Context: The user records multiple retakes.
        Task: Identify ONLY the timestamps of the FINAL BEST TAKE for each sentence.
        
        RULES:
        1. If a sentence is repeated multiple times, SELECT ONLY THE LAST ONE. Discard previous attempts.
        2. Do NOT select duplicate sentences.
        3. Ignore silence and filler words.
        4. Output strictly in DECIMAL SECONDS.

        FORMAT: { "segments": [ {"start": 1.2, "end": 4.5} ] }
        `;

        console.log("[AI] Analyzing...");
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: "audio/mp3" } } // MP3 assumed safe now
        ]);

        const responseText = result.response.text();
        let jsonStr = responseText.replace(/```json|```/g, '');
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);

        let segments = [];
        try {
            segments = JSON.parse(jsonStr).segments;
        } catch (e) {
            throw new Error("AI returned invalid JSON.");
        }

        // Validate Segments
        const validSegments = segments
            .map(s => ({ start: parseFloat(s.start), end: parseFloat(s.end) }))
            .filter(s => !isNaN(s.start) && !isNaN(s.end) && s.end > s.start && s.start < totalDuration)
            .sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No valid segments found.");

        // 2. Cut Chunks (Sequential Logic - RAM Safe)
        console.log(`[Processing] Creating ${validSegments.length} chunks...`);

        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            const safeEnd = Math.min(seg.end, totalDuration);
            const chunkPath = await cutSegment(inputPath, seg.start, safeEnd, i);
            chunkPaths.push(chunkPath);
        }

        // 3. Merge Chunks
        console.log(`[Processing] Merging...`);
        await mergeChunks(chunkPaths, finalOutputPath);

        console.log("✅ Success! Sending file.");
        res.download(finalOutputPath, 'polished_audio.mp3', () => {
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

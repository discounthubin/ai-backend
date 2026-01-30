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

// --- 1. UPLOAD CONFIGURATION ---
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

app.get('/', (req, res) => res.send('AI Audio Server is ONLINE 🟢'));

// --- HELPER: GET AUDIO DURATION ---
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// --- HELPER: CUT A SINGLE CHUNK ---
function cutSegment(inputFile, start, end, index) {
    return new Promise((resolve, reject) => {
        const outputFile = `uploads/chunk_${index}_${Date.now()}.mp3`;
        // Use simple seek and copy (Fast & Crash Proof)
        ffmpeg(inputFile)
            .setStartTime(start)
            .setDuration(end - start)
            .audioCodec('libmp3lame') // Re-encode to ensure consistency
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
            .mergeToFile(finalOutput, 'uploads/'); // Temp folder for merge
    });
}

// --- 2. MAIN PROCESSING ---
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const finalOutputPath = `uploads/final-${Date.now()}.mp3`;
    let chunkPaths = [];

    try {
        console.log(`[Start] Processing: ${req.file.originalname}`);

        // A. Duration Check (Taaki AI file se bada time na de)
        const totalDuration = await getAudioDuration(inputPath);
        console.log(`[Info] File Duration: ${totalDuration}s`);

        // B. AI Analysis
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');
        
        // MimeType Fix
        let mimeType = req.file.mimetype;
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) {
            mimeType = ext === '.m4a' ? 'audio/m4a' : `audio/${ext.substring(1)}`;
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `
        You are an expert audio editor.
        Task: Identify start/end times of the FINAL PERFECT TAKE for each sentence.
        Input Audio Duration: ${totalDuration} seconds.
        
        CRITICAL:
        1. Output strictly in DECIMAL SECONDS (e.g., 5.432).
        2. Do NOT provide timestamps greater than ${totalDuration}.
        3. Output RAW JSON ONLY.

        FORMAT:
        { "segments": [ {"start": 1.2, "end": 4.5} ] }
        `;

        console.log("[AI] Analyzing...");
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: mimeType } }
        ]);

        const responseText = result.response.text();
        
        // C. JSON Cleaner
        let jsonStr = responseText.replace(/```json|```/g, '');
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
        
        let segments = [];
        try {
            segments = JSON.parse(jsonStr).segments;
        } catch (e) {
            throw new Error("AI returned invalid Data.");
        }

        // D. Validate Segments
        const validSegments = segments
            .map(s => ({ start: parseFloat(s.start), end: parseFloat(s.end) }))
            .filter(s => !isNaN(s.start) && !isNaN(s.end) && s.end > s.start && s.start < totalDuration)
            .sort((a, b) => a.start - b.start);

        if (validSegments.length === 0) throw new Error("No valid segments found.");

        // E. THE NEW STRATEGY: Chunk & Stitch
        console.log(`[Processing] Creating ${validSegments.length} chunks...`);

        // Loop: Cut each segment one by one (Sequential to save RAM)
        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            // Safety: Ensure end doesn't exceed total duration
            const safeEnd = Math.min(seg.end, totalDuration);
            
            console.log(`  -> Cutting Chunk ${i+1}: ${seg.start}s to ${safeEnd}s`);
            const chunkPath = await cutSegment(inputPath, seg.start, safeEnd, i);
            chunkPaths.push(chunkPath);
        }

        console.log(`[Processing] Merging ${chunkPaths.length} chunks...`);
        await mergeChunks(chunkPaths, finalOutputPath);

        console.log("✅ Success! Sending file.");
        res.download(finalOutputPath, 'cleaned_audio.mp3', () => {
            cleanup(inputPath, finalOutputPath, ...chunkPaths);
        });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).send("Error: " + error.message);
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

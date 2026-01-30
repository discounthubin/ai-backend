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
const BUFFER_TIME = 0.15; // 0.15s extra padding before/after cuts

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

// --- MAIN PROCESS ---
app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const finalOutputPath = `uploads/final-${Date.now()}.mp3`;
    let tempFiles = [];

    try {
        console.log(`[Start] Processing: ${req.file.originalname}`);
        const totalDuration = await getAudioDuration(inputPath);

        // 1. AI Analysis
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
        You are a professional audio editor editing a voiceover.
        Context: The user repeats lines. You must keep ONLY the BEST/LAST take of each sentence.
        
        RULES:
        1. If a sentence is repeated 3 times, keep ONLY the 3rd one. DELETE the first two.
        2. Merge short pauses, but do not include long silence.
        3. Output strictly in DECIMAL SECONDS.
        
        FORMAT: { "segments": [ {"start": 1.2, "end": 4.5}, {"start": 6.8, "end": 10.1} ] }
        `;

        console.log("[AI] Analyzing...");
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: "audio/mp3" } } // Assuming MP3 conversion done
        ]);

        const responseText = result.response.text();
        let jsonStr = responseText.replace(/```json|```/g, '');
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);

        let segments = JSON.parse(jsonStr).segments;

        // 2. Add Buffer (Padding) to prevent cutting words
        const bufferedSegments = segments.map(s => ({
            start: Math.max(0, s.start - BUFFER_TIME), // Thoda pehle shuru karo
            end: Math.min(totalDuration, s.end + BUFFER_TIME) // Thoda baad mein khatam karo
        })).sort((a, b) => a.start - b.start);

        // 3. Cut & Crossfade Logic (Using Complex Filter)
        console.log(`[FFmpeg] Cutting ${bufferedSegments.length} parts with Crossfade...`);
        
        // Note: For true crossfade on Render free tier, it's heavy. 
        // We will stick to "Concat" but with buffer, which sounds much smoother.
        
        const filterStr = bufferedSegments.map((seg, i) => 
            `[0:a]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
        ).join(';');

        const concatStr = bufferedSegments.map((_, i) => `[a${i}]`).join('') + 
                          `concat=n=${bufferedSegments.length}:v=0:a=1[out]`;

        const complexFilter = `${filterStr};${concatStr}`;

        ffmpeg(inputPath)
            .complexFilter(complexFilter)
            .map('[out]')
            .audioCodec('libmp3lame')
            .on('end', () => {
                console.log("✅ Success!");
                res.download(finalOutputPath, 'polished_audio.mp3', () => cleanup(inputPath, finalOutputPath));
            })
            .on('error', (err) => {
                console.error("FFmpeg Error:", err.message);
                res.status(500).send("Processing Failed");
                cleanup(inputPath, finalOutputPath);
            })
            .save(finalOutputPath);

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).send(error.message);
        cleanup(inputPath);
    }
});

function cleanup(...files) {
    files.forEach(f => {
        if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch(e){}
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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

// Configure Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

app.get('/', (req, res) => {
    res.send('AI Audio Server is Online & Ready! 🚀');
});

app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = `uploads/output-${Date.now()}.mp3`;

    try {
        console.log(`Processing File: ${req.file.originalname}`);

        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');

        // --- YAHAN HAI MAIN UPDATE (FIX FOR AAC ERROR) ---
        // Hum browser par bharosa nahi karenge, file extension check karenge
        let mimeType = req.file.mimetype;
        const ext = path.extname(req.file.originalname).toLowerCase();

        if (ext === '.mp3') mimeType = 'audio/mp3';
        else if (ext === '.wav') mimeType = 'audio/wav';
        else if (ext === '.aac') mimeType = 'audio/aac';
        else if (ext === '.m4a') mimeType = 'audio/m4a';
        else if (ext === '.flac') mimeType = 'audio/flac';
        else if (ext === '.ogg') mimeType = 'audio/ogg';
        
        console.log(`Fixed MimeType: ${mimeType}`);
        // --------------------------------------------------

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `
        You are a professional audio editor for a Hindi/Hinglish creator.
        Context: The user records multiple takes.
        Task: Identify timestamps of ONLY the FINAL PERFECT TAKE for each sentence.
        Ignore: Retakes, stammers, frustration, and silence.
        STRICT JSON OUTPUT: { "segments": [{"start": "HH:MM:SS", "end": "HH:MM:SS"}] }
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Audio, mimeType: mimeType } }
        ]);

        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        
        // Error Handling agar JSON galat aaye
        let segments;
        try {
            segments = JSON.parse(jsonStr).segments;
        } catch(e) {
            throw new Error("AI failed to generate valid JSON timestamps.");
        }

        if (!segments || segments.length === 0) {
            throw new Error("AI could not find any valid segments to keep.");
        }

        const filterComplex = segments.map((seg, i) => {
            return `[0:a]trim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`;
        });
        
        const inputs = segments.map((_, i) => `[a${i}]`).join('');
        const complexFilterString = `${filterComplex.join(';')};${inputs}concat=n=${segments.length}:v=0:a=1[out]`;

        ffmpeg(inputPath)
            .complexFilter(complexFilterString)
            .map('[out]')
            .on('end', () => {
                res.download(outputPath, 'edited-audio.mp3', (err) => {
                    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg Error:', err);
                res.status(500).send('Audio Processing Failed');
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            })
            .save(outputPath);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).send('Error: ' + error.message);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

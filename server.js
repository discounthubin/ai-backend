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

// Configure Multer to keep extensions (Important for MIME detection)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        // Original name safe rakhna zaroori hai
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Create uploads dir if not exists
if (!fs.existsSync('uploads')){
    fs.mkdirSync('uploads');
}

app.get('/', (req, res) => {
    res.send('AI Audio Server is Online & Ready! 🚀');
});

app.post('/process-audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = `uploads/output-${Date.now()}.mp3`;

    try {
        console.log(`Processing file: ${req.file.originalname} (${req.file.mimetype})`);

        // 1. Read File
        const fileBuffer = fs.readFileSync(inputPath);
        const base64Audio = fileBuffer.toString('base64');

        // 2. Dynamic MimeType (Fix for AAC/M4A error)
        // Agar browser generic type bhejta hai, to extension se guess karo
        let mimeType = req.file.mimetype;
        if(mimeType === 'application/octet-stream') {
             if(req.file.originalname.endsWith('.aac')) mimeType = 'audio/aac';
             if(req.file.originalname.endsWith('.m4a')) mimeType = 'audio/m4a';
        }

        // 3. Call Gemini
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
            { inlineData: { data: base64Audio, mimeType: mimeType } } // <-- FIXED HERE
        ]);

        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        const segments = JSON.parse(jsonStr).segments;

        console.log("Segments to keep:", segments);

        if (!segments || segments.length === 0) {
            throw new Error("AI could not find any valid segments to keep.");
        }

        // 4. FFmpeg Processing
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
            })
            .save(outputPath);

    } catch (error) {
        console.error("Server Logic Error:", error);
        res.status(500).send('Error: ' + error.message);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

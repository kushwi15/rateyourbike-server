import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'path';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server and Socket.IO instance
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { bikeName, modelName } = req.body;
    if (!bikeName || !modelName) {
      return cb(new Error("Bike name and model are required"));
    }

    const folderName = `${bikeName.replace(/\s+/g, '')}-${modelName.replace(/\s+/g, '')}`;
    const folderPath = path.join(uploadsDir, folderName);

    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    cb(null, folderPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
  }
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Bike schema and model
const bikeSchema = new mongoose.Schema({
  riderName: { type: String, required: true },
  bikeName: { type: String, required: true },
  modelName: { type: String, required: true },
  purchaseYear: { type: Number, required: true },
  totalKM: { type: Number, default: 0 },
  bikeCost: { type: Number, required: true },
  costPerService: { type: Number, default: 0 },
  review: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  worthTheCost: { type: String, enum: ['Yes', 'Definitely Yes', 'No'], default: 'Yes' },
  images: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

// Index for text search
bikeSchema.index({ bikeName: 'text', modelName: 'text' });

const Bike = mongoose.model('Bike', bikeSchema);

// Serve uploads statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.get('/api/bikes', async (req, res) => {
  try {
    const bikes = await Bike.find().sort({ createdAt: -1 });
    res.json(bikes);
  } catch (err) {
    console.error('Error fetching bikes:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/bikes/search', async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ message: 'Search query is required' });
    }

    const bikes = await Bike.find({
      $or: [
        { bikeName: { $regex: query, $options: 'i' } },
        { modelName: { $regex: query, $options: 'i' } }
      ]
    }).sort({ createdAt: -1 }).limit(10);

    res.json(bikes);
  } catch (err) {
    console.error('Error searching bikes:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/bikes/:id', async (req, res) => {
  try {
    const bike = await Bike.findById(req.params.id);
    if (!bike) {
      return res.status(404).json({ message: 'Bike review not found' });
    }
    res.json(bike);
  } catch (err) {
    console.error('Error fetching bike:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/bikes/add', upload.array('bikeImages', 5), async (req, res) => {
  try {
    const {
      riderName,
      bikeName,
      modelName,
      purchaseYear,
      totalKM,
      bikeCost,
      costPerService,
      review,
      rating,
      worthTheCost
    } = req.body;

    if (!riderName || !bikeName || !modelName || !review || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }

    const files = req.files;

    if (!files || files.length < 3) {
      return res.status(400).json({ message: 'At least 3 images are required' });
    }

    const folderName = `${bikeName.replace(/\s+/g, '')}-${modelName.replace(/\s+/g, '')}`;
    const folderPath = path.join(uploadsDir, folderName);

    const processedImagePaths = await Promise.all(
      files.map(async (file) => {
        const outputFilename = 'compressed-' + file.filename;
        const outputPath = path.join(folderPath, outputFilename);

        await sharp(file.path)
          .resize(1200, 900, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(outputPath);

        fs.unlinkSync(file.path);
        return `/uploads/${folderName}/${outputFilename}`;
      })
    );

    const newBike = new Bike({
      riderName,
      bikeName,
      modelName,
      purchaseYear: Number(purchaseYear),
      totalKM: Number(totalKM),
      bikeCost: Number(bikeCost),
      costPerService: Number(costPerService),
      review,
      rating: Number(rating),
      worthTheCost,
      images: processedImagePaths
    });

    await newBike.save();

    io.emit('newReview', newBike);

    res.status(201).json(newBike);
  } catch (err) {
    console.error('Error adding bike review:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

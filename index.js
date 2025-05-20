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

    // Create folder path based on bike name and model
    const folderName = `${bikeName.replace(/\s+/g, '')}-${modelName.replace(/\s+/g, '')}`;
    const folderPath = path.join(uploadsDir, folderName);

    // Create the folder if it doesn't exist
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
    fileSize: 5 * 1024 * 1024, // 5MB limit
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

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/rateyourbike')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define Bike Schema and Model
const bikeSchema = new mongoose.Schema({
  riderName: { type: String, required: true }, // Added as first field
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

// Add text index for search functionality
bikeSchema.index({ bikeName: 'text', modelName: 'text' });

const Bike = mongoose.model('Bike', bikeSchema);

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// API Routes
// Get all bikes
app.get('/api/bikes', async (req, res) => {
  try {
    const bikes = await Bike.find().sort({ createdAt: -1 });
    res.json(bikes);
  } catch (err) {
    console.error('Error fetching bikes:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Search bikes
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

// Get bike by ID
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

// Add new bike review
app.post('/api/bikes/add', upload.array('bikeImages', 5), async (req, res) => {
  try {
    const {
      riderName, // Added field
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

    // Validate required fields
    if (!riderName || !bikeName || !modelName || !review || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }

    // Process uploaded images
    const files = req.files;

    if (!files || files.length < 3) {
      return res.status(400).json({ message: 'At least 3 images are required' });
    }

    // Folder path
    const folderName = `${bikeName.replace(/\s+/g, '')}-${modelName.replace(/\s+/g, '')}`;
    const folderPath = path.join(uploadsDir, folderName);

    // Compress and process images
    const processedImagePaths = await Promise.all(
      files.map(async (file) => {
        const outputFilename = 'compressed-' + file.filename;
        const outputPath = path.join(folderPath, outputFilename);

        await sharp(file.path)
          .resize(1200, 900, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(outputPath);

        // Delete original file to save space
        fs.unlinkSync(file.path);

        // Return path relative to the uploads directory
        return `/uploads/${folderName}/${outputFilename}`;
      })
    );

    
    // Create new bike review
    const newBike = new Bike({
      riderName, // Added field
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

    // Emit new review event to all connected clients
    io.emit('newReview', newBike);

    res.status(201).json(newBike);
  } catch (err) {
    console.error('Error adding bike review:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('New client connected');
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
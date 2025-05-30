import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

// Setup environment
dotenv.config();

// Express app
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

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer Cloudinary storage config
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const { bikeName, modelName } = req.body;

    if (!bikeName || !modelName) {
      throw new Error('Bike name and model are required');
    }

    const folderName = `${bikeName.replace(/\s+/g, '')}-${modelName.replace(/\s+/g, '')}`;
    return {
      folder: `bike-reviews/${folderName}`,
      format: 'jpeg',
      public_id: `${Date.now()}-${Math.round(Math.random() * 1E9)}`
    };
  },
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
  },
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Bike Schema and Model
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

bikeSchema.index({ bikeName: 'text', modelName: 'text' });

const Bike = mongoose.model('Bike', bikeSchema);

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

    const imageUrls = files.map(file => file.path);

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
      images: imageUrls
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

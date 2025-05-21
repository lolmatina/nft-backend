const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { uploadToS3 } = require('./s3Utils');

dotenv.config();

const app = express();
const port = process.env.PORT || 5001;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/api/upload/image', upload.single('imageFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send({ message: 'No file uploaded.' });
  }

  try {
    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const contentType = req.file.mimetype;
    
    const { s3Url, s3Key } = await uploadToS3(fileBuffer, originalName, contentType, 'images/');
    
    res.status(200).send({ 
      message: 'File uploaded successfully to S3.', 
      imageUrl: s3Url,
      imageKey: s3Key
    });
  } catch (error) {
    console.error('S3 Upload Error (Image):', error);
    res.status(500).send({ message: 'Failed to upload image to S3.' });
  }
});

app.post('/api/upload/metadata', async (req, res) => {
  const metadata = req.body;
  if (!metadata || Object.keys(metadata).length === 0) {
    return res.status(400).send({ message: 'No metadata provided.' });
  }
  
  try {
    const metadataString = JSON.stringify(metadata, null, 2);
    const metadataBuffer = Buffer.from(metadataString, 'utf-8');
    const originalName = Date.now() + '-metadata.json';
    const contentType = 'application/json';

    const { s3Url, s3Key } = await uploadToS3(metadataBuffer, originalName, contentType, 'metadata/');

    res.status(200).send({ 
      message: 'Metadata uploaded successfully to S3.', 
      metadataUrl: s3Url,
      metadataKey: s3Key
    });
  } catch (error) {
    console.error('S3 Upload Error (Metadata):', error);
    res.status(500).send({ message: 'Failed to upload metadata to S3.' });
  }
});

const authRoutes = require('./routes/auth');
const nftRoutes = require('./routes/nfts');
const userRoutes = require('./routes/users');

app.get('/', (req, res) => {
  res.send('Hello from NFT Marketplace Backend!');
});

app.use('/api/auth', authRoutes);
app.use('/api/nfts', nftRoutes);
app.use('/api/users', userRoutes);

app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});
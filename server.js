const express = require('express');
const multer = require('multer');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const JSZip = require('jszip');
const sharp = require('sharp');
const dotenv = require('dotenv');
const cors = require('cors');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { format } = require('date-fns');
const compression = require('compression');
const { PassThrough } = require('stream');
const { Upload } = require('@aws-sdk/lib-storage');

dotenv.config();

const app = express();

// Configure CORS to handle requests from allowed origins
app.use(cors({
  origin: 'https://www.cropslice.com', // Set this to the allowed origin
  methods: ['GET', 'POST', 'OPTIONS'], // Allowed methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
  credentials: true, // Allow credentials like cookies, authorization headers, etc.
}));

app.use(compression());
app.use(express.json());

// Increased the file size limit to 50 MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB max

// Initialize the S3 client
const s3Client = new S3Client({
  region: process.env.REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESSKEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESSKEY,
  },
});

// Reduce Sharp concurrency to 2 threads to lower CPU usage
sharp.concurrency(2);
sharp.cache({ files: 0 }); // No caching to reduce memory usage

// Process images using streaming to avoid high memory usage
const processImageChunk = async (imageBuffer, cropWidthInt, cropHeightInt, zip) => {
  try {
    const metadata = await sharp(imageBuffer).metadata();

    let x = 0;
    let y = 0;

    while (y < metadata.height) {
      while (x < metadata.width) {
        const cropArea = {
          left: x,
          top: y,
          width: Math.min(cropWidthInt, metadata.width - x),
          height: Math.min(cropHeightInt, metadata.height - y),
        };

        // Stream processing to minimize memory usage
        const buffer = await sharp(imageBuffer)
          .extract(cropArea)
          .toFormat('jpeg', { quality: 60 }) // Reduce quality to save memory
          .toBuffer();

        zip.file(`crop_${x}_${y}.jpg`, buffer);

        x += cropWidthInt;
      }
      x = 0;
      y += cropHeightInt;
    }
  } catch (error) {
    console.error('Error processing image chunk:', error.message);
    throw new Error('Failed to process image cropping. Please ensure the image format and dimensions are valid.');
  }
};

// Retry mechanism optimized for limited resources
const uploadWithRetry = async (upload, retries = 2) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await upload.done();
      return;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      if (attempt === retries) {
        throw new Error('Failed to upload after multiple attempts.');
      }
    }
  }
};

app.post('/api/crop-and-process', upload.single('image'), async (req, res) => {
  const { cropWidth, cropHeight } = req.body;
  const image = req.file;

  if (!image) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const cropWidthInt = parseInt(cropWidth);
  const cropHeightInt = parseInt(cropHeight);

  if (isNaN(cropWidthInt) || isNaN(cropHeightInt) || cropWidthInt <= 0 || cropHeightInt <= 0) {
    return res.status(400).json({ error: 'Invalid crop dimensions' });
  }

  const zip = new JSZip();

  try {
    // Stream image processing
    await processImageChunk(image.buffer, cropWidthInt, cropHeightInt, zip);

    const timestamp = format(new Date(), 'yyyyMMddHHmmss');
    const zipFileName = `cropped_images_${timestamp}.zip`;

    const zipStream = new PassThrough();

    zipStream.on('error', (error) => {
      console.error('Stream error:', error.message);
      throw new Error('Stream failed during processing.');
    });

    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true }).pipe(zipStream);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: process.env.BUCKET_NAME,
        Key: zipFileName,
        Body: zipStream,
        ContentType: 'application/zip',
      },
    });

    await uploadWithRetry(upload);

    const getCommand = new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: zipFileName,
    });

    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 86400 });

    res.json({ fileUrl: url, fileName: zipFileName });
  } catch (error) {
    console.error('Error during image processing or uploading:', error.message);
    res.status(500).json({ error: `Error processing image: ${error.message}` });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

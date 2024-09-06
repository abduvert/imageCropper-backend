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
const retry = require('async-retry');

dotenv.config();

const app = express();

app.use(cors());
app.use(compression());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB max

// Initialize the S3 client
const s3Client = new S3Client({
  region: process.env.REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESSKEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESSKEY,
  },
});

sharp.concurrency(1);
sharp.cache(false); // Disable caching to reduce memory usage

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

        const imageStream = sharp(imageBuffer)
          .extract(cropArea)
          .toFormat('jpeg', { quality: 60 });

        const buffer = await new Promise((resolve, reject) => {
          const chunks = [];
          imageStream.on('data', (chunk) => chunks.push(chunk));
          imageStream.on('end', () => resolve(Buffer.concat(chunks)));
          imageStream.on('error', (err) => reject(err));
        });

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

const uploadWithRetry = async (upload) => {
  try {
    await retry(async () => {
      await upload.done();
    }, {
      retries: 3,
      minTimeout: 1000,
      maxTimeout: 3000,
    });
  } catch (error) {
    console.error('Failed to upload after multiple attempts:', error.message);
    throw new Error('Failed to upload after multiple attempts.');
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
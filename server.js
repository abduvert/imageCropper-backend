const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const JSZip = require('jszip');
const sharp = require('sharp');
const dotenv = require('dotenv');
const cors = require('cors');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { format } = require('date-fns');
const compression = require('compression');


// Load environment variables
dotenv.config();

const app = express();

//middlewares
app.use(cors())
app.use(compression())
app.use(express.json())

// Configure multer for file uploads
const upload = multer();

// Initialize the S3 client
const s3Client = new S3Client({
  region: process.env.REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESSKEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESSKEY,
  },
});

// Image crop and process route
app.post('/api/crop-and-process', upload.single('image'), async (req, res) => {
  const { cropWidth, cropHeight } = req.body;
  const image = req.file;

  if (!image) {
    return res.status(400).send('No image uploaded');
  }

  const zip = new JSZip();
  const cropWidthInt = parseInt(cropWidth);
  const cropHeightInt = parseInt(cropHeight);

  if (isNaN(cropWidthInt) || isNaN(cropHeightInt) || cropWidthInt <= 0 || cropHeightInt <= 0) {
    return res.status(400).send('Invalid crop dimensions');
  }

  try {
    const metadata = await sharp(image.buffer).metadata();
    
    if (cropWidthInt > metadata.width || cropHeightInt > metadata.height) {
      return res.status(400).send('Crop dimensions exceed image dimensions');
    }

    let x = 0;
    let y = 0;

    // Loop to iterate over the image for cropping
    while (y < metadata.height) {
      while (x < metadata.width) {
        const cropArea = {
          left: x,
          top: y,
          width: Math.min(cropWidthInt, metadata.width - x),
          height: Math.min(cropHeightInt, metadata.height - y),
        };

        const croppedImageBuffer = await sharp(image.buffer)
          .extract(cropArea)
          .toBuffer();

        zip.file(`crop_${x}_${y}.jpg`, croppedImageBuffer);
        x += cropWidthInt;
      }
      x = 0;
      y += cropHeightInt;
    }

    // Zip the cropped images
    const zipContent = await zip.generateAsync({ type: 'nodebuffer' });
    const timestamp = format(new Date(), 'yyyyMMddHHmmss');
    const zipFileName = `cropped_images_${timestamp}.zip`;

    const putCommand = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: zipFileName,
      Body: zipContent,
      ContentType: 'application/zip',
    });

    await s3Client.send(putCommand);

    const getCommand = new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: zipFileName,
    });

    // Generate a signed URL for downloading the zip file
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 }); // URL valid for 1 hour

    res.json({ fileUrl: url, fileName: zipFileName });

  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send('Error processing image');
  }
});

// File deletion route
app.post('/api/delete-file', async (req, res) => {
  const { filename } = req.body;

  if (!filename) {
    return res.status(400).send('Filename is required');
  }

  const deleteCommand = new DeleteObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: filename,
  });

  try {
    await s3Client.send(deleteCommand);
    res.send('File deleted successfully');
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).send('Error deleting file');
  }
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const JSZip = require('jszip');
const sharp = require('sharp');
const dotenv = require('dotenv');
const cors = require('cors');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { format } = require('date-fns');

dotenv.config();

const app = express();
app.use(cors());

const upload = multer();

const s3Client = new S3Client({
  region: process.env.REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESSKEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESSKEY,
  },
});

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

    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 }); // URL valid for 1 hour

    // Notify the client to request deletion after download
    res.json({ fileUrl: url, fileName: zipFileName });

  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).send('Error processing image');
  }
});

// Endpoint to delete the file after download
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

app.listen(5000, () => {
  console.log('Server running on port 5000');
});

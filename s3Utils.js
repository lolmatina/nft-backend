require('dotenv').config();
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION || !S3_BUCKET_NAME) {
  console.error("Error: Missing AWS S3 configuration in environment variables.");
  // Optional: throw an error to prevent the app from starting without S3 config
  // throw new Error("Missing AWS S3 configuration in environment variables.");
}

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  }
});

/**
 * Uploads a file buffer to S3.
 * @param {Buffer} fileBuffer - The file content as a buffer.
 * @param {string} originalName - The original name of the file, used to determine extension and base for S3 key.
 * @param {string} contentType - The MIME type of the file.
 * @param {string} prefix - Optional prefix for the S3 key (e.g., 'images/', 'metadata/').
 * @returns {Promise<{ s3Url: string, s3Key: string }>} The S3 URL and key of the uploaded file.
 */
const uploadToS3 = async (fileBuffer, originalName, contentType, prefix = '') => {
  const timestamp = Date.now();
  const safeOriginalName = originalName.replace(/\\s+/g, '_');
  const s3Key = `${prefix}${timestamp}-${safeOriginalName}`;

  const params = {
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: contentType,
    // ACL: 'public-read' // Uncomment if you want files to be publicly readable by default
  };

  try {
    const command = new PutObjectCommand(params);
    await s3Client.send(command);
    // Construct the public URL (assuming bucket is public or using ACL public-read)
    // For private buckets, you'd generate a pre-signed URL for access
    const fileUrl = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;
    console.log(`Successfully uploaded ${originalName} to S3: ${fileUrl}`);
    return { s3Url: fileUrl, s3Key: s3Key };
  } catch (err) {
    console.error(`Error uploading ${originalName} to S3:`, err);
    throw err; // Re-throw the error to be handled by the caller
  }
};

/**
 * Generates a pre-signed URL for accessing an S3 object.
 * @param {string} key - The S3 object key.
 * @param {number} expiresIn - Duration in seconds for which the URL is valid.
 * @returns {Promise<string>} The pre-signed URL.
 */
const getPresignedUrl = async (key, expiresIn = 3600) => {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key });
    try {
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return url;
    } catch (error) {
        console.error("Error generating presigned URL", error);
        throw error;
    }
};


module.exports = { s3Client, uploadToS3, getPresignedUrl, S3_BUCKET_NAME }; 
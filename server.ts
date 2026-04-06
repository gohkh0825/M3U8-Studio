import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const downloadsDir = path.join(__dirname, 'downloads');

// Ensure downloads directory exists
fs.ensureDirSync(downloadsDir);

// Cleanup old files (older than 1 hour) every 30 minutes
setInterval(async () => {
  try {
    const files = await fs.readdir(downloadsDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(downloadsDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > 3600000) { // 1 hour
        await fs.remove(filePath);
        console.log(`Removed old file: ${file}`);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}, 1800000);

// We'll let fluent-ffmpeg find ffmpeg in the system path (installed via Dockerfile)
// Only set it if it's not found or if we want to force ffmpeg-static
// For now, let's just use the system one as it's more stable in this environment.
// ffmpeg.setFfmpegPath(ffmpegPath); 

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  app.use(express.json());
  app.use('/downloads', express.static(downloadsDir));

  // API to start download
  app.post('/api/download', async (req, res) => {
    const { url, filename, headers, format = 'mp4', videoBitrate, audioBitrate, videoCodec = 'libx264' } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const extension = format.startsWith('.') ? format : `.${format}`;
    const timestamp = Date.now();
    const safeFilename = (filename || `video_${timestamp}`).replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_').toLowerCase() + extension;
    const outputPath = path.join(downloadsDir, safeFilename);
    const downloadId = timestamp.toString();

    res.json({ downloadId, filename: safeFilename });

    // Start FFmpeg process
    const command = ffmpeg(url);

    // Add custom headers if provided
    if (headers) {
      // headers should be a string with \r\n separators
      command.inputOptions(['-headers', headers]);
    }

    // Handle encoding options
    if (videoBitrate || audioBitrate || (videoCodec !== 'copy' && videoCodec !== 'libx264')) {
      // Re-encoding mode
      if (videoBitrate) command.videoBitrate(videoBitrate);
      if (audioBitrate) command.audioBitrate(audioBitrate);
      
      if (videoCodec === 'copy') {
        command.videoCodec('copy');
      } else {
        command.videoCodec(videoCodec);
        // Optimization: Use fast preset for re-encoding
        command.outputOptions('-preset fast');
      }
      command.audioCodec('aac');
    } else if (videoCodec === 'libx264' && !videoBitrate && !audioBitrate) {
        // Default to copy if libx264 is selected but no bitrate is set (to be fast)
        // Unless user explicitly wants to re-encode, we prefer speed.
        // But if they chose a codec, they might want re-encoding. 
        // Let's stick to copy for speed if no bitrate is provided.
        command.outputOptions('-c copy').outputOptions('-bsf:a aac_adtstoasc');
    } else {
      // Fast copy mode
      command.outputOptions('-c copy').outputOptions('-bsf:a aac_adtstoasc');
    }

    command
      .on('start', (commandLine) => {
        console.log('Spawned Ffmpeg with command: ' + commandLine);
        io.emit(`download-start-${downloadId}`, { message: 'Started downloading...' });
      })
      .on('progress', (progress) => {
        io.emit(`download-progress-${downloadId}`, { 
          percent: progress.percent,
          timemark: progress.timemark 
        });
      })
      .on('error', (err) => {
        console.error('An error occurred: ' + err.message);
        io.emit(`download-error-${downloadId}`, { error: err.message });
      })
      .on('end', async () => {
        console.log('Processing finished !');
        
        // Cleanup any temporary .ts files that might have been created in the downloads directory
        // We only delete .ts files that are NOT the current output file
        try {
          const files = await fs.readdir(downloadsDir);
          for (const file of files) {
            if (file.endsWith('.ts') && file !== safeFilename) {
              const filePath = path.join(downloadsDir, file);
              const stats = await fs.stat(filePath);
              if (stats.isFile()) {
                await fs.remove(filePath);
              }
            }
          }
        } catch (err) {
          console.error('Cleanup .ts files error:', err);
        }

        io.emit(`download-complete-${downloadId}`, { 
          url: `/downloads/${safeFilename}`,
          filename: safeFilename 
        });
      })
      .save(outputPath);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

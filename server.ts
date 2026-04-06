import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Check for system ffmpeg
try {
  const version = execSync('ffmpeg -version').toString();
  console.log('FFmpeg found in system:', version.split('\n')[0]);
} catch (err) {
  console.warn('FFmpeg not found in system path, using ffmpeg-static');
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const downloadsDir = path.join(__dirname, 'downloads');
const tempDir = path.join(__dirname, 'temp');

// Ensure directories exist
fs.ensureDirSync(downloadsDir);
fs.ensureDirSync(tempDir);

// Cleanup old files (older than 1 hour) every 30 minutes
setInterval(async () => {
  try {
    // Cleanup downloads
    const downloadFiles = await fs.readdir(downloadsDir);
    const now = Date.now();
    for (const file of downloadFiles) {
      const filePath = path.join(downloadsDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > 3600000) { // 1 hour
        await fs.remove(filePath);
        console.log(`Removed old download file: ${file}`);
      }
    }

    // Cleanup temp tasks
    const tempTasks = await fs.readdir(tempDir);
    for (const task of tempTasks) {
      const taskPath = path.join(tempDir, task);
      const stats = await fs.stat(taskPath);
      if (now - stats.mtimeMs > 3600000) { // 1 hour
        await fs.remove(taskPath);
        console.log(`Removed old temp task: ${task}`);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}, 1800000);

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

  // Track active tasks for cancellation
  const activeTasks = new Map<string, { 
    abortController: AbortController; 
    ffmpegCommand?: ffmpeg.FfmpegCommand;
    isCancelled: boolean;
  }>();

  app.use(express.json());
  app.use('/downloads', express.static(downloadsDir));

  // API to cancel download
  app.post('/api/cancel', async (req, res) => {
    const { downloadId } = req.body;
    if (!downloadId) return res.status(400).json({ error: 'downloadId is required' });

    const task = activeTasks.get(downloadId);
    if (task) {
      task.isCancelled = true;
      task.abortController.abort();
      if (task.ffmpegCommand) {
        task.ffmpegCommand.kill('SIGKILL');
      }
      activeTasks.delete(downloadId);
      
      // Cleanup temp dir
      const taskTempDir = path.join(tempDir, downloadId);
      await fs.remove(taskTempDir).catch(console.error);
      
      console.log(`Task ${downloadId} cancelled by user`);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Task not found' });
    }
  });

  // API to start download
  app.post('/api/download', async (req, res) => {
    const { url, filename, headers, format = 'mp4', videoBitrate, audioBitrate, videoCodec = 'copy' } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const extension = format.startsWith('.') ? format : `.${format}`;
    const timestamp = Date.now();
    const safeFilename = (filename || `video_${timestamp}`).replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_').toLowerCase() + extension;
    const outputPath = path.join(downloadsDir, safeFilename);
    const downloadId = timestamp.toString();
    const taskTempDir = path.join(tempDir, downloadId);

    // Initialize task tracking
    const abortController = new AbortController();
    activeTasks.set(downloadId, { abortController, isCancelled: false });

    res.json({ downloadId, filename: safeFilename });

    try {
      await fs.ensureDir(taskTempDir);
      io.emit(`download-start-${downloadId}`, { message: '正在解析 M3U8 列表...' });

      // 1. Fetch and parse M3U8
      const axiosHeaders: Record<string, string> = {};
      if (headers) {
        headers.split('\r\n').forEach((line: string) => {
          const [key, ...valueParts] = line.split(':');
          if (key && valueParts.length > 0) {
            axiosHeaders[key.trim()] = valueParts.join(':').trim();
          }
        });
      }

      const response = await axios.get(url, { 
        headers: axiosHeaders,
        signal: abortController.signal 
      });
      
      if (activeTasks.get(downloadId)?.isCancelled) return;

      const m3u8Content = response.data;
      const lines = m3u8Content.split('\n');
      const segments: string[] = [];
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) {
          // Resolve segment URL
          if (line.startsWith('http')) {
            segments.push(line);
          } else if (line.startsWith('/')) {
            const urlObj = new URL(url);
            segments.push(`${urlObj.origin}${line}`);
          } else {
            segments.push(`${baseUrl}${line}`);
          }
        }
      }

      if (segments.length === 0) {
        throw new Error('未在 M3U8 中找到视频分片');
      }

      io.emit(`download-start-${downloadId}`, { message: `找到 ${segments.length} 个分片，开始下载...` });

      // 2. Download segments
      const segmentFiles: string[] = [];
      const batchSize = 5; // Download 5 segments at a time
      
      for (let i = 0; i < segments.length; i += batchSize) {
        if (activeTasks.get(downloadId)?.isCancelled) return;

        const batch = segments.slice(i, i + batchSize);
        await Promise.all(batch.map(async (segmentUrl, index) => {
          const segmentIndex = i + index;
          const segmentPath = path.join(taskTempDir, `segment_${segmentIndex.toString().padStart(5, '0')}.ts`);
          
          try {
            const segResponse = await axios.get(segmentUrl, { 
              headers: axiosHeaders,
              responseType: 'arraybuffer',
              timeout: 30000,
              signal: abortController.signal
            });
            await fs.writeFile(segmentPath, segResponse.data);
            segmentFiles[segmentIndex] = segmentPath;
          } catch (err) {
            if (axios.isCancel(err) || abortController.signal.aborted) return;
            
            console.error(`Failed to download segment ${segmentIndex}:`, err.message);
            // Retry once
            try {
              const segResponse = await axios.get(segmentUrl, { 
                headers: axiosHeaders,
                responseType: 'arraybuffer',
                timeout: 30000,
                signal: abortController.signal
              });
              await fs.writeFile(segmentPath, segResponse.data);
              segmentFiles[segmentIndex] = segmentPath;
            } catch (retryErr) {
              if (axios.isCancel(retryErr) || abortController.signal.aborted) return;
              throw new Error(`分片 ${segmentIndex} 下载失败: ${retryErr.message}`);
            }
          }
        }));

        const progress = Math.round(((i + batch.length) / segments.length) * 80); // 80% for downloading
        io.emit(`download-progress-${downloadId}`, { 
          percent: progress,
          message: `正在下载分片: ${i + batch.length}/${segments.length}`
        });
      }

      if (activeTasks.get(downloadId)?.isCancelled) return;

      // 3. Merge segments using FFmpeg
      io.emit(`download-progress-${downloadId}`, { percent: 85, message: '正在合并分片...' });
      
      const fileListPath = path.join(taskTempDir, 'filelist.txt');
      
      // Verify all segments exist and generate file list
      const missingSegments: number[] = [];
      const fileListEntries: string[] = [];
      
      for (let i = 0; i < segments.length; i++) {
        const segmentPath = path.join(taskTempDir, `segment_${i.toString().padStart(5, '0')}.ts`);
        if (await fs.pathExists(segmentPath)) {
          // FFmpeg concat demuxer escaping: escape ' with \' and \ with \\
          const escapedPath = segmentPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          fileListEntries.push(`file '${escapedPath}'`);
        } else {
          missingSegments.push(i);
        }
      }

      if (missingSegments.length > 0) {
        throw new Error(`合并失败: 缺少 ${missingSegments.length} 个分片 (例如: ${missingSegments.slice(0, 3).join(', ')}...)`);
      }

      await fs.writeFile(fileListPath, fileListEntries.join('\n'));

      const command = ffmpeg();
      
      // Store command for cancellation
      const taskEntry = activeTasks.get(downloadId);
      if (taskEntry) {
        taskEntry.ffmpegCommand = command;
      }

      command
        .input(fileListPath)
        .inputOptions(['-f', 'concat', '-safe', '0']);

      if (videoCodec === 'copy') {
        command.outputOptions('-c copy');
      } else {
        command.videoCodec(videoCodec);
        if (videoBitrate) {
          command.videoBitrate(videoBitrate);
        }
        if (audioBitrate) {
          command.audioBitrate(audioBitrate);
        }
      }

      if (format === 'mp4' && videoCodec === 'copy') {
        command.outputOptions('-bsf:a aac_adtstoasc');
      }

      command
        .on('start', (commandLine) => {
          console.log('Spawned Ffmpeg for merging: ' + commandLine);
        })
        .on('progress', (progress) => {
          // FFmpeg progress during merge is usually very fast
          const mergeProgress = 85 + Math.round((progress.percent || 0) * 0.15);
          io.emit(`download-progress-${downloadId}`, { 
            percent: Math.min(99, mergeProgress),
            message: '正在合并视频流...'
          });
        })
        .on('error', (err) => {
          if (activeTasks.get(downloadId)?.isCancelled) {
            console.log(`Ffmpeg process for ${downloadId} was killed (cancelled)`);
            return;
          }
          console.error('Merge error:', err.message);
          io.emit(`download-error-${downloadId}`, { error: `合并失败: ${err.message}` });
          fs.remove(taskTempDir).catch(console.error);
          activeTasks.delete(downloadId);
        })
        .on('end', async () => {
          console.log('Merge finished!');
          io.emit(`download-complete-${downloadId}`, { 
            url: `/downloads/${safeFilename}`,
            filename: safeFilename 
          });
          // Cleanup temp files
          await fs.remove(taskTempDir).catch(console.error);
          activeTasks.delete(downloadId);
        })
        .save(outputPath);

    } catch (err) {
      if (axios.isCancel(err) || abortController.signal.aborted || activeTasks.get(downloadId)?.isCancelled) {
        console.log(`Task ${downloadId} aborted during execution`);
        return;
      }
      console.error('Download task failed:', err);
      io.emit(`download-error-${downloadId}`, { error: err.message });
      await fs.remove(taskTempDir).catch(console.error);
      activeTasks.delete(downloadId);
    }
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

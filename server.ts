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
const historyFile = path.join(__dirname, 'history.json');

// Ensure directories and history file exist
fs.ensureDirSync(downloadsDir);
fs.ensureDirSync(tempDir);
if (!fs.existsSync(historyFile)) {
  fs.writeJsonSync(historyFile, []);
}

// Helper to manage history
async function getHistory() {
  try {
    return await fs.readJson(historyFile);
  } catch (err) {
    return [];
  }
}

async function saveToHistory(task: any) {
  const history = await getHistory();
  const index = history.findIndex((t: any) => t.id === task.id);
  if (index >= 0) {
    history[index] = { ...history[index], ...task };
  } else {
    history.unshift(task);
  }
  await fs.writeJson(historyFile, history);
}

async function removeFromHistory(id: string) {
  const history = await getHistory();
  const filtered = history.filter((t: any) => t.id !== id);
  await fs.writeJson(historyFile, filtered);
}

async function clearHistory() {
  await fs.writeJson(historyFile, []);
}

// Cleanup old temporary files (older than 24 hours) every hour
setInterval(async () => {
  try {
    const now = Date.now();
    // Cleanup temp tasks (temporary .ts segments)
    const tempTasks = await fs.readdir(tempDir);
    for (const task of tempTasks) {
      const taskPath = path.join(tempDir, task);
      const stats = await fs.stat(taskPath);
      if (now - stats.mtimeMs > 86400000) { // 24 hours
        await fs.remove(taskPath);
        console.log(`Removed old temp task: ${task}`);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}, 3600000);

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

  // Track active tasks for cancellation and recovery
  let maxConcurrentDownloads = 3;
  let currentConcurrentDownloads = 0;
  let maxConcurrentFFmpeg = 1;
  let currentConcurrentFFmpeg = 0;

  const activeTasks = new Map<string, { 
    abortController: AbortController; 
    ffmpegCommand?: ffmpeg.FfmpegCommand;
    isCancelled: boolean;
    metadata: {
      url: string;
      filename: string;
      progress: number;
      message: string;
      timemark: string;
      stage?: 'downloading' | 'merging' | 'encoding' | 'completed';
      logs: any[];
      options?: any;
      status?: string;
    };
    run?: () => Promise<void>;
  }>();

  function checkQueue() {
    for (const [id, task] of activeTasks.entries()) {
      if (task.metadata.status === 'idle' && !task.isCancelled) {
        if (currentConcurrentDownloads < maxConcurrentDownloads) {
          currentConcurrentDownloads++;
          task.metadata.status = 'downloading';
          saveToHistory({ id, ...task.metadata, status: 'downloading' });
          
          if (task.run) {
            task.run().finally(() => {
              currentConcurrentDownloads--;
              checkQueue();
            });
          } else {
            currentConcurrentDownloads--;
          }
        }
      }
    }
  }

  app.use(express.json());
  app.use('/downloads', express.static(downloadsDir));

  // API to configure concurrency
  app.get('/api/settings/concurrency', (req, res) => {
    res.json({ maxConcurrentDownloads, maxConcurrentFFmpeg });
  });

  app.post('/api/settings/concurrency', (req, res) => {
    const { maxConcurrentDownloads: newMax, maxConcurrentFFmpeg: newMaxFFmpeg } = req.body;
    if (typeof newMax === 'number' && newMax >= 1 && newMax <= 10) {
      maxConcurrentDownloads = newMax;
      checkQueue();
    }
    if (typeof newMaxFFmpeg === 'number' && newMaxFFmpeg >= 1 && newMaxFFmpeg <= 3) {
      maxConcurrentFFmpeg = newMaxFFmpeg;
      // Note: FFmpeg slots will be cleared as tasks finish
    }
    res.json({ success: true, maxConcurrentDownloads, maxConcurrentFFmpeg });
  });

  // API to get all tasks (history + active)
  app.get('/api/tasks', async (req, res) => {
    const history = await getHistory();
    // Merge with current active state if needed (though history should be up to date)
    res.json({ tasks: history });
  });

  // API to clear all history
  app.post('/api/clear-history', async (req, res) => {
    await clearHistory();
    res.json({ success: true });
  });

  // API to delete single history item
  app.post('/api/delete-task', async (req, res) => {
    const { id } = req.body;
    await removeFromHistory(id);
    // Explicitly cleanup temp files when user deletes history
    const taskTempDir = path.join(tempDir, id);
    await fs.remove(taskTempDir).catch(console.error);
    res.json({ success: true });
  });

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
    let { url, filename, headers, format = 'mp4', videoBitrate, audioBitrate, videoCodec = 'copy', videoPreset = 'fast', downloadId: existingId } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Fix common encoding issue: &timestamp being converted to ×tamp
    if (url.includes('×tamp=')) {
      url = url.replace(/×tamp=/g, '&timestamp=');
    }

    const extension = format.startsWith('.') ? format : `.${format}`;
    const timestamp = Date.now();
    const safeFilename = (filename || `video_${timestamp}`).replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_').toLowerCase() + extension;
    const outputPath = path.join(downloadsDir, safeFilename);
    const downloadId = existingId || timestamp.toString();
    const taskTempDir = path.join(tempDir, downloadId);
    
    // For new downloads, ensure temp dir is clean. For retries, keep existing segments.
    if (!existingId) {
      await fs.remove(taskTempDir).catch(console.error);
    }
    await fs.ensureDir(taskTempDir);

    // Initialize/Restore task tracking
    const abortController = new AbortController();
    let metadata: any;
    
    if (existingId) {
      const history = await getHistory();
      const existingTask = history.find((t: any) => t.id === existingId);
      if (existingTask) {
        metadata = {
          ...existingTask,
          status: 'idle',
          message: '等待重新启动下载...',
          progress: existingTask.progress || 0,
          logs: [...(existingTask.logs || []), {
            timestamp: new Date().toLocaleTimeString(),
            message: '--- 加入等待队列 ---',
            type: 'warning'
          }]
        };
      }
    }

    if (!metadata) {
      metadata = {
        url,
        filename: safeFilename,
        progress: 0,
        message: '等待队列中...',
        timemark: '00:00:00',
        logs: [] as any[],
        options: { headers, format, videoBitrate, audioBitrate, videoCodec, videoPreset },
        status: 'idle'
      };
    }
    
    // We create the task, but wait for the queue to trigger run()
    const taskEntry = { abortController, isCancelled: false, metadata, run: async () => {} };
    activeTasks.set(downloadId, taskEntry);
    await saveToHistory({ id: downloadId, ...metadata });

    const sendLog = async (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
      const log = {
        timestamp: new Date().toLocaleTimeString(),
        message,
        type
      };
      metadata.logs.push(log);
      io.emit(`download-log-${downloadId}`, log);
      await saveToHistory({ id: downloadId, ...metadata });
    };

    res.json({ downloadId, filename: safeFilename });

    taskEntry.run = async () => {
      return new Promise<void>(async (resolveTask) => {
        try {
          await fs.ensureDir(taskTempDir);
          sendLog(`任务启动: ${safeFilename}`);
          io.emit(`download-start-${downloadId}`, { message: '正在解析 M3U8 列表...' });
          sendLog('正在解析 M3U8 列表...');

      // 1. Fetch and parse M3U8
      const axiosHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      };

      try {
        const urlObj = new URL(url);
        axiosHeaders['Referer'] = urlObj.origin + '/';
        axiosHeaders['Origin'] = urlObj.origin;
      } catch (e) {
        console.warn('Invalid URL for Referer:', url);
      }

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
        signal: abortController.signal,
        timeout: 15000
      });
      
      if (activeTasks.get(downloadId)?.isCancelled) return;

      // Get the final URL after redirects to correctly resolve relative segment paths
      const finalUrl = response.request?.res?.responseUrl || url;
      
      // Update Referer and Origin headers based on the final URL for segment requests
      try {
        const finalUrlObj = new URL(finalUrl);
        axiosHeaders['Referer'] = finalUrlObj.origin + '/';
        axiosHeaders['Origin'] = finalUrlObj.origin;
      } catch (e) {
        // Fallback to original headers if finalUrl is somehow invalid
      }

      const m3u8Content = response.data;
      const lines = m3u8Content.split('\n');
      const segments: string[] = [];
      let totalDuration = 0;

      sendLog(`解析成功，共发现 ${lines.length} 行内容`);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
          const duration = parseFloat(line.split(':')[1]);
          if (!isNaN(duration)) totalDuration += duration;
        }
        if (line && !line.startsWith('#')) {
          try {
            // Use URL constructor for robust relative path resolution
            const resolvedUrl = new URL(line, finalUrl).toString();
            segments.push(resolvedUrl);
          } catch (e) {
            console.error(`Failed to resolve segment URL: ${line} with base ${finalUrl}`);
          }
        }
      }

      if (segments.length === 0) {
        sendLog('未在 M3U8 中找到视频分片', 'error');
        throw new Error('未在 M3U8 中找到视频分片');
      }

      metadata.totalDuration = totalDuration;
      sendLog(`准备下载 ${segments.length} 个视频分片 (预估时长: ${Math.round(totalDuration)} 秒)...`);

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
            // Skill check: If file already exists and has content, skip download
            if (await fs.pathExists(segmentPath)) {
              const stats = await fs.stat(segmentPath);
              if (stats.size > 0) {
                segmentFiles[segmentIndex] = segmentPath;
                return;
              }
            }

            const segResponse = await axios.get(segmentUrl, { 
              headers: axiosHeaders,
              responseType: 'arraybuffer',
              timeout: 30000,
              signal: abortController.signal
            });
            if (segResponse.data.length === 0) throw new Error('Empty segment');
            await fs.writeFile(segmentPath, segResponse.data);
            segmentFiles[segmentIndex] = segmentPath;
          } catch (err) {
            if (axios.isCancel(err) || abortController.signal.aborted) return;
            
            const status = err.response?.status;
            console.error(`Failed to download segment ${segmentIndex} (Status: ${status}):`, err.message);
            
            if (status === 403) {
              throw new Error(`分片 ${segmentIndex} 下载被拒绝 (403)。请尝试在高级选项中添加正确的请求头 (Referer/User-Agent)。`);
            }

            // Retry once
            try {
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
              const segResponse = await axios.get(segmentUrl, { 
                headers: axiosHeaders,
                responseType: 'arraybuffer',
                timeout: 45000,
                signal: abortController.signal
              });
              await fs.writeFile(segmentPath, segResponse.data);
              segmentFiles[segmentIndex] = segmentPath;
            } catch (retryErr) {
              if (axios.isCancel(retryErr) || abortController.signal.aborted) return;
              throw new Error(`分片 ${segmentIndex} 下载失败 (重试后): ${retryErr.message}`);
            }
          }
        }));

        const progress = Math.round(((i + batch.length) / segments.length) * 100);
        metadata.progress = progress;
        metadata.stage = 'downloading';
        metadata.message = `正在下载分片: ${i + batch.length}/${segments.length}`;
        sendLog(`下载进度: ${i + batch.length}/${segments.length} (${progress}%)`);
        io.emit(`download-progress-${downloadId}`, { 
          percent: progress,
          message: metadata.message,
          stage: 'downloading'
        });
        await saveToHistory({ id: downloadId, ...metadata, status: 'downloading' });
      }

      if (activeTasks.get(downloadId)?.isCancelled) return;

      // New: Wait for FFmpeg slot before merging/encoding
      metadata.message = '等待 FFmpeg 队列...';
      metadata.stage = 'merging';
      io.emit(`download-progress-${downloadId}`, { percent: metadata.progress, message: '等待 FFmpeg 队列...', stage: 'merging' });
      sendLog('已加入 FFmpeg 转码队列，正在等待空闲槽位...', 'warning');

      while (currentConcurrentFFmpeg >= maxConcurrentFFmpeg) {
        if (activeTasks.get(downloadId)?.isCancelled) return;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      currentConcurrentFFmpeg++;

      // 3. Prepare FFmpeg concat list
      sendLog('正在配置 FFmpeg 分片合并...', 'info');
      // Keep progress at 100 from download phase instead of resetting to 0
      metadata.stage = 'merging';
      metadata.message = '配置合并阶段...';
      io.emit(`download-progress-${downloadId}`, { percent: 100, message: '配置合并阶段...', stage: 'merging' });
      
      const concatListPath = path.join(taskTempDir, 'concat_list.txt');
      let concatListContent = '';
      
      for (let i = 0; i < segments.length; i++) {
        const segmentFilename = `segment_${i.toString().padStart(5, '0')}.ts`;
        const segmentPath = path.join(taskTempDir, segmentFilename);
        if (!(await fs.pathExists(segmentPath))) {
          throw new Error(`分片 ${i} 丢失，无法合并`);
        }
        // Use relative path for FFmpeg concat file
        concatListContent += `file '${segmentFilename}'\n`;
      }
      
      await fs.writeFile(concatListPath, concatListContent);

      const command = ffmpeg();
      command.input(concatListPath);
      
      const inputOptions = ['-f', 'concat', '-safe', '0'];

      if (videoCodec === 'h264_vaapi') {
        inputOptions.push('-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi');
        if (fs.existsSync('/dev/dri/renderD128')) {
          inputOptions.push('-vaapi_device', '/dev/dri/renderD128');
        }
      }
      
      command.inputOptions(inputOptions);
      
      // Store command for cancellation
      const taskEntry = activeTasks.get(downloadId);
      if (taskEntry) {
        taskEntry.ffmpegCommand = command;
      }
      
      sendLog('正在启动 FFmpeg 进行视频转码/封装...', 'info');

      // Optimization: Use all available CPU cores
      command.outputOptions('-threads 0');

      if (videoCodec === 'copy') {
        command.outputOptions('-c copy');
      } else {
        // Optimization: Handle different codecs including GPU acceleration
        if (videoCodec === 'h264_vaapi') {
          // Linux VAAPI hardware acceleration (Intel/AMD on Linux)
          command.videoCodec('h264_vaapi');
        } else {
          command.videoCodec(videoCodec);
          // Ensure compatibility with most players (for CPU encoding)
          if (videoCodec === 'libx264' || videoCodec === 'libx265') {
            command.outputOptions('-pix_fmt yuv420p');
            command.outputOptions(`-preset ${videoPreset}`);
          }
        }

        if (videoBitrate) {
          const vb = /^\d+$/.test(videoBitrate) ? `${videoBitrate}k` : videoBitrate;
          command.videoBitrate(vb);
        }
        
        // Optimization: Ensure audio is AAC for MP4 compatibility if re-encoding
        if (format === 'mp4') {
          command.audioCodec('aac');
        }

        if (audioBitrate) {
          const ab = /^\d+$/.test(audioBitrate) ? `${audioBitrate}k` : audioBitrate;
          command.audioBitrate(ab);
        }
      }

      // Optimization: Add faststart for MP4 to allow web playback before full download
      if (format === 'mp4') {
        command.outputOptions('-movflags +faststart');
        if (videoCodec === 'copy') {
          command.outputOptions('-bsf:a aac_adtstoasc');
        }
      }

      command
        .on('start', (commandLine) => {
          sendLog(`FFmpeg 命令已启动`);
          console.log('Spawned Ffmpeg for task: ' + commandLine);
        })
        .on('progress', (progress) => {
          if (activeTasks.get(downloadId)?.isCancelled) return;
          
          let percent = progress.percent;
          
          // Fallback progress calculation if FFmpeg doesn't report it
          if ((percent === undefined || percent <= 0) && metadata.totalDuration > 0) {
            const timemark = progress.timemark; // HH:MM:SS.MS
            const parts = timemark.split(':');
            if (parts.length === 3) {
              const seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
              percent = (seconds / metadata.totalDuration) * 100;
            }
          }
          
          const finalPercent = Math.min(99, Math.round(percent || 0));
          metadata.progress = finalPercent;
          metadata.timemark = progress.timemark || metadata.timemark;
          metadata.message = videoCodec.includes('vaapi') ? '正在使用硬件加速转码...' : '正在进行视频转码/封装...';
          
          sendLog(`转码进度: ${finalPercent}% (时间点: ${progress.timemark})`);
          io.emit(`download-progress-${downloadId}`, { 
            percent: finalPercent,
            message: metadata.message,
            timemark: metadata.timemark,
            stage: 'encoding'
          });
        })
        .on('error', async (err, stdout, stderr) => {
          if (activeTasks.get(downloadId)?.isCancelled) {
            sendLog('任务已取消', 'warning');
            await saveToHistory({ id: downloadId, ...metadata, status: 'cancelled' });
            io.emit(`download-cancelled-${downloadId}`);
            console.log(`Ffmpeg process for ${downloadId} was killed (cancelled)`);
            return;
          }

          // Fallback logic for unsupported codecs or hardware issues
          const stderrStr = stderr || '';
          const isHardwareErrorInfo = 
            stderrStr.includes('Unknown encoder') || 
            stderrStr.includes('Codec not found') || 
            stderrStr.includes('Error while opening encoder') || 
            stderrStr.includes('vaapi') ||
            stderrStr.includes('VAAPI') ||
            stderrStr.includes('device') ||
            stderrStr.includes('hwupload') ||
            err.message.includes('Unknown encoder');

          if (isHardwareErrorInfo && videoCodec !== 'libx264') {
            console.log(`Codec ${videoCodec} failed or hardware unavailable, falling back to libx264`);
            sendLog(`检测到硬件编码器 ${videoCodec} 不可用或硬件访问受限，正在回退到 libx264 (CPU)...`, 'warning');
            
            // Restart FFmpeg with libx264
            const retryCommand = ffmpeg();
            retryCommand.input(concatListPath).inputOptions(['-f', 'concat', '-safe', '0']);
            const currentTask = activeTasks.get(downloadId);
            if (currentTask) currentTask.ffmpegCommand = retryCommand;
            
            retryCommand
              .outputOptions('-threads 0')
              .outputOptions('-pix_fmt yuv420p')
              .videoCodec('libx264')
              .outputOptions(`-preset ${videoPreset}`);
              
            if (videoBitrate) retryCommand.videoBitrate(videoBitrate);
            
            if (format === 'mp4') {
              retryCommand.audioCodec('aac');
              retryCommand.outputOptions('-movflags +faststart');
            }
            if (audioBitrate) retryCommand.audioBitrate(audioBitrate);
            
            retryCommand
              .on('start', () => sendLog('回退重试: FFmpeg 已启动 (libx264)', 'info'))
              .on('progress', (progress) => {
                if (activeTasks.get(downloadId)?.isCancelled) return;
                
                let percent = progress.percent;
                if ((percent === undefined || percent <= 0) && metadata.totalDuration > 0) {
                  const parts = progress.timemark.split(':');
                  if (parts.length === 3) {
                    const seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
                    percent = (seconds / metadata.totalDuration) * 100;
                  }
                }
                
                const finalPercent = Math.min(99, Math.round(percent || 0));
                metadata.timemark = progress.timemark;
                io.emit(`download-progress-${downloadId}`, { 
                  percent: finalPercent,
                  message: `回退转码中: ${progress.timemark}`,
                  stage: 'encoding'
                });
              })
              .on('error', async (nestedErr, nStdout, nStderr) => {
                 console.error('Fallback error:', nestedErr.message);
                 const finalError = nStderr ? nStderr.split('\n').filter(l => l.trim()).pop() : nestedErr.message;
                 sendLog(`转码失败 (回退后): ${finalError}`, 'error');
                 io.emit(`download-error-${downloadId}`, { error: `转码失败: ${finalError}` });
                 metadata.progress = 0;
                 await saveToHistory({ id: downloadId, ...metadata, status: 'error', error: `转码失败: ${finalError}`, completedAt: new Date().toLocaleString('zh-CN') });
                 activeTasks.delete(downloadId);
                 currentConcurrentFFmpeg--;
                 resolveTask();
              })
              .on('end', async () => {
                console.log('Fallback processing finished!');
                const downloadUrl = `/downloads/${safeFilename}`;
                io.emit(`download-complete-${downloadId}`, { url: downloadUrl, filename: safeFilename });
                await saveToHistory({ id: downloadId, ...metadata, status: 'completed', stage: 'completed', progress: 100, downloadUrl, completedAt: new Date().toLocaleString('zh-CN') });
                activeTasks.delete(downloadId);
                currentConcurrentFFmpeg--;
                resolveTask();
              })
              .save(outputPath);
              
            return;
          }

          console.error('Merge error:', err.message);
          if (stderr) {
            console.error('FFmpeg stderr:', stderr);
            sendLog(`FFmpeg 错误: ${stderr.split('\n').pop()}`, 'error');
          }
          const errorMsg = stderr ? stderr.split('\n').filter(l => l.trim()).pop() : err.message;
          sendLog(`合并失败: ${errorMsg}`, 'error');
          io.emit(`download-error-${downloadId}`, { error: `合并失败: ${errorMsg}` });
          
          metadata.progress = 0;
          await saveToHistory({ 
            id: downloadId, 
            ...metadata, 
            status: 'error', 
            error: `合并失败: ${errorMsg}`,
            completedAt: new Date().toLocaleString('zh-CN')
          });

          // Rely on background cleanup instead of immediate deletion to allow retries
          // fs.remove(taskTempDir).catch(console.error);
          activeTasks.delete(downloadId);
          currentConcurrentFFmpeg--;
          resolveTask();
        })
        .on('end', async () => {
          console.log('Merge finished!');
          const downloadUrl = `/downloads/${safeFilename}`;
          io.emit(`download-complete-${downloadId}`, { 
            url: downloadUrl,
            filename: safeFilename 
          });

          await saveToHistory({ 
            id: downloadId, 
            ...metadata, 
            status: 'completed', 
            stage: 'completed',
            progress: 100,
            downloadUrl,
            completedAt: new Date().toLocaleString('zh-CN')
          });

          // Rely on background cleanup
          // await fs.remove(taskTempDir).catch(console.error);
          activeTasks.delete(downloadId);
          currentConcurrentFFmpeg--;
          resolveTask();
        })
        .save(outputPath);

        } catch (err) {
          if (axios.isCancel(err) || abortController.signal.aborted || activeTasks.get(downloadId)?.isCancelled) {
            console.log(`Task ${downloadId} aborted during execution`);
            if (metadata.stage === 'merging' || metadata.stage === 'encoding') {
              currentConcurrentFFmpeg--;
            }
            resolveTask();
            return;
          }
          console.error('Download task failed:', err);
          io.emit(`download-error-${downloadId}`, { error: err.message });
          // Keep files for retry
          // await fs.remove(taskTempDir).catch(console.error);
          if (metadata.stage === 'merging' || metadata.stage === 'encoding') {
            currentConcurrentFFmpeg--;
          }
          activeTasks.delete(downloadId);
          resolveTask();
        }
      });
    };

    checkQueue();
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

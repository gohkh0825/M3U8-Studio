import { exec } from 'child_process';

exec('ffmpeg -version', (error, stdout, stderr) => {
  if (error) {
    console.error('Error executing ffmpeg:', error.message);
    return;
  }
  console.log('FFmpeg version output:', stdout.split('\n')[0]);
});

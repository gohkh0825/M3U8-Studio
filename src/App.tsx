import React, { useState, useEffect, useRef } from 'react';
import { Download, Link as LinkIcon, FileVideo, CheckCircle2, AlertCircle, Loader2, Settings2, Trash2, Layers, Zap, ShieldCheck, ExternalLink, ArrowRight, Copy, X } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';

interface DownloadState {
  id: string;
  url: string;
  filename: string;
  status: 'idle' | 'downloading' | 'completed' | 'error';
  progress: number;
  timemark: string;
  error?: string;
  downloadUrl?: string;
  completedAt?: string;
}

export default function App() {
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [batchInput, setBatchInput] = useState('');
  const [customHeaders, setCustomHeaders] = useState('');
  const [format, setFormat] = useState('mp4');
  const [videoCodec, setVideoCodec] = useState('copy');
  const [videoBitrate, setVideoBitrate] = useState('');
  const [audioBitrate, setAudioBitrate] = useState('');
  const [downloads, setDownloads] = useState<DownloadState[]>(() => {
    const saved = localStorage.getItem('m3u8_download_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as DownloadState[];
        return parsed.map(d => d.status === 'downloading' ? { ...d, status: 'error', error: '页面刷新，任务中断' } : d);
      } catch (e) {
        console.error('Failed to parse history:', e);
        return [];
      }
    }
    return [];
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    localStorage.setItem('m3u8_download_history', JSON.stringify(downloads));
  }, [downloads]);

  useEffect(() => {
    socketRef.current = io();
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const [showCopyToast, setShowCopyToast] = useState(false);

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const clearCompleted = () => {
    setDownloads(prev => prev.filter(d => d.status !== 'completed' && d.status !== 'error'));
  };

  const clearAll = () => {
    setDownloads([]);
    setShowClearConfirm(false);
  };

  const removeTask = (id: string) => {
    setDownloads(prev => prev.filter(d => d.id !== id));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setShowCopyToast(true);
    setTimeout(() => setShowCopyToast(false), 2000);
  };

  const startDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const headers = customHeaders.trim().split('\n').filter(h => h.includes(':')).join('\r\n');
    const tasks: { url: string; filename: string }[] = [];

    if (isBatchMode) {
      if (!batchInput.trim()) return;
      const lines = batchInput.split('\n').filter(line => line.trim());
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const dUrl = parts[0];
        const dFilename = parts.slice(1).join('_');
        if (dUrl.startsWith('http')) {
          tasks.push({ url: dUrl, filename: dFilename });
        }
      }
    } else {
      if (!url.trim()) return;
      tasks.push({ url, filename });
    }

    if (tasks.length === 0) return;

    setIsSubmitting(true);
    
    for (const task of tasks) {
      try {
        const response = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            url: task.url, 
            filename: task.filename, 
            headers, 
            format,
            videoCodec,
            videoBitrate: videoBitrate ? `${videoBitrate}k` : undefined,
            audioBitrate: audioBitrate ? `${audioBitrate}k` : undefined
          }),
        });

        const data = await response.json();
        const newDownload: DownloadState = {
          id: data.downloadId,
          url: task.url,
          filename: data.filename,
          status: 'downloading',
          progress: 0,
          timemark: '00:00:00',
        };

        setDownloads(prev => [newDownload, ...prev]);

        const socket = socketRef.current;
        if (socket) {
          const dId = data.downloadId;
          socket.on(`download-progress-${dId}`, (update) => {
            setDownloads(prev => prev.map(d => 
              d.id === dId ? { ...d, progress: update.percent || 0, timemark: update.timemark } : d
            ));
          });

          socket.on(`download-complete-${dId}`, (update) => {
            setDownloads(prev => prev.map(d => 
              d.id === dId ? { 
                ...d, 
                status: 'completed', 
                downloadUrl: update.url, 
                progress: 100,
                completedAt: new Date().toLocaleString('zh-CN')
              } : d
            ));
          });

          socket.on(`download-error-${dId}`, (update) => {
            setDownloads(prev => prev.map(d => 
              d.id === dId ? { 
                ...d, 
                status: 'error', 
                error: update.error,
                completedAt: new Date().toLocaleString('zh-CN')
              } : d
            ));
          });
        }
      } catch (err) {
        console.error('下载启动失败:', err);
      }
    }

    if (isBatchMode) {
      setBatchInput('');
    } else {
      setUrl('');
      setFilename('');
    }
    setIsSubmitting(false);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans selection:bg-brand-100">
      {/* Background Pattern */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-brand-200/20 blur-[120px] rounded-full" />
        <div className="absolute top-[20%] -right-[5%] w-[30%] h-[30%] bg-indigo-200/20 blur-[100px] rounded-full" />
        <div className="absolute -bottom-[10%] left-[20%] w-[35%] h-[35%] bg-purple-200/20 blur-[110px] rounded-full" />
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-[0.03] mix-blend-overlay" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-6 py-12 lg:py-20">
        {/* Navigation / Top Bar */}
        <nav className="flex items-center justify-between mb-16">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-brand-600 rounded-xl flex items-center justify-center shadow-lg shadow-brand-200">
              <Download className="text-white" size={20} />
            </div>
            <span className="text-xl font-display font-bold tracking-tight">M3U8 <span className="text-brand-600">Studio</span></span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#" className="text-sm font-medium text-slate-500 hover:text-brand-600 transition-colors">文档</a>
            <a href="#" className="text-sm font-medium text-slate-500 hover:text-brand-600 transition-colors">反馈</a>
            <div className="h-4 w-px bg-slate-200" />
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-lg shadow-sm">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">Server Online</span>
            </div>
          </div>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          {/* Left Column: Control Panel */}
          <div className="lg:col-span-7 space-y-8">
            <div className="space-y-6">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="inline-flex items-center gap-2 px-3 py-1 bg-brand-50 border border-brand-100 rounded-full"
              >
                <Zap size={14} className="text-brand-600" />
                <span className="text-[10px] font-black text-brand-700 uppercase tracking-widest">Next-Gen Downloader</span>
              </motion.div>
              <h1 className="text-6xl lg:text-7xl font-display font-bold text-slate-900 leading-[1] tracking-tight">
                专业级视频流 <br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-600 via-indigo-600 to-purple-600">抓取与转换</span>
              </h1>
              <p className="text-xl text-slate-500 max-w-xl leading-relaxed font-medium">
                支持多任务并行、自定义标头伪装及多种编码格式。无论是单任务还是批量抓取，都能轻松应对。
              </p>
            </div>

            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass rounded-[2.5rem] p-8 lg:p-10"
            >
              <form onSubmit={startDownload} className="space-y-8">
                {/* Mode Switcher */}
                <div className="flex p-1.5 bg-slate-100/80 backdrop-blur-sm rounded-2xl w-fit border border-slate-200/50">
                  <button
                    type="button"
                    onClick={() => setIsBatchMode(false)}
                    className={`px-8 py-2.5 rounded-xl text-sm font-bold transition-all duration-300 ${!isBatchMode ? 'bg-white text-brand-600 shadow-md shadow-brand-500/10' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    单任务模式
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsBatchMode(true)}
                    className={`px-8 py-2.5 rounded-xl text-sm font-bold transition-all duration-300 ${isBatchMode ? 'bg-white text-brand-600 shadow-md shadow-brand-500/10' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    批量模式
                  </button>
                </div>

                <AnimatePresence mode="wait">
                  {isBatchMode ? (
                    <motion.div
                      key="batch"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="space-y-3"
                    >
                      <label className="text-sm font-bold text-slate-700 flex items-center gap-2 ml-1">
                        <Layers size={16} className="text-brand-500" />
                        批量任务列表
                      </label>
                      <textarea
                        required
                        rows={6}
                        placeholder="http://example.com/video1.m3u8 电影1&#10;http://example.com/video2.m3u8 电影2"
                        className="w-full bg-white/50 border border-slate-200 rounded-2xl py-4 px-5 focus:outline-none focus:ring-4 focus:ring-brand-500/10 focus:border-brand-500 transition-all text-slate-800 placeholder:text-slate-400 text-sm font-mono leading-relaxed"
                        value={batchInput}
                        onChange={(e) => setBatchInput(e.target.value)}
                      />
                      <p className="text-[11px] text-slate-400 ml-1">格式：URL [空格] 视频名称 (每行一个)</p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="single"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="space-y-5"
                    >
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-slate-700 flex items-center gap-2 ml-1">
                          <LinkIcon size={16} className="text-brand-500" />
                          视频源地址 (M3U8)
                        </label>
                        <div className="relative group">
                          <input
                            type="url"
                            required
                            placeholder="https://example.com/playlist.m3u8"
                            className="w-full bg-white/50 border border-slate-200 rounded-2xl py-4 px-5 pr-12 focus:outline-none focus:ring-4 focus:ring-brand-500/10 focus:border-brand-500 transition-all text-slate-800 placeholder:text-slate-400"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                          />
                          <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-brand-500 transition-colors">
                            <Zap size={20} />
                          </div>
                        </div>
                      </div>
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-slate-700 flex items-center gap-2 ml-1">
                          <FileVideo size={16} className="text-brand-500" />
                          保存文件名
                        </label>
                        <input
                          type="text"
                          placeholder="留空将自动生成时间戳名称"
                          className="w-full bg-white/50 border border-slate-200 rounded-2xl py-4 px-5 focus:outline-none focus:ring-4 focus:ring-brand-500/10 focus:border-brand-500 transition-all text-sm"
                          value={filename}
                          onChange={(e) => setFilename(e.target.value)}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-slate-700 flex items-center gap-2 ml-1">
                      <Settings2 size={16} className="text-brand-500" />
                      输出容器格式
                    </label>
                    <select
                      className="w-full bg-white/50 border border-slate-200 rounded-2xl py-4 px-5 focus:outline-none focus:ring-4 focus:ring-brand-500/10 focus:border-brand-500 transition-all text-sm appearance-none cursor-pointer"
                      value={format}
                      onChange={(e) => setFormat(e.target.value)}
                    >
                      <option value="mp4">MP4 (推荐 - 兼容性最佳)</option>
                      <option value="mkv">MKV (支持多音轨/字幕)</option>
                      <option value="ts">TS (原始流 - 无损转换)</option>
                      <option value="mov">MOV (Apple 专用)</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className={`w-full py-4 px-5 rounded-2xl border font-bold text-sm flex items-center justify-center gap-2 transition-all ${showAdvanced ? 'bg-brand-50 border-brand-200 text-brand-600' : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'}`}
                    >
                      <Settings2 size={18} className={showAdvanced ? 'animate-spin-slow' : ''} />
                      {showAdvanced ? '收起高级设置' : '高级编码设置'}
                    </button>
                  </div>
                </div>

                <AnimatePresence>
                  {showAdvanced && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="p-6 bg-slate-50/50 rounded-3xl border border-slate-100 space-y-6">
                        <div className="space-y-3">
                          <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">附加请求标头 (Headers)</label>
                          <textarea
                            rows={3}
                            placeholder="Origin: http://www.example.com&#10;Referer: http://www.example.com"
                            className="w-full bg-white border border-slate-200 rounded-2xl py-3.5 px-4 text-sm focus:ring-4 focus:ring-brand-500/10 outline-none font-mono leading-relaxed"
                            value={customHeaders}
                            onChange={(e) => setCustomHeaders(e.target.value)}
                          />
                        </div>
                        
                        <div className="space-y-3">
                          <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">视频编码器 (Codec)</label>
                          <div className="grid grid-cols-3 gap-3">
                            {[
                              { id: 'copy', label: '直接流复制', desc: '极速/无损' },
                              { id: 'libx264', label: 'H.264', desc: '高兼容' },
                              { id: 'libx265', label: 'H.265/HEVC', desc: '高压缩' }
                            ].map(codec => (
                              <button
                                key={codec.id}
                                type="button"
                                onClick={() => setVideoCodec(codec.id)}
                                className={`p-3 rounded-2xl border text-left transition-all ${
                                  videoCodec === codec.id 
                                  ? 'bg-brand-600 border-brand-600 text-white shadow-md shadow-brand-100' 
                                  : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'
                                }`}
                              >
                                <div className="text-xs font-bold">{codec.label}</div>
                                <div className={`text-[9px] mt-0.5 ${videoCodec === codec.id ? 'text-brand-100' : 'text-slate-400'}`}>{codec.desc}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-3">
                            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">视频码率 (Bitrate)</label>
                            <div className="relative">
                              <input
                                type="number"
                                placeholder="默认"
                                className="w-full bg-white border border-slate-200 rounded-2xl py-3.5 px-4 pr-12 text-sm focus:ring-4 focus:ring-brand-500/10 outline-none"
                                value={videoBitrate}
                                onChange={(e) => setVideoBitrate(e.target.value)}
                              />
                              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">kbps</span>
                            </div>
                          </div>
                          <div className="space-y-3">
                            <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">音频码率 (Bitrate)</label>
                            <div className="relative">
                              <input
                                type="number"
                                placeholder="默认"
                                className="w-full bg-white border border-slate-200 rounded-2xl py-3.5 px-4 pr-12 text-sm focus:ring-4 focus:ring-brand-500/10 outline-none"
                                value={audioBitrate}
                                onChange={(e) => setAudioBitrate(e.target.value)}
                              />
                              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">kbps</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  type="submit"
                  disabled={isSubmitting || (isBatchMode ? !batchInput.trim() : !url.trim())}
                  className="group relative w-full bg-brand-600 hover:bg-brand-700 disabled:bg-slate-200 text-white font-bold py-5 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-xl shadow-brand-200 active:scale-[0.98] overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-shimmer" />
                  {isSubmitting ? <Loader2 className="animate-spin" size={24} /> : <Download size={24} />}
                  <span className="text-xl tracking-tight">
                    {isSubmitting ? '正在初始化队列...' : (isBatchMode ? '开始批量处理任务' : '立即开始下载')}
                  </span>
                  {!isSubmitting && <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />}
                </button>
              </form>
            </motion.div>

            {/* Features Info */}
            <div className="grid grid-cols-3 gap-6 pt-4">
              {[
                { icon: Zap, title: '极速抓取', desc: '多线程切片处理' },
                { icon: ShieldCheck, title: '安全伪装', desc: '自定义标头支持' },
                { icon: Layers, title: '批量处理', desc: '无上限任务队列' }
              ].map((feature, i) => (
                <div key={i} className="flex flex-col items-center text-center space-y-2">
                  <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm border border-slate-100">
                    <feature.icon size={18} className="text-brand-600" />
                  </div>
                  <h3 className="text-xs font-bold text-slate-800">{feature.title}</h3>
                  <p className="text-[10px] text-slate-400">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: Task Queue */}
          <div className="lg:col-span-5 space-y-6">
            <div className="flex items-center justify-between px-4">
              <div className="flex items-center gap-4">
                <h2 className="text-3xl font-display font-bold text-slate-900">任务队列</h2>
                <div className="relative">
                  <div className="absolute inset-0 bg-brand-500 blur-md opacity-20 rounded-full" />
                  <span className="relative bg-brand-600 text-white text-[11px] font-black px-3 py-1 rounded-full shadow-lg shadow-brand-200">
                    {downloads.length}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {downloads.some(d => d.status === 'completed' || d.status === 'error') && (
                  <button 
                    onClick={clearCompleted}
                    className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-brand-600 transition-colors"
                  >
                    <CheckCircle2 size={14} />
                    清空已完成
                  </button>
                )}
                {downloads.length > 0 && (
                  <div className="relative">
                    <button 
                      onClick={() => setShowClearConfirm(!showClearConfirm)}
                      className="flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-rose-500 transition-colors"
                    >
                      <Trash2 size={14} />
                      全部清空
                    </button>
                    
                    <AnimatePresence>
                      {showClearConfirm && (
                        <motion.div
                          initial={{ opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 10, scale: 0.95 }}
                          className="absolute right-0 top-full mt-2 w-48 bg-white rounded-2xl shadow-2xl border border-slate-100 p-4 z-50"
                        >
                          <p className="text-xs font-bold text-slate-700 mb-3 text-center">确定清空所有任务？</p>
                          <div className="flex gap-2">
                            <button 
                              onClick={() => setShowClearConfirm(false)}
                              className="flex-1 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded-lg hover:bg-slate-200 transition-colors"
                            >
                              取消
                            </button>
                            <button 
                              onClick={clearAll}
                              className="flex-1 py-1.5 bg-rose-500 text-white text-[10px] font-bold rounded-lg hover:bg-rose-600 transition-colors"
                            >
                              确定
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4 max-h-[800px] overflow-y-auto pr-2 custom-scrollbar pb-10">
              <AnimatePresence initial={false} mode="popLayout">
                {downloads.length === 0 ? (
                    <motion.div 
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-center py-32 glass rounded-[2.5rem] text-slate-400 border-2 border-dashed border-slate-200/50"
                    >
                    <div className="mb-4 flex justify-center">
                      <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center">
                        <FileVideo size={32} className="opacity-20" />
                      </div>
                    </div>
                    <p className="text-sm font-bold text-slate-500">队列空空如也</p>
                    <p className="text-xs mt-1.5">在左侧添加任务开始您的下载之旅</p>
                  </motion.div>
                ) : (
                  downloads.map((download) => (
                    <motion.div
                      key={download.id}
                      layout
                      initial={{ opacity: 0, x: 30 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.9, x: 20 }}
                      className="glass rounded-3xl p-6 group relative overflow-hidden"
                    >
                      {/* Progress Background Glow */}
                      {download.status === 'downloading' && (
                        <div 
                          className="absolute inset-0 bg-brand-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                          style={{ clipPath: `inset(0 ${100 - download.progress}% 0 0)` }}
                        />
                      )}

                      <div className="flex items-start justify-between gap-4 mb-6 relative z-10">
                        <div className="flex items-center gap-4">
                          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all shadow-sm ${
                            download.status === 'completed' ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' :
                            download.status === 'error' ? 'bg-rose-50 text-rose-600 border border-rose-100' :
                            'bg-brand-50 text-brand-600 border border-brand-100'
                          }`}>
                            {download.status === 'completed' ? <CheckCircle2 size={28} /> :
                             download.status === 'error' ? <AlertCircle size={28} /> :
                             <Loader2 className="animate-spin" size={28} />}
                          </div>
                          <div className="min-w-0">
                            <h3 className="font-bold text-base text-slate-800 truncate max-w-[220px]" title={download.url}>
                              {download.filename || '未命名任务'}
                            </h3>
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md ${
                                download.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                                download.status === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-brand-100 text-brand-700'
                              }`}>
                                {download.status === 'completed' ? 'Success' :
                                 download.status === 'error' ? 'Failed' : 'Downloading'}
                              </span>
                              {download.completedAt && (
                                <>
                                  <div className="w-1 h-1 rounded-full bg-slate-300" />
                                  <span className="text-[10px] text-slate-400 font-bold">
                                    {download.completedAt}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          {download.status === 'completed' && (
                            <button
                              onClick={() => copyToClipboard(download.url)}
                              className="p-2 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-xl transition-all"
                              title="复制源链接"
                            >
                              <Copy size={16} />
                            </button>
                          )}
                          <button
                            onClick={() => removeTask(download.id)}
                            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all"
                            title="移除任务"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      </div>

                      {(download.status === 'downloading' || download.status === 'completed') && (
                        <div className="space-y-4 relative z-10">
                          <div className="flex justify-between items-end">
                            <div className="space-y-1">
                              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Progress</p>
                              <div className="flex items-baseline gap-1">
                                <span className={`text-2xl font-display font-bold ${download.status === 'completed' ? 'text-emerald-600' : 'text-slate-900'}`}>
                                  {download.status === 'completed' ? '100' : Math.round(download.progress) || 0}
                                </span>
                                <span className="text-xs font-bold text-slate-400">%</span>
                              </div>
                            </div>
                            <div className="text-right space-y-1">
                              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                {download.status === 'completed' ? 'Duration' : 'Elapsed'}
                              </p>
                              <p className="text-sm font-bold text-slate-700 font-mono">{download.timemark}</p>
                            </div>
                          </div>
                          
                          <div className="h-2.5 w-full bg-slate-100/50 rounded-full overflow-hidden relative shadow-inner border border-slate-200/50">
                            {download.status === 'downloading' && (
                              <motion.div 
                                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent w-1/2 z-10"
                                animate={{ x: ['-100%', '200%'] }}
                                transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                              />
                            )}
                            
                            <motion.div 
                              className={`h-full relative z-0 rounded-full shadow-sm ${
                                download.status === 'completed' ? 'bg-gradient-to-r from-emerald-500 to-teal-500' : 'bg-gradient-to-r from-brand-500 to-indigo-500'
                              }`}
                              initial={{ width: 0 }}
                              animate={{ 
                                width: download.status === 'completed' ? '100%' : `${download.progress || 2}%` 
                              }}
                              transition={{ type: 'spring', bounce: 0, duration: 0.8 }}
                            >
                              {download.status === 'downloading' && !download.progress && (
                                <motion.div 
                                  className="absolute inset-0 bg-white/20"
                                  animate={{ opacity: [0, 1, 0] }}
                                  transition={{ repeat: Infinity, duration: 1.5 }}
                                />
                              )}
                            </motion.div>
                          </div>

                          {download.status === 'completed' && (
                            <motion.a
                              whileHover={{ scale: 1.02, y: -2 }}
                              whileTap={{ scale: 0.98 }}
                              href={download.downloadUrl}
                              download
                              className="w-full flex items-center justify-center gap-2 py-3.5 bg-brand-600 text-white text-sm font-bold rounded-2xl shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all mt-2"
                            >
                              <ExternalLink size={18} />
                              保存视频文件
                            </motion.a>
                          )}
                        </div>
                      )}

                      {download.status === 'error' && (
                        <div className="mt-2 flex items-start gap-3 bg-rose-50/50 p-4 rounded-2xl border border-rose-100/50">
                          <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
                          <p className="text-xs text-rose-600 font-medium leading-relaxed">
                            {download.error}
                          </p>
                        </div>
                      )}
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-32 pt-10 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
            <span>© 2026 M3U8 Studio Pro</span>
            <div className="w-1 h-1 rounded-full bg-slate-300" />
            <span>极速、安全、专业</span>
          </div>
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <ShieldCheck size={14} className="text-emerald-500" />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Privacy Guaranteed</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap size={14} className="text-amber-500" />
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Auto-Cleanup Enabled</span>
            </div>
          </div>
        </footer>
      </div>

      <AnimatePresence>
        {showCopyToast && (
          <motion.div
            initial={{ opacity: 0, y: 20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="fixed bottom-10 left-1/2 z-50 bg-slate-900 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border border-white/10 backdrop-blur-xl"
          >
            <div className="w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center">
              <CheckCircle2 size={14} />
            </div>
            <span className="text-sm font-bold tracking-tight">链接已复制到剪贴板</span>
          </motion.div>
        )}
      </AnimatePresence>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes shimmer {
          100% { transform: translateX(100%); }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite;
        }
        .animate-spin-slow {
          animation: spin 3s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #cbd5e1;
        }
      `}} />
    </div>
  );
}

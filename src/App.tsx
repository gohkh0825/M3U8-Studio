import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Download, Link as LinkIcon, FileVideo, CheckCircle2, AlertCircle, Loader2, Settings2, Trash2, Layers, Zap, ShieldCheck, ExternalLink, ArrowRight, Copy, X, List, CheckSquare, Plus, HelpCircle, ChevronLeft, ChevronRight, Search, RotateCcw, Pause, Play } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';

interface DownloadLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

interface DownloadState {
  id: string;
  url: string;
  filename: string;
  status: 'idle' | 'downloading' | 'completed' | 'error' | 'cancelled' | 'paused';
  progress: number;
  timemark: string;
  stage?: 'downloading' | 'merging' | 'encoding' | 'completed';
  message?: string;
  error?: string;
  downloadUrl?: string;
  completedAt?: string;
  logs?: DownloadLog[];
  options?: {
    headers?: string;
    format?: string;
    videoCodec?: string;
    videoPreset?: string;
    videoBitrate?: string;
    audioBitrate?: string;
    useVfScale?: boolean;
  };
  retryCount?: number;
}

type TabType = 'downloading' | 'completed' | 'settings';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('downloading');
  const [showNewDownloadModal, setShowNewDownloadModal] = useState(false);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [batchInput, setBatchInput] = useState('');
  const [customHeaders, setCustomHeaders] = useState('');
  const [format, setFormat] = useState('mp4');
  const [videoCodec, setVideoCodec] = useState('copy');
  const [videoPreset, setVideoPreset] = useState('fast');
  const [videoBitrate, setVideoBitrate] = useState('');
  const [audioBitrate, setAudioBitrate] = useState('');
  const [useVfScale, setUseVfScale] = useState(false);
  const [downloads, setDownloads] = useState<DownloadState[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [maxConcurrent, setMaxConcurrent] = useState<number>(3);
  const [maxFFmpeg, setMaxFFmpeg] = useState<number>(1);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    socketRef.current = io();
    
    // Fetch settings logic
    fetch('/api/settings/concurrency')
      .then(res => res.json())
      .then(data => {
        if (data) {
          if (data.maxConcurrentDownloads) setMaxConcurrent(data.maxConcurrentDownloads);
          if (data.maxConcurrentFFmpeg) setMaxFFmpeg(data.maxConcurrentFFmpeg);
        }
      })
      .catch(console.error);
    
    // Fetch history from server on mount
    const fetchHistory = async () => {
      try {
        const response = await fetch('/api/tasks');
        const data = await response.json();
        
        if (data.tasks) {
          setDownloads(data.tasks);
          data.tasks.forEach((task: any) => {
            if (task.status === 'downloading') {
              attachTaskListeners(task.id);
            }
          });
        }
      } catch (err) {
        console.error('Failed to fetch history:', err);
      }
    };

    fetchHistory();

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const attachTaskListeners = (dId: string) => {
    const socket = socketRef.current;
    if (!socket) return;

    // Remove existing listeners to avoid duplicates
    socket.off(`download-start-${dId}`);
    socket.off(`download-progress-${dId}`);
    socket.off(`download-complete-${dId}`);
    socket.off(`download-log-${dId}`);
    socket.off(`download-error-${dId}`);

    socket.on(`download-start-${dId}`, (update) => {
      setDownloads(prev => prev.map(d => 
        d.id === dId ? { ...d, message: update.message } : d
      ));
    });

    socket.on(`download-progress-${dId}`, (update) => {
      setDownloads(prev => prev.map(d => 
        d.id === dId ? { 
          ...d, 
          progress: update.percent || 0, 
          timemark: update.timemark || d.timemark,
          message: update.message || d.message,
          stage: update.stage || d.stage,
          status: update.status || d.status
        } : d
      ));
    });

    socket.on(`download-complete-${dId}`, (update) => {
      setDownloads(prev => prev.map(d => 
        d.id === dId ? { 
          ...d, 
          status: 'completed', 
          stage: 'completed',
          downloadUrl: update.url, 
          progress: 100,
          completedAt: new Date().toLocaleString('zh-CN')
        } : d
      ));
    });

    socket.on(`download-log-${dId}`, (log) => {
      setDownloads(prev => prev.map(d => 
        d.id === dId ? { ...d, logs: [...(d.logs || []), log] } : d
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

    socket.on(`download-cancelled-${dId}`, () => {
      setDownloads(prev => prev.map(d => 
        d.id === dId ? { 
          ...d, 
          status: 'cancelled',
          message: '任务已取消',
          completedAt: new Date().toLocaleString('zh-CN')
        } : d
      ));
    });
  };

  const toggleSelectTask = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        visibleIds.forEach(id => newSet.delete(id));
        return newSet;
      });
    } else {
      setSelectedIds(prev => {
        const newSet = new Set(prev);
        visibleIds.forEach(id => newSet.add(id));
        return newSet;
      });
    }
  };

  const batchDelete = async () => {
    if (selectedIds.size === 0) return;
    
    const idsToDelete = Array.from(selectedIds) as string[];
    setSelectedIds(new Set()); // Optimistic selection clear

    await Promise.all(idsToDelete.map(id => removeTask(id)));
  };

  const batchCancel = async () => {
    if (selectedIds.size === 0) return;
    
    const idsToCancel = Array.from(selectedIds) as string[];
    const tasksToCancel = downloads.filter(d => idsToCancel.includes(d.id) && d.status === 'downloading');
    
    setSelectedIds(new Set());
    await Promise.all(tasksToCancel.map(task => 
      fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId: task.id }),
      }).catch(err => console.error(`Failed to cancel task ${task.id}:`, err))
    ));
  };

  const [showCopyToast, setShowCopyToast] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [viewingLogId, setViewingLogId] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (viewingLogId) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [viewingLogId, downloads.find(d => d.id === viewingLogId)?.logs]);

  const parseFfmpegLog = (message: string) => {
    const msg = message.toLowerCase();
    
    if (msg.includes('ffmpeg version')) return { type: 'version', icon: <Layers size={14} /> };
    if (msg.includes('built with')) return { type: 'build', icon: <Layers size={14} /> };
    if (msg.includes('configuration')) return { type: 'config', icon: <Settings2 size={14} /> };
    if (msg.startsWith('stream #')) return { type: 'stream', icon: <ArrowRight size={14} /> };
    if (msg.startsWith('metadata:') || msg.includes('duration:') || msg.includes('bitrate:')) return { type: 'metadata', icon: <FileVideo size={14} /> };
    if (msg.includes('vaapi') || msg.includes('hardware') || msg.includes('hwaccel')) return { type: 'hardware', icon: <Zap size={14} /> };
    if (msg.includes('frame=') || msg.includes('bitrate=') || msg.includes('speed=')) return { type: 'progress', icon: <Loader2 size={14} className="animate-spin-slow opacity-60" /> };
    if (msg.includes('codec') || msg.includes('encoder')) return { type: 'codec', icon: <Layers size={14} /> };
    if (msg.includes('input #') || msg.includes('output #')) return { type: 'io', icon: <ExternalLink size={14} /> };
    if (msg.includes('error') || msg.includes('failed') || msg.includes('invalid') || msg.includes('could not')) return { type: 'error', icon: <AlertCircle size={14} /> };
    
    return { type: 'default', icon: null };
  };

  const clearCompleted = () => {
    setDownloads(prev => prev.filter(d => d.status !== 'completed' && d.status !== 'error'));
  };

  const updateMaxConcurrent = async (value: number) => {
    setMaxConcurrent(value);
    try {
      await fetch('/api/settings/concurrency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentDownloads: value, maxConcurrentFFmpeg: maxFFmpeg }),
      });
    } catch (err) {
      console.error('Failed to update max concurrent downloads', err);
    }
  };

  const updateMaxFFmpeg = async (value: number) => {
    setMaxFFmpeg(value);
    try {
      await fetch('/api/settings/concurrency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentDownloads: maxConcurrent, maxConcurrentFFmpeg: value }),
      });
    } catch (err) {
      console.error('Failed to update max concurrent ffmpeg', err);
    }
  };

  const clearAll = async () => {
    const activeDownloads = downloads.filter(d => d.status === 'downloading');
    
    await Promise.all(activeDownloads.map(task => 
      fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId: task.id }),
      }).catch(err => console.error(`Failed to cancel task ${task.id}:`, err))
    ));
    
    try {
      await fetch('/api/clear-history', { method: 'POST' });
      setDownloads([]);
      setSelectedIds(new Set());
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
    
    setShowClearConfirm(false);
  };

  const removeTask = async (id: string) => {
    const task = downloads.find(d => d.id === id);
    if (task && task.status === 'downloading') {
      try {
        await fetch('/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ downloadId: id }),
        });
      } catch (err) {
        console.error('Failed to cancel task:', err);
      }
    }
    
    try {
      await fetch('/api/delete-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setDownloads(prev => prev.filter(d => d.id !== id));
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const pauseTask = async (id: string) => {
    try {
      const response = await fetch('/api/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId: id }),
      });
      if (!response.ok) {
        const data = await response.json();
        console.error('Failed to pause:', data.error);
      }
    } catch (err) {
      console.error('Failed to pause task:', err);
    }
  };

  const resumeTask = async (id: string) => {
    try {
      const response = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId: id }),
      });
      if (!response.ok) {
        const data = await response.json();
        console.error('Failed to resume:', data.error);
      }
    } catch (err) {
      console.error('Failed to resume task:', err);
    }
  };

  const retryTask = async (id: string) => {
    const task = downloads.find(d => d.id === id);
    if (!task) return;

    // Reset task state locally
    setDownloads(prev => prev.map(d => 
      d.id === id ? { 
        ...d, 
        status: 'idle', 
        stage: 'downloading',
        progress: 0, 
        error: undefined, 
        message: '等待重新启动...',
        logs: [] 
      } : d
    ));

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url: task.url, 
          filename: task.filename, 
          downloadId: id,
          ...(task.options || {})
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '重试失败');
      }

      attachTaskListeners(id);
    } catch (err: any) {
      setDownloads(prev => prev.map(d => 
        d.id === id ? { ...d, status: 'error', error: err.message } : d
      ));
    }
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
      let processedUrl = task.url.trim();
      // Fix common encoding issue: &timestamp being converted to ×tamp
      if (processedUrl.includes('×tamp=')) {
        processedUrl = processedUrl.replace(/×tamp=/g, '&timestamp=');
      }

      try {
        const response = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            url: processedUrl, 
            filename: task.filename, 
            headers, 
            format,
            videoCodec,
            videoPreset,
            videoBitrate: videoBitrate ? `${videoBitrate}k` : undefined,
            audioBitrate: audioBitrate ? `${audioBitrate}k` : undefined,
            useVfScale
          }),
        });

        const data = await response.json();
        const newDownload: DownloadState = {
          id: data.downloadId,
          url: task.url,
          filename: data.filename,
          status: 'idle',
          stage: 'downloading',
          progress: 0,
          timemark: '00:00:00',
          message: '等待队列中...',
          options: {
            headers,
            format,
            videoCodec,
            videoPreset,
            videoBitrate: videoBitrate ? `${videoBitrate}k` : undefined,
            audioBitrate: audioBitrate ? `${audioBitrate}k` : undefined,
            useVfScale
          }
        };

        setDownloads(prev => [newDownload, ...prev]);
        attachTaskListeners(data.downloadId);
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
    setShowNewDownloadModal(false);
  };

  const filteredDownloads = useMemo(() => {
    return downloads.filter(d => {
      if (activeTab === 'downloading') return d.status === 'downloading' || d.status === 'idle';
      if (activeTab === 'completed') return d.status === 'completed' || d.status === 'error' || d.status === 'cancelled';
      return true;
    });
  }, [downloads, activeTab]);

  const visibleIds = useMemo(() => filteredDownloads.map(d => d.id), [filteredDownloads]);
  const selectedCount = useMemo(() => visibleIds.filter(id => selectedIds.has(id)).length, [visibleIds, selectedIds]);
  const isAllSelected = visibleIds.length > 0 && selectedCount === visibleIds.length;
  const isIndeterminate = selectedCount > 0 && selectedCount < visibleIds.length;

  return (
    <div className="flex h-screen bg-dark-bg text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-dark-sidebar border-r border-dark-border flex flex-col z-20">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-500 rounded-lg flex items-center justify-center shadow-lg shadow-brand-500/20">
            <Download className="text-white" size={18} />
          </div>
          <span className="text-lg font-bold tracking-tight">Media <span className="text-brand-400">Go</span></span>
          <span className="text-[10px] text-slate-500 mt-1 ml-auto">v3.1.1</span>
        </div>

        <nav className="flex-1 px-4 py-4 space-y-2">
          <button
            onClick={() => setActiveTab('downloading')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'downloading' 
              ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/20' 
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <Download size={18} />
            下载列表
          </button>
          <button
            onClick={() => setActiveTab('completed')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'completed' 
              ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/20' 
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <CheckSquare size={18} />
            下载完成
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'settings' 
              ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/20' 
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <Settings2 size={18} />
            软件设置
          </button>
        </nav>

        <div className="p-6 border-t border-dark-border">
          <div className="flex items-center gap-2 text-slate-500 hover:text-slate-300 cursor-pointer transition-colors">
            <HelpCircle size={16} />
            <span className="text-xs font-medium">使用帮助</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="h-16 border-b border-dark-border flex items-center justify-between px-8 bg-dark-sidebar/50 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-bold text-slate-300">
              {activeTab === 'downloading' ? '下载列表' : activeTab === 'completed' ? '下载完成' : '软件设置'}
            </h2>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowNewDownloadModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-bold transition-all shadow-lg shadow-brand-500/10"
            >
              <Plus size={16} />
              新建下载
            </button>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          {activeTab === 'settings' ? (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-2xl space-y-8"
            >
              <div className="glass rounded-2xl p-8 space-y-6">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <Settings2 size={20} className="text-brand-400" />
                  常规设置
                </h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-white/5 rounded-xl border border-white/5">
                    <div>
                      <p className="text-sm font-bold">自动清理临时文件</p>
                      <p className="text-xs text-slate-500">自动清理下载过程中的分片缓存，不影响已合成的视频</p>
                    </div>
                    <div className="w-10 h-5 bg-brand-500 rounded-full relative cursor-pointer">
                      <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-white/5 rounded-xl border border-white/5">
                    <div>
                      <p className="text-sm font-bold">下载完成后通知</p>
                      <p className="text-xs text-slate-500">在系统通知栏显示下载结果</p>
                    </div>
                    <div className="w-10 h-5 bg-slate-700 rounded-full relative cursor-pointer">
                      <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 p-4 bg-white/5 rounded-xl border border-white/5">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold">最大同时下载数</p>
                        <p className="text-xs text-slate-500">设置允许同时进行的下载任务数量 (1-10)</p>
                      </div>
                      <span className="text-xl font-bold font-mono text-brand-400">{maxConcurrent}</span>
                    </div>
                    <input 
                      type="range" 
                      min="1" 
                      max="10" 
                      value={maxConcurrent}
                      onChange={(e) => updateMaxConcurrent(parseInt(e.target.value))}
                      className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
                    />
                  </div>
                  <div className="flex flex-col gap-3 p-4 bg-white/5 rounded-xl border border-white/5">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold">最大 FFmpeg 并发数</p>
                        <p className="text-xs text-slate-500">设置允许同时进行的格式转换/合并任务数量 (1-3)</p>
                      </div>
                      <span className="text-xl font-bold font-mono text-brand-400">{maxFFmpeg}</span>
                    </div>
                    <input 
                      type="range" 
                      min="1" 
                      max="3" 
                      value={maxFFmpeg}
                      onChange={(e) => updateMaxFFmpeg(parseInt(e.target.value))}
                      className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
                    />
                  </div>
                </div>
              </div>

              <div className="glass rounded-2xl p-8 space-y-6">
                <h3 className="text-lg font-bold flex items-center gap-2 text-rose-400">
                  <Trash2 size={20} />
                  危险区域
                </h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-rose-500/5 rounded-xl border border-rose-500/10">
                    <div>
                      <p className="text-sm font-bold text-rose-400">清除所有历史</p>
                      <p className="text-xs text-slate-500">删除所有下载记录并停止正在进行的任务</p>
                    </div>
                    <button 
                      onClick={() => setShowClearConfirm(true)}
                      className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-lg text-xs font-bold transition-all border border-rose-500/20"
                    >
                      立即清除
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          ) : (
            <div className="space-y-6">
              {/* List Header Actions */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-4">
                  <label 
                    className="flex items-center gap-2 cursor-pointer group"
                    onClick={(e) => {
                      e.preventDefault();
                      toggleSelectAll();
                    }}
                  >
                    <div className={`w-4 h-4 border-2 rounded transition-all flex items-center justify-center ${
                      isAllSelected ? 'bg-brand-500 border-brand-500' : 
                      isIndeterminate ? 'border-brand-500' : 'border-slate-600 group-hover:border-brand-500'
                    }`}>
                      {isAllSelected && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
                      {isIndeterminate && <div className="w-2 h-0.5 bg-brand-500" />}
                    </div>
                    <span className="text-xs font-bold text-slate-400 group-hover:text-slate-200 transition-colors">全选</span>
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={batchDelete}
                    disabled={selectedIds.size === 0}
                    className="px-3 py-1.5 text-[11px] font-bold text-slate-400 hover:text-rose-400 bg-white/5 hover:bg-rose-500/10 rounded-lg border border-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    删除
                  </button>
                  <button 
                    onClick={batchCancel}
                    disabled={selectedIds.size === 0}
                    className="px-3 py-1.5 text-[11px] font-bold text-slate-400 hover:text-amber-400 bg-white/5 hover:bg-amber-500/10 rounded-lg border border-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    取消
                  </button>
                </div>
              </div>

              {/* Task List */}
              <div className="space-y-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {filteredDownloads.length === 0 ? (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex flex-col items-center justify-center py-40 text-slate-500"
                    >
                      <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mb-4">
                        <Layers size={32} className="opacity-20" />
                      </div>
                      <p className="text-sm font-bold">暂无数据</p>
                    </motion.div>
                  ) : (
                    filteredDownloads.map((download) => (
                      <motion.div
                        key={download.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className={`group bg-dark-card border rounded-xl p-4 transition-all ${
                          selectedIds.has(download.id) ? 'border-brand-500 bg-brand-500/5' : 'border-dark-border hover:border-brand-500/50'
                        }`}
                      >
                        <div className="flex items-center gap-4">
                          <button 
                            onClick={() => toggleSelectTask(download.id)}
                            className={`w-4 h-4 border-2 rounded shrink-0 transition-all flex items-center justify-center ${
                              selectedIds.has(download.id) ? 'bg-brand-500 border-brand-500' : 'border-slate-700 hover:border-brand-500'
                            }`}
                          >
                            {selectedIds.has(download.id) && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
                          </button>
                          
                          <div className="w-10 h-10 bg-white/5 rounded-lg flex items-center justify-center shrink-0">
                            {download.status === 'completed' ? <CheckCircle2 size={20} className="text-emerald-500" /> :
                             download.status === 'error' ? <AlertCircle size={20} className="text-rose-500" /> :
                             download.status === 'cancelled' ? <AlertCircle size={20} className="text-amber-500" /> :
                             download.status === 'paused' ? <Pause size={20} className="text-amber-400" /> :
                             download.status === 'idle' ? <List size={20} className="text-slate-500" /> :
                             <Loader2 className="animate-spin text-brand-400" size={20} />}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2 min-w-0">
                                <h3 className="text-sm font-bold truncate">{download.filename}</h3>
                                {download.stage && download.status === 'downloading' && (
                                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                                    download.stage === 'downloading' ? 'bg-blue-500/20 text-blue-400' :
                                    download.stage === 'merging' ? 'bg-amber-500/20 text-amber-400' :
                                    'bg-purple-500/20 text-purple-400'
                                  }`}>
                                    {download.stage === 'downloading' ? '下载中' :
                                     download.stage === 'merging' ? '合并中' : '转码中'}
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] font-mono text-slate-500">{download.timemark}</span>
                            </div>
                            
                            <div className="flex items-center gap-3">
                              <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                                <motion.div 
                                  className={`h-full ${
                                    download.status === 'completed' ? 'bg-emerald-500' : 
                                    download.status === 'paused' ? 'bg-amber-400/50' : 
                                    (download.stage === 'merging' || download.stage === 'encoding') ? 'bg-amber-500' : 
                                    'bg-brand-500'
                                  }`}
                                  initial={{ width: 0 }}
                                  animate={{ width: `${download.progress}%` }}
                                />
                              </div>
                              <span className="text-[10px] font-bold w-8 text-right">{Math.round(download.progress)}%</span>
                            </div>
                            
                            {download.message && download.status === 'downloading' && (
                              <p className="text-[10px] text-slate-500 mt-1">{download.message}</p>
                            )}
                            {download.error && (
                              <p className="text-[10px] text-rose-500 mt-1">{download.error}</p>
                            )}
                          </div>

                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={() => setViewingLogId(download.id)}
                              className="p-2 text-slate-400 hover:text-brand-400 transition-colors"
                              title="查看日志"
                            >
                              <List size={16} />
                            </button>
                            {download.status === 'downloading' && download.stage === 'downloading' && (
                              <button 
                                onClick={() => pauseTask(download.id)}
                                className="p-2 text-slate-400 hover:text-amber-400 transition-colors"
                                title="暂停下载"
                              >
                                <Pause size={16} />
                              </button>
                            )}
                            {download.status === 'paused' && (
                              <button 
                                onClick={() => resumeTask(download.id)}
                                className="p-2 text-slate-400 hover:text-emerald-400 transition-colors"
                                title="继续下载"
                              >
                                <Play size={16} />
                              </button>
                            )}
                            {(download.status === 'error' || download.status === 'cancelled') && (
                              <button 
                                onClick={() => retryTask(download.id)}
                                className="p-2 text-slate-400 hover:text-amber-400 transition-colors"
                                title="重试任务"
                              >
                                <RotateCcw size={16} />
                              </button>
                            )}
                            {download.status === 'completed' && (
                              <a 
                                href={download.downloadUrl} 
                                download 
                                className="p-2 text-slate-400 hover:text-brand-400 transition-colors"
                              >
                                <Download size={16} />
                              </a>
                            )}
                            <button 
                              onClick={() => removeTask(download.id)}
                              className="p-2 text-slate-400 hover:text-rose-400 transition-colors"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>

              {/* Pagination Placeholder */}
              {filteredDownloads.length > 0 && (
                <div className="flex justify-center gap-2 mt-8">
                  <button className="p-1.5 rounded-lg bg-white/5 text-slate-500 hover:text-slate-200 transition-colors">
                    <ChevronLeft size={16} />
                  </button>
                  <button className="w-8 h-8 rounded-lg bg-brand-500 text-white text-xs font-bold">1</button>
                  <button className="p-1.5 rounded-lg bg-white/5 text-slate-500 hover:text-slate-200 transition-colors">
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* New Download Modal */}
      <AnimatePresence>
        {showNewDownloadModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowNewDownloadModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-xl bg-dark-sidebar border border-dark-border rounded-[2rem] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              <div className="p-6 px-8 flex items-center justify-between border-b border-white/5 bg-dark-sidebar/50 backdrop-blur-md z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center">
                    <Plus size={20} className="text-brand-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">新建下载任务</h3>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">New Download Task</p>
                  </div>
                </div>
                <button onClick={() => setShowNewDownloadModal(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors text-slate-400 hover:text-white">
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 pt-6 overflow-y-auto custom-scrollbar flex-1">
                <form onSubmit={startDownload} className="space-y-8 pb-10">
                  {/* Mode Switcher */}
                  <div className="flex p-1 bg-white/5 rounded-xl w-fit border border-white/5">
                    <button
                      type="button"
                      onClick={() => setIsBatchMode(false)}
                      className={`px-6 py-1.5 rounded-lg text-xs font-bold transition-all ${!isBatchMode ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/20' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      单任务
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsBatchMode(true)}
                      className={`px-6 py-1.5 rounded-lg text-xs font-bold transition-all ${isBatchMode ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/20' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      批量模式
                    </button>
                  </div>

                  {isBatchMode ? (
                    <div className="space-y-2">
                      <textarea
                        required
                        rows={5}
                        placeholder="http://example.com/video1.m3u8 电影1&#10;http://example.com/video2.m3u8 电影2"
                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm font-mono"
                        value={batchInput}
                        onChange={(e) => setBatchInput(e.target.value)}
                      />
                      <p className="text-[10px] text-slate-500">格式：URL [空格] 视频名称 (每行一个)</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">视频源地址 (M3U8)</label>
                        <input
                          type="url"
                          required
                          placeholder="https://example.com/playlist.m3u8"
                          className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">保存文件名</label>
                        <input
                          type="text"
                          placeholder="留空将自动生成名称"
                          className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm"
                          value={filename}
                          onChange={(e) => setFilename(e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">格式</label>
                      <select
                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm appearance-none"
                        value={format}
                        onChange={(e) => setFormat(e.target.value)}
                      >
                        <option value="mp4">MP4</option>
                        <option value="mkv">MKV</option>
                        <option value="ts">TS</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">编码</label>
                      <select
                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm appearance-none"
                        value={videoCodec}
                        onChange={(e) => setVideoCodec(e.target.value)}
                      >
                        <option value="copy">流复制 (极速)</option>
                        <option value="libx264">H.264 (CPU)</option>
                        <option value="libx265">H.265 (CPU)</option>
                        <option value="h264_vaapi">H.264 (Linux GPU)</option>
                      </select>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-white/5">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className={`flex items-center justify-between w-full px-5 py-4 rounded-2xl text-sm font-bold transition-all border ${
                        showAdvanced 
                          ? 'bg-brand-500/10 border-brand-500/30 text-brand-400' 
                          : 'bg-white/5 border-white/5 text-slate-400 hover:text-slate-200 hover:bg-white/10'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Settings2 size={18} className={showAdvanced ? 'animate-spin-slow' : ''} />
                        <span>高级选项 (标头/码率)</span>
                      </div>
                      <ChevronRight size={18} className={`transition-transform duration-300 ${showAdvanced ? 'rotate-90' : ''}`} />
                    </button>

                    <AnimatePresence>
                      {showAdvanced && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3, ease: "easeInOut" }}
                          className="overflow-hidden"
                        >
                          <div className="pt-6 space-y-6">
                            <div className="space-y-2">
                              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">自定义标头 (Headers)</label>
                              <textarea
                                rows={3}
                                placeholder="User-Agent: Mozilla/5.0&#10;Referer: https://example.com"
                                className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm font-mono placeholder:text-slate-700"
                                value={customHeaders}
                                onChange={(e) => setCustomHeaders(e.target.value)}
                              />
                              <p className="text-[10px] text-slate-600">每行一个，格式为 Key: Value</p>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">视频码率 (kbps)</label>
                                <input
                                  type="number"
                                  placeholder="例如: 2000"
                                  className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm placeholder:text-slate-700"
                                  value={videoBitrate}
                                  onChange={(e) => setVideoBitrate(e.target.value)}
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">编码预设 (Preset)</label>
                                <select
                                  disabled={videoCodec === 'copy'}
                                  className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm appearance-none disabled:opacity-50"
                                  value={videoPreset}
                                  onChange={(e) => setVideoPreset(e.target.value)}
                                >
                                  <option value="ultrafast">极快 (Ultrafast)</option>
                                  <option value="superfast">超快 (Superfast)</option>
                                  <option value="veryfast">非常快 (Veryfast)</option>
                                  <option value="faster">更快 (Faster)</option>
                                  <option value="fast">快 (Fast)</option>
                                  <option value="medium">中等 (Medium)</option>
                                  <option value="slow">慢 (Slow)</option>
                                  <option value="slower">更慢 (Slower)</option>
                                  <option value="veryslow">非常慢 (Veryslow)</option>
                                </select>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">音频码率 (kbps)</label>
                                <input
                                  type="number"
                                  placeholder="例如: 128"
                                  className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 focus:border-brand-500 outline-none text-sm placeholder:text-slate-700"
                                  value={audioBitrate}
                                  onChange={(e) => setAudioBitrate(e.target.value)}
                                />
                              </div>
                            </div>

                            <div className="pt-2">
                              <label className="flex items-center gap-3 p-4 bg-white/5 rounded-xl border border-white/5 cursor-pointer hover:bg-white/10 transition-colors group">
                                <input 
                                  type="checkbox" 
                                  className="w-4 h-4 rounded border-slate-700 text-brand-500 focus:ring-brand-500 bg-slate-800"
                                  checked={useVfScale}
                                  onChange={(e) => setUseVfScale(e.target.checked)}
                                />
                                <div>
                                  <p className="text-sm font-bold group-hover:text-slate-200 transition-colors">强制硬件压缩规模 (VAAPI)</p>
                                  <p className="text-[10px] text-slate-500">添加 -vf "scale_vaapi=w=1920:h=1080,format=vaapi" 强制 1080p 输出</p>
                                </div>
                              </label>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="pt-4 pb-2">
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-brand-500 hover:bg-brand-600 disabled:bg-slate-700 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-brand-500/20 flex items-center justify-center gap-3 group"
                    >
                      {isSubmitting ? (
                        <Loader2 className="animate-spin" size={20} />
                      ) : (
                        <>
                          <Download size={20} className="group-hover:translate-y-0.5 transition-transform" />
                          <span>开始下载任务</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Clear Confirmation Modal */}
      <AnimatePresence>
        {showClearConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowClearConfirm(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-sm bg-dark-sidebar border border-dark-border rounded-3xl shadow-2xl p-8 space-y-6"
            >
              <div className="w-16 h-16 bg-rose-500/10 rounded-full flex items-center justify-center mx-auto">
                <AlertCircle size={32} className="text-rose-500" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-lg font-bold">确认清除所有记录？</h3>
                <p className="text-sm text-slate-500">此操作将删除所有下载历史并停止正在进行的任务，且无法撤销。</p>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowClearConfirm(false)}
                  className="flex-1 py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm font-bold transition-all"
                >
                  取消
                </button>
                <button 
                  onClick={clearAll}
                  className="flex-1 py-3 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-rose-500/20"
                >
                  确认清除
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Log Viewer Modal */}
      <AnimatePresence>
        {viewingLogId && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setViewingLogId(null)}
              className="absolute inset-0 bg-dark-bg/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-dark-sidebar border border-dark-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-dark-border flex items-center justify-between bg-dark-sidebar/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-brand-500/10 rounded-xl flex items-center justify-center">
                    <List size={20} className="text-brand-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-bold">任务日志</h3>
                      {downloads.find(d => d.id === viewingLogId)?.status === 'downloading' && (
                        <span className="flex items-center gap-1.5 px-2 py-0.5 bg-brand-500/20 text-brand-400 rounded-full text-[10px] font-bold animate-pulse">
                          <div className="w-1.5 h-1.5 bg-brand-400 rounded-full" />
                          LIVE
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate max-w-[300px]">
                      {downloads.find(d => d.id === viewingLogId)?.filename}
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => setViewingLogId(null)}
                  className="p-2 hover:bg-white/5 rounded-lg transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-1.5 bg-slate-950 font-mono text-[11px] custom-scrollbar selection:bg-brand-500/30">
                {downloads.find(d => d.id === viewingLogId)?.logs?.length ? (
                  <>
                    {downloads.find(d => d.id === viewingLogId)?.logs?.map((log, i) => {
                      const { type, icon } = parseFfmpegLog(log.message);
                      const isError = log.type === 'error' || type === 'error';
                      const isWarning = log.type === 'warning' || type === 'warning';
                      const isSuccess = log.type === 'success' || type === 'success';
                      const isSystem = type === 'hardware' || type === 'progress';

                      return (
                        <div key={i} className={`flex gap-3 px-2 py-1 rounded transition-colors group ${
                          isError ? 'bg-rose-500/5 hover:bg-rose-500/10' :
                          isWarning ? 'bg-amber-500/5 hover:bg-amber-500/10' :
                          isSuccess ? 'bg-emerald-500/5 hover:bg-emerald-500/10' :
                          isSystem ? 'bg-brand-500/5 hover:bg-brand-500/10' :
                          'hover:bg-white/5'
                        } animate-in fade-in slide-in-from-left-1 h-fit min-h-[1.5rem]`}>
                          <span className="text-slate-600 shrink-0 select-none opacity-50 group-hover:opacity-100 transition-opacity">
                            {log.timestamp.split(' ')[1] || log.timestamp}
                          </span>
                          
                          {icon && (
                            <span className={`shrink-0 mt-0.5 ${
                              isError ? 'text-rose-400' :
                              isWarning ? 'text-amber-400' :
                              isSuccess ? 'text-emerald-400' :
                              'text-brand-400'
                            }`}>
                              {icon}
                            </span>
                          )}

                          <span className={`break-all leading-relaxed ${
                            isError ? 'text-rose-300 font-medium' : 
                            isWarning ? 'text-amber-300' : 
                            isSuccess ? 'text-emerald-300 font-bold' : 
                            type === 'metadata' ? 'text-slate-400 italic' :
                            type === 'stream' ? 'text-indigo-300' :
                            type === 'hardware' ? 'text-brand-300 font-bold' :
                            type === 'progress' ? 'text-blue-300 opacity-80' :
                            'text-slate-400'
                          }`}>
                            {log.message}
                          </span>
                        </div>
                      );
                    })}
                    <div ref={logEndRef} className="h-4" />
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-24 text-slate-600">
                    <Loader2 className="animate-spin mb-4 opacity-20" size={32} />
                    <p className="text-sm font-medium italic">正在等待日志输出...</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {showCopyToast && (
          <motion.div
            initial={{ opacity: 0, y: 20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="fixed bottom-10 left-1/2 z-[100] bg-brand-500 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3"
          >
            <CheckCircle2 size={18} />
            <span className="text-sm font-bold">链接已复制</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

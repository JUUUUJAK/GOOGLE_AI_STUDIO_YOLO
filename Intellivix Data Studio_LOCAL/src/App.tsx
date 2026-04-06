import React, { useState } from 'react';
import YoloWorkspace from './modes/YoloWorkspace';
import VlmWorkspace from './modes/VlmWorkspace';

export type AppMode = 'yolo' | 'vlm';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('yolo');
  const isElectron = typeof window !== 'undefined' && !!window.electron;

  if (!isElectron) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400 p-8">
        <div className="w-14 h-14 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
          <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-300">Electron으로 실행해 주세요</p>
        <p className="text-xs text-slate-500 text-center max-w-sm">npm run electron:dev 또는 빌드 후 exe 실행</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-4 py-2.5 flex items-center gap-4 rounded-none z-10">
        <div className="flex items-center gap-2.5 shrink-0">
          <img src={`${import.meta.env.BASE_URL}logo.ico`} alt="" className="w-8 h-8 rounded-xl object-contain ring-1 ring-white/10" />
          <span className="font-bold text-sm sm:text-base tracking-tight text-white whitespace-nowrap">Intellivix Data Studio</span>
        </div>
        <div className="flex rounded-xl p-0.5 glass border border-white/10 shrink-0" role="tablist" aria-label="작업 모드">
                            <button
                              type="button"
            role="tab"
            aria-selected={mode === 'yolo'}
            onClick={() => setMode('yolo')}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'yolo' ? 'bg-[var(--accent-lime)] text-[#1A1A2E] shadow-[0_0_16px_rgba(168,230,27,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            YOLO 라벨
                            </button>
                            <button
                              type="button"
            role="tab"
            aria-selected={mode === 'vlm'}
            onClick={() => setMode('vlm')}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'vlm' ? 'bg-[var(--accent-purple)]/90 text-white shadow-[0_0_16px_rgba(176,142,212,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            VLM 검수
            </button>
        </div>
        <div className="flex-1 min-w-0" />
      </header>

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {mode === 'yolo' ? <YoloWorkspace /> : <VlmWorkspace />}
      </div>
    </div>
  );
};

export default App;

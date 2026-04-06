import React, { useState } from 'react';
import { AccountType, User } from '../types';
import { apiUrl } from '../services/apiBase';

interface LoginProps {
  onLogin: (user: User) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoggingIn) return;

    setError('');
    setIsLoggingIn(true);

    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        const user = await res.json();
        onLogin(user);
      } else {
        const data = await res.json();
        setError(data.error || 'Invalid credentials.');
      }
    } catch (err) {
      setError('Server connection failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden bg-[#0B0F19]">
      {/* Dynamic Background Effects */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-0 -left-1/4 w-[150%] h-[150%] bg-[radial-gradient(circle_at_50%_0%,rgba(56,189,248,0.08)_0%,transparent_50%)]"></div>
        <div className="absolute bottom-0 -right-1/4 w-[150%] h-[150%] bg-[radial-gradient(circle_at_50%_100%,rgba(16,185,129,0.05)_0%,transparent_50%)]"></div>
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl animate-[pulse_4s_ease-in-out_infinite]"></div>
        {/* Subtle grid pattern */}
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+DQogIDxwYXRoIGQ9Ik0wIDBoNDB2NDBIMHoiIGZpbGw9Im5vbmUiIC8+DQogIDxwYXRoIGQ9Ik0wIDBoMHY0MEgwem00MCAwaDB2NDBIMHptMCA0MEgwdjB6TTAgMGg0MHYwaC00MHoiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMykiIC8+DQo8L3N2Zz4=')] opacity-30"></div>
      </div>

      <div className="w-full max-w-[420px] relative z-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* Glassmorphic Card */}
        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/[0.08] rounded-3xl shadow-[0_0_40px_-10px_rgba(0,0,0,0.5)] overflow-hidden transition-all duration-300 hover:border-white/[0.12] hover:shadow-[0_0_50px_-10px_rgba(56,189,248,0.1)]">

          <div className="p-10 pb-8 text-center border-b border-white/[0.05] bg-gradient-to-b from-white/[0.03] to-transparent">
            <div className="mx-auto flex items-center justify-center mb-6 transform transition-transform hover:scale-105 duration-300">
              <img src="/logo.ico" alt="Logo" className="w-16 h-16 object-contain drop-shadow-md" />
            </div>
            <h1 className="text-3xl font-heading font-bold text-white tracking-tight leading-tight">Intellivix<br /><span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-sky-300">Data Studio</span></h1>
            <p className="text-slate-400 text-sm mt-3 font-medium">Log in to enter the workspace</p>
          </div>

          <form onSubmit={handleSubmit} className="p-10 space-y-6">
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-200 px-4 py-3 rounded-xl text-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                <span className="leading-snug">{error}</span>
              </div>
            )}

            <div className="space-y-5">
              <div className="group">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 transition-colors group-focus-within:text-blue-400">Username</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-500 group-focus-within:text-blue-400 transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  </div>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={isLoggingIn}
                    className="w-full bg-slate-950/50 border border-slate-800 rounded-xl pl-11 pr-4 py-3.5 text-slate-100 placeholder-slate-600 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 outline-none transition-all duration-300 disabled:opacity-50"
                    placeholder="Enter your worker ID"
                  />
                </div>
              </div>

              <div className="group">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 transition-colors group-focus-within:text-blue-400">Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-500 group-focus-within:text-blue-400 transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  </div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isLoggingIn}
                    className="w-full bg-slate-950/50 border border-slate-800 rounded-xl pl-11 pr-4 py-3.5 text-slate-100 placeholder-slate-600 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 outline-none transition-all duration-300 disabled:opacity-50 tracking-widest"
                    placeholder="••••••••"
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoggingIn || !username || !password}
              className="w-full relative group overflow-hidden bg-white text-slate-900 font-bold py-4 rounded-xl shadow-lg transition-all duration-300 hover:shadow-[0_0_20px_rgba(255,255,255,0.3)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none mt-4"
            >
              <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/50 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></div>

              <div className="relative flex items-center justify-center gap-2">
                {isLoggingIn ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-slate-900" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Authenticating...</span>
                  </>
                ) : (
                  <>
                    <span>Enter Workspace</span>
                    <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                  </>
                )}
              </div>
            </button>
          </form>

          <div className="px-10 py-5 bg-slate-950/40 border-t border-white/[0.05]">
            <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-500/5 border border-blue-500/10 transition-colors hover:bg-blue-500/10">
              <div className="mt-0.5 text-blue-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <div className="text-xs text-slate-400 leading-relaxed">
                <strong className="text-slate-300 block mb-0.5">Automated Sync</strong>
                Place folders in <code className="text-blue-400 bg-blue-400/10 px-1 py-0.5 rounded font-mono">/dataset</code> root to load.
              </div>
            </div>
          </div>
        </div>

        {/* Global Shimmer Animation Definition */}
        <style>{`
          @keyframes shimmer {
            100% { transform: translateX(100%); }
          }
        `}</style>
      </div>
    </div>
  );
};


export default Login;
import React, { useState } from 'react';
import { AccountType, User } from '../types';

interface LoginProps {
  onLogin: (user: User) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Mock Authentication Logic
    if (username === 'admin' && password === 'admin') {
      onLogin({ username: 'Admin User', accountType: AccountType.ADMIN });
    } else if (username.startsWith('worker') && password === 'worker') {
      onLogin({ username: username, accountType: AccountType.WORKER });
    } else {
      setError('Invalid credentials.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-8 pb-6 text-center border-b border-gray-800 bg-gray-900/50">
           <div className="w-16 h-16 bg-blue-600 rounded-xl mx-auto flex items-center justify-center font-bold text-2xl text-white shadow-lg mb-4">
             Y7
           </div>
           <h1 className="text-2xl font-bold text-white tracking-tight">YOLOv7 Data Studio</h1>
           <p className="text-gray-400 text-sm mt-2">Sign in to continue annotation</p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          {error && (
            <div className="bg-red-900/20 border border-red-900/50 text-red-200 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              {error}
            </div>
          )}
          
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-600 focus:border-transparent outline-none transition-all placeholder-gray-600"
              placeholder="Enter your username"
            />
          </div>

          <div>
             <label className="block text-sm font-medium text-gray-400 mb-1.5">Password</label>
             <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-600 focus:border-transparent outline-none transition-all placeholder-gray-600"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-lg shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2"
          >
            Sign In
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
          </button>
        </form>
        
        <div className="px-8 py-4 bg-gray-950/50 border-t border-gray-800">
            <div className="text-center space-y-2">
                <div className="text-xs text-gray-500 bg-gray-800/50 p-2 rounded border border-gray-800">
                    <p className="mb-1 font-bold">Automatic Dataset Loading</p>
                    <p>Place your folders and images in <code className="text-blue-400">/dataset</code> folder in project root.</p>
                </div>
                <div className="pt-2 text-center space-y-1">
                    <p className="text-xs text-gray-600">
                        Admin: <span className="font-mono text-gray-500">admin / admin</span>
                    </p>
                    <p className="text-xs text-gray-600">
                        Workers: <span className="font-mono text-gray-500">worker1 / worker</span>
                    </p>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
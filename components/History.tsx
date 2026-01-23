import React, { useMemo } from 'react';
import { AccountType, WorkLog, UserRole } from '../types';
import * as Storage from '../services/storage';

interface HistoryProps {
  currentUser: string;
  accountType: AccountType;
}

interface FolderStats {
  folderName: string;
  workerName: string;
  taskCount: number;
  manualObjects: number; // Sum of manually created or edited objects
  totalTime: number; // Seconds
  lastActive: number; // Timestamp
}

const History: React.FC<HistoryProps> = ({ currentUser, accountType }) => {
  const logs = Storage.getLogs();

  const historyData = useMemo(() => {
    const statsMap = new Map<string, FolderStats>();

    // Filter logs: Only consider 'SUBMIT' actions for counting completed worker tasks.
    // 'APPROVE' could be used for reviewer stats, but let's focus on worker productivity.
    const relevantLogs = logs.filter(log => log.action === 'SUBMIT');

    relevantLogs.forEach(log => {
      // If Admin, show all. If Worker, show only their own.
      if (accountType === AccountType.WORKER && log.userId !== currentUser) return;

      const key = `${log.folder}-${log.userId}`;
      const current = statsMap.get(key) || {
        folderName: log.folder,
        workerName: log.userId,
        taskCount: 0,
        manualObjects: 0,
        totalTime: 0,
        lastActive: 0
      };

      current.taskCount += 1;
      // Count as modified if isModified flag is true.
      // Backward compatibility: If isModified is undefined, assume modified if manualBoxCount > 0
      if (log.isModified || (log.isModified === undefined && (log.stats?.manualBoxCount || 0) > 0)) {
        current.manualObjects += 1;
      }
      current.totalTime += (log.durationSeconds || 0);
      current.lastActive = Math.max(current.lastActive, log.timestamp);

      statsMap.set(key, current);
    });

    return Array.from(statsMap.values()).sort((a, b) => b.lastActive - a.lastActive);
  }, [logs, currentUser, accountType]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const handleDownloadCSV = () => {
    const csvRows = [
      ['Folder', 'Worker', 'Tasks Completed', 'Manual Objects (New/Edited)', 'Total Time (h)', 'Avg Time/Task (s)', 'Last Active']
    ];

    historyData.forEach(row => {
      csvRows.push([
        row.folderName,
        row.workerName,
        row.taskCount.toString(),
        row.manualObjects.toString(),
        (row.totalTime / 3600).toFixed(2),
        (row.taskCount > 0 ? (row.totalTime / row.taskCount).toFixed(0) : '0'),
        new Date(row.lastActive).toISOString()
      ]);
    });

    const csvContent = csvRows.map(e => e.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yolov7_history_${new Date().toISOString()}.csv`;
    a.click();
  };

  return (
    <div className="w-full max-w-5xl mx-auto h-full flex flex-col bg-gray-950 p-6">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Work History & Performance</h2>
          <p className="text-gray-400 mt-1">
            {accountType === AccountType.ADMIN
              ? "Aggregated performance metrics across all folders and workers."
              : "Your contribution history across different folders."}
          </p>
        </div>
        <button
          onClick={handleDownloadCSV}
          className="bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 hover:text-white px-5 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
          Export Report
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-lg flex-1 flex flex-col">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-800/50 border-b border-gray-700 text-gray-400 text-sm uppercase tracking-wider">
                <th className="p-4 font-semibold">Folder</th>
                <th className="p-4 font-semibold">Worker</th>
                <th className="p-4 font-semibold text-right">Tasks Completed</th>
                <th className="p-4 font-semibold text-right text-blue-400">Modified Images*</th>
                <th className="p-4 font-semibold text-right">Total Time</th>
                <th className="p-4 font-semibold text-right">Avg Time / Task</th>
                <th className="p-4 font-semibold">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-sm text-gray-200">
              {historyData.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-gray-500 italic">
                    No work history found. Submit tasks to see stats here.
                  </td>
                </tr>
              ) : (
                historyData.map((row, idx) => (
                  <tr key={idx} className="hover:bg-gray-800/30 transition-colors">
                    <td className="p-4 font-medium text-white">{row.folderName}</td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-400">
                          {row.workerName.charAt(0).toUpperCase()}
                        </div>
                        {row.workerName}
                      </div>
                    </td>
                    <td className="p-4 text-right font-mono text-base">{row.taskCount}</td>
                    <td className="p-4 text-right font-mono text-base text-blue-300 font-bold bg-blue-900/10">
                      {row.manualObjects}
                    </td>
                    <td className="p-4 text-right font-mono text-gray-400">{formatTime(row.totalTime)}</td>
                    <td className="p-4 text-right font-mono text-gray-400">
                      {row.taskCount > 0 ? Math.round(row.totalTime / row.taskCount) + 's' : '-'}
                    </td>
                    <td className="p-4 text-gray-500 text-xs">
                      {new Date(row.lastActive).toLocaleDateString()} {new Date(row.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="p-4 bg-gray-900 border-t border-gray-800 text-xs text-gray-500">
          * <strong>Modified Images</strong>: Counts the number of images where the worker made manual edits (create, update, delete).
        </div>
      </div>
    </div>
  );
};

export default History;
import React, { useState, useMemo, useEffect } from 'react';
import { Task, TaskStatus, TaskStatusLabels, UserRole, FolderMetadata, AccountType } from '../types';
import * as Storage from '../services/storage';

interface DashboardProps {
    role: UserRole;
    accountType: AccountType;
    onSelectTask: (taskId: string) => void;
    onRefresh: () => void;
    tasks: Task[];
    username: string;
}

const ALL_FOLDERS_VIEW = 'OVERVIEW';
const AVAILABLE_WORKERS = ['worker1', 'worker2', 'worker3', 'worker4'];

const Dashboard: React.FC<DashboardProps> = ({ role, accountType, onSelectTask, onRefresh, tasks, username }) => {
    const logs = Storage.getLogs();

    const globalStats = {
        total: tasks.length,
        completed: tasks.filter(t => t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED).length,
        totalAnnotations: tasks.reduce((acc, t) => acc + t.annotations.length, 0),
        totalTime: logs.reduce((acc, l) => {
            const logTime = new Date(l.timestamp).getTime();
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            return logTime >= startOfDay.getTime() ? acc + (l.durationSeconds || 0) : acc;
        }, 0)
    };

    const visibleTasks = useMemo(() => {
        if (role === UserRole.WORKER) {
            return tasks.filter(t => t.status !== TaskStatus.APPROVED);
        } else {
            return [...tasks].sort((a, b) => {
                if (a.status === TaskStatus.SUBMITTED && b.status !== TaskStatus.SUBMITTED) return -1;
                if (a.status !== TaskStatus.SUBMITTED && b.status === TaskStatus.SUBMITTED) return 1;
                return 0;
            });
        }
    }, [role, tasks]);

    const folderOverviews = useMemo(() => {
        const map = new Map<string, {
            count: number,
            completed: number,
            approved: number,
            rejected: number,
            assignedWorker?: string
        }>();

        tasks.forEach(t => {
            const stats = map.get(t.folder) || { count: 0, completed: 0, approved: 0, rejected: 0, assignedWorker: t.assignedWorker };
            stats.count += 1;
            if (t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED) stats.completed += 1;
            if (t.status === TaskStatus.APPROVED) stats.approved += 1;
            if (t.status === TaskStatus.REJECTED) stats.rejected += 1;
            if (t.assignedWorker) stats.assignedWorker = t.assignedWorker;
            map.set(t.folder, stats);
        });

        return Array.from(map.entries()).map(([name, stats]) => ({ name, ...stats })).sort((a, b) => a.name.localeCompare(b.name));
    }, [tasks]);

    const sidebarFolders = useMemo(() => {
        let foldersToShow = folderOverviews;
        if (role === UserRole.WORKER) {
            foldersToShow = folderOverviews.filter(f => f.assignedWorker === username);
        }
        return foldersToShow.map(f => ({ name: f.name, count: f.count, assignedWorker: f.assignedWorker }));
    }, [folderOverviews, role, username]);

    const [selectedFolder, setSelectedFolder] = useState<string>('');
    const [folderMeta, setFolderMeta] = useState<FolderMetadata>({ tags: [], memo: '' });
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [tempMeta, setTempMeta] = useState<FolderMetadata>({ tags: [], memo: '' });
    const [newTagInput, setNewTagInput] = useState('');
    const [isExporting, setIsExporting] = useState(false);

    const [noticeContent, setNoticeContent] = useState('');
    const [isEditingNotice, setIsEditingNotice] = useState(false);
    const [tempNotice, setTempNotice] = useState('');

    useEffect(() => {
        const fetchNotice = async () => {
            try {
                const res = await fetch('/api/label?path=datasets/_notice.txt');
                if (res.ok) {
                    const text = await res.text();
                    setNoticeContent(text);
                    setTempNotice(text);
                }
            } catch (e) {
                console.error("Failed to fetch notice", e);
            }
        };
        fetchNotice();
    }, []);

    const handleSaveNotice = async () => {
        try {
            await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: 'datasets/_notice.txt',
                    content: tempNotice
                })
            });
            setNoticeContent(tempNotice);
            setIsEditingNotice(false);
        } catch (e) {
            alert('Failed to save notice');
        }
    };

    useEffect(() => {
        if (!selectedFolder) {
            if (role === UserRole.REVIEWER) {
                setSelectedFolder(ALL_FOLDERS_VIEW);
            } else if (sidebarFolders.length > 0) {
                setSelectedFolder(sidebarFolders[0].name);
            }
        }
    }, [role, sidebarFolders, selectedFolder]);

    useEffect(() => {
        if (selectedFolder && selectedFolder !== ALL_FOLDERS_VIEW) {
            const meta = Storage.getFolderMetadata(selectedFolder);
            setFolderMeta(meta);
            setTempMeta(meta);
            setIsEditingMeta(false);
        }
    }, [selectedFolder]);

    const handleSaveMeta = () => {
        Storage.saveFolderMetadata(selectedFolder, tempMeta);
        setFolderMeta(tempMeta);
        setIsEditingMeta(false);
    };

    const handleAddTag = () => {
        if (newTagInput.trim() && !tempMeta.tags.includes(newTagInput.trim())) {
            setTempMeta({ ...tempMeta, tags: [...tempMeta.tags, newTagInput.trim()] });
            setNewTagInput('');
        }
    };

    const handleRemoveTag = (tagToRemove: string) => {
        setTempMeta({ ...tempMeta, tags: tempMeta.tags.filter(t => t !== tagToRemove) });
    };

    const handleAssignWorker = (folderName: string, workerName: string) => {
        const worker = workerName === 'Unassigned' ? undefined : workerName;
        Storage.assignFolderToWorker(folderName, worker);
        onRefresh();
    };

    const tasksInFolder = useMemo(() => {
        if (!selectedFolder || selectedFolder === ALL_FOLDERS_VIEW) return [];
        const list = visibleTasks.filter(t => t.folder === selectedFolder);
        if (role === UserRole.REVIEWER) return list;
        return list.sort((a, b) => a.name.localeCompare(b.name));
    }, [visibleTasks, selectedFolder, role]);

    const activeFolderStats = useMemo(() => {
        if (!selectedFolder || selectedFolder === ALL_FOLDERS_VIEW) return null;
        return folderOverviews.find(f => f.name === selectedFolder);
    }, [folderOverviews, selectedFolder]);

    const activeFolderDetails = useMemo(() => {
        if (!selectedFolder || selectedFolder === ALL_FOLDERS_VIEW) return null;
        const allInFolder = tasks.filter(t => t.folder === selectedFolder);
        const modifiedCount = allInFolder.filter(t => t.isModified).length;
        const uniqueClasses = new Set<number>();
        allInFolder.forEach(t => t.annotations.forEach(a => uniqueClasses.add(a.classId)));
        return { modifiedCount, classCount: uniqueClasses.size };
    }, [tasks, selectedFolder]);

    const displayLimit = 50;
    const renderedTasks = tasksInFolder.slice(0, displayLimit);

    const formatTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    const handleExportZip = async () => {
        setIsExporting(true);
        try {
            await Storage.downloadFullDataset();
        } catch (e) {
            console.error(e);
            alert("Export failed");
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="w-full h-full flex flex-col bg-gray-950 p-6 overflow-hidden">

            {/* --- Top Status Card --- */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6 shadow-md flex flex-wrap gap-8 items-center justify-between shrink-0">
                <div className="flex gap-10">
                    <div>
                        <p className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">Total Progress</p>
                        <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-bold text-white">{globalStats.completed}</span>
                            <span className="text-lg text-gray-600 font-medium">/ {globalStats.total}</span>
                        </div>
                    </div>
                    <div className="w-px bg-gray-800 h-10 self-center"></div>
                    <div>
                        <p className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">Total Tasks</p>
                        <p className="text-2xl font-bold text-blue-500">{globalStats.total}</p>
                    </div>
                    <div className="w-px bg-gray-800 h-10 self-center"></div>
                    <div>
                        <p className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">Today's Time</p>
                        <p className="text-2xl font-bold text-emerald-500">{formatTime(globalStats.totalTime)}</p>
                    </div>
                </div>

                {accountType === AccountType.ADMIN && (
                    <button
                        onClick={handleExportZip}
                        disabled={isExporting}
                        className="bg-blue-600 hover:bg-blue-500 text-white border border-blue-500 px-5 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all shadow-lg active:scale-[0.98]"
                    >
                        {isExporting ? (
                            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                        ) : (
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        )}
                        {isExporting ? 'Zipping...' : 'Download Dataset (.zip)'}
                    </button>
                )}
            </div>

            {/* --- Main Workspace --- */}
            <div className="flex-1 flex gap-6 overflow-hidden">

                {/* Left Sidebar: Folder List */}
                <div className="w-[340px] flex-shrink-0 flex flex-col bg-gray-900 border border-gray-800 rounded-xl shadow-md overflow-hidden">
                    <div className="p-4 border-b border-gray-800 bg-gray-800/30">
                        <h3 className="font-bold text-gray-300 text-sm uppercase tracking-wide">Folders</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 space-y-1">
                        {role === UserRole.REVIEWER && (
                            <button
                                onClick={() => setSelectedFolder(ALL_FOLDERS_VIEW)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mb-3 ${selectedFolder === ALL_FOLDERS_VIEW
                                    ? 'bg-purple-900/30 text-purple-200 border border-purple-700/50 shadow-sm'
                                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                                    }`}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                                Overview Dashboard
                            </button>
                        )}

                        {sidebarFolders.length === 0 ? (
                            <div className="py-8 text-center">
                                <p className="text-gray-500 text-sm">No folders found.</p>
                                {role === UserRole.WORKER && <p className="text-gray-600 text-xs mt-1">Wait for assignment.</p>}
                            </div>
                        ) : (
                            sidebarFolders.map(folder => (
                                <button
                                    key={folder.name}
                                    onClick={() => setSelectedFolder(folder.name)}
                                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all group ${selectedFolder === folder.name
                                        ? 'bg-blue-900/20 text-blue-300 border border-blue-800/50 shadow-sm'
                                        : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200 border border-transparent'
                                        }`}
                                >
                                    <span className="flex items-center gap-3 truncate">
                                        <svg className={`w-4 h-4 ${selectedFolder === folder.name ? 'text-blue-500' : 'text-gray-600 group-hover:text-gray-400'}`} fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>
                                        <span className="truncate">{folder.name}</span>
                                    </span>
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${selectedFolder === folder.name ? 'bg-blue-900 text-blue-200' : 'bg-gray-800 text-gray-500'}`}>
                                        {folder.count}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>

                {/* Center Content: Task List */}
                <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl shadow-md overflow-hidden flex flex-col relative min-w-0">

                    {/* --- ADMIN OVERVIEW MODE --- */}
                    {selectedFolder === ALL_FOLDERS_VIEW && role === UserRole.REVIEWER ? (
                        <div className="flex flex-col h-full">
                            <div className="px-6 py-4 border-b border-gray-800 bg-gray-800/30 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-lg font-bold text-white">프로젝트 할당 및 현황</h2>
                                    <span className="text-xs bg-purple-900/40 text-purple-300 px-2 py-0.5 rounded border border-purple-800/50">관리자용</span>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-6">
                                <table className="w-full text-left border-collapse">
                                    <thead>
                                        <tr className="text-gray-500 text-xs font-bold uppercase tracking-wider border-b border-gray-800">
                                            <th className="pb-3 pl-2">폴더명</th>
                                            <th className="pb-3">진행률</th>
                                            <th className="pb-3 text-center">통계</th>
                                            <th className="pb-3 w-64">담당 작업자</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-800 text-sm">
                                        {folderOverviews.map(folder => {
                                            const percent = Math.round((folder.completed / folder.count) * 100) || 0;
                                            return (
                                                <tr key={folder.name} className="group hover:bg-gray-800/40 transition-colors">
                                                    <td className="py-4 pl-2">
                                                        <div className="font-medium text-gray-200">{folder.name}</div>
                                                        <div className="text-xs text-gray-500 mt-0.5">{folder.count} tasks</div>
                                                    </td>
                                                    <td className="py-4 pr-6 align-middle">
                                                        <div className="w-full max-w-xs">
                                                            <div className="flex justify-between text-xs mb-1.5">
                                                                <span className="text-gray-400 font-medium">검수 현황</span>
                                                                <span className="text-gray-500">{folder.approved} / {folder.completed - folder.approved}</span>
                                                            </div>
                                                            <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                                                                <div className="bg-purple-500 h-full" style={{ width: `${folder.completed > 0 ? (folder.approved / folder.completed) * 100 : 0}%` }}></div>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="py-4 text-center">
                                                        <div className="flex items-center justify-center gap-3 text-xs">
                                                            <div title="Approved" className="text-green-400 font-medium bg-green-900/20 px-1.5 py-0.5 rounded border border-green-900/50">{folder.approved}</div>
                                                            <div title="Rejected" className="text-red-400 font-medium bg-red-900/20 px-1.5 py-0.5 rounded border border-red-900/50">{folder.rejected}</div>
                                                        </div>
                                                    </td>
                                                    <td className="py-4">
                                                        <div className="relative">
                                                            <select
                                                                className={`w-full appearance-none px-3 py-2 rounded-lg text-sm border focus:ring-1 focus:ring-blue-500 outline-none transition-colors cursor-pointer
                                                            ${folder.assignedWorker
                                                                        ? 'bg-blue-900/10 border-blue-800 text-blue-300'
                                                                        : 'bg-gray-800 border-gray-700 text-gray-400'
                                                                    }
                                                        `}
                                                                value={folder.assignedWorker || 'Unassigned'}
                                                                onChange={(e) => handleAssignWorker(folder.name, e.target.value)}
                                                            >
                                                                <option value="Unassigned">Unassigned</option>
                                                                {AVAILABLE_WORKERS.map(w => (
                                                                    <option key={w} value={w}>{w}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ) : (
                        // --- FOLDER DETAIL MODE ---
                        selectedFolder ? (
                            <>
                                {/* Header */}
                                <div className="px-6 py-4 border-b border-gray-800 bg-gray-800/30 flex justify-between items-center flex-shrink-0">
                                    <div>
                                        <div className="flex items-center gap-3">
                                            <h2 className="text-lg font-bold text-white tracking-tight">{selectedFolder}</h2>
                                            {activeFolderStats?.assignedWorker && (
                                                <span className="text-[10px] font-bold text-blue-300 bg-blue-900/30 px-2 py-0.5 rounded-full border border-blue-800/50 uppercase tracking-wide">
                                                    {activeFolderStats.assignedWorker}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Guidelines Panel */}
                                <div className={`px-6 py-5 border-b border-gray-800 transition-colors ${role === UserRole.WORKER ? 'bg-blue-900/5' : ''}`}>
                                    <div className="flex items-center justify-between mb-3">
                                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Guidelines</h3>
                                        {role === UserRole.REVIEWER && (
                                            <button
                                                onClick={() => setIsEditingMeta(!isEditingMeta)}
                                                className="text-xs text-blue-400 hover:text-blue-300 font-medium"
                                            >
                                                {isEditingMeta ? 'Cancel' : 'Edit'}
                                            </button>
                                        )}
                                    </div>

                                    {isEditingMeta ? (
                                        <div className="bg-gray-800 p-4 rounded-xl border border-gray-700 space-y-3">
                                            <div>
                                                <input
                                                    type="text"
                                                    value={newTagInput}
                                                    onChange={(e) => setNewTagInput(e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                                                    placeholder="Add tags..."
                                                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none mb-2"
                                                />
                                                <div className="flex flex-wrap gap-2">
                                                    {tempMeta.tags.map(tag => (
                                                        <span key={tag} className="px-2 py-1 bg-blue-600 text-white text-xs rounded-md flex items-center gap-1">
                                                            {tag}
                                                            <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-200">×</button>
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                            <textarea
                                                value={tempMeta.memo}
                                                onChange={(e) => setTempMeta({ ...tempMeta, memo: e.target.value })}
                                                className="w-full h-20 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 outline-none resize-none"
                                                placeholder="Instructions..."
                                            />
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => {
                                                        const folderTasks = tasks.filter(t => t.folder === selectedFolder);
                                                        // Sort by name A-Z to find the "first" TODO
                                                        folderTasks.sort((a, b) => a.name.localeCompare(b.name));

                                                        const firstTodo = folderTasks.find(t => t.status === TaskStatus.TODO);
                                                        if (firstTodo) {
                                                            onSelectTask(firstTodo.id);
                                                        } else {
                                                            alert("No pending tasks found in this folder!");
                                                        }
                                                    }}
                                                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-blue-900/20"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                    작업 이어하기
                                                </button>
                                                <button
                                                    onClick={() => handleAssignWorker(selectedFolder, username)}
                                                    className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                                                >
                                                    Assign to Me
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        const newOwner = prompt('Enter username to assign folder to:');
                                                        if (newOwner) handleAssignWorker(selectedFolder, newOwner);
                                                    }}
                                                    className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                                                >
                                                    Assign...
                                                </button>
                                            </div>
                                            <div className="flex justify-end">
                                                <button
                                                    onClick={handleSaveMeta}
                                                    className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold"
                                                >
                                                    Save
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {folderMeta.tags.length > 0 && (
                                                <div className="flex flex-wrap gap-2">
                                                    {folderMeta.tags.map(tag => (
                                                        <span key={tag} className="px-2 py-0.5 bg-blue-500/10 text-blue-300 border border-blue-500/20 text-xs font-medium rounded-full">
                                                            #{tag}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                            <p className="text-sm text-gray-400 leading-relaxed whitespace-pre-wrap">
                                                {folderMeta.memo || <span className="italic text-gray-600">No specific guidelines.</span>}
                                            </p>
                                        </div>
                                    )}
                                </div>

                                {/* Action Buttons */}
                                <div className="px-6 pt-4 pb-4 flex gap-2">
                                    <button
                                        onClick={() => {
                                            const folderTasks = tasks.filter(t => t.folder === selectedFolder);
                                            // Sort by name A-Z to find the "first" pending
                                            folderTasks.sort((a, b) => a.name.localeCompare(b.name));

                                            const firstPending = folderTasks.find(t =>
                                                t.status === TaskStatus.TODO ||
                                                t.status === TaskStatus.IN_PROGRESS ||
                                                t.status === TaskStatus.REJECTED
                                            );

                                            if (firstPending) {
                                                onSelectTask(firstPending.id);
                                            } else {
                                                alert("No pending tasks (TODO, IN_PROGRESS, REJECTED) found in this folder!");
                                            }
                                        }}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-blue-900/20"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                        작업 이어하기
                                    </button>

                                    {role === UserRole.REVIEWER && (
                                        <button
                                            onClick={() => {
                                                const folderTasks = tasks.filter(t => t.folder === selectedFolder);
                                                folderTasks.sort((a, b) => a.name.localeCompare(b.name));

                                                const firstPending = folderTasks.find(t =>
                                                    t.status !== TaskStatus.APPROVED &&
                                                    t.status !== TaskStatus.REJECTED
                                                );

                                                if (firstPending) {
                                                    onSelectTask(firstPending.id);
                                                } else {
                                                    alert("No pending review tasks found in this folder!");
                                                }
                                            }}
                                            className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-purple-900/20"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            Pending Review
                                        </button>
                                    )}
                                </div>

                                {/* Stats Row */}
                                {activeFolderStats && activeFolderDetails && (
                                    <div className="p-6 border-b border-gray-800 grid grid-cols-4 gap-4">
                                        {role === UserRole.REVIEWER ? (
                                            <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-800">
                                                <span className="text-xs text-gray-400 font-bold uppercase tracking-wider">검수 현황</span>
                                                <div className="flex items-baseline gap-1 mt-1">
                                                    <span className="text-xl font-bold text-white">{activeFolderStats.approved}</span>
                                                    <span className="text-xs text-gray-500">/ {activeFolderStats.completed - activeFolderStats.approved}</span>
                                                </div>
                                                <div className="text-[10px] text-gray-500 mt-0.5 font-medium">완료 / 대기</div>
                                                <div className="w-full bg-gray-700 h-1 mt-2 rounded-full overflow-hidden">
                                                    <div className="bg-purple-500 h-full" style={{ width: `${activeFolderStats.completed > 0 ? (activeFolderStats.approved / activeFolderStats.completed) * 100 : 0}%` }}></div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-800">
                                                <span className="text-xs text-gray-500 font-bold uppercase">태스크</span>
                                                <div className="flex items-baseline gap-1 mt-1">
                                                    <span className="text-xl font-bold text-white">{activeFolderStats.completed}</span>
                                                    <span className="text-xs text-gray-500">/ {activeFolderStats.count}</span>
                                                </div>
                                                <div className="w-full bg-gray-700 h-1 mt-2 rounded-full overflow-hidden">
                                                    <div className="bg-blue-500 h-full" style={{ width: `${(activeFolderStats.completed / activeFolderStats.count) * 100}%` }}></div>
                                                </div>
                                            </div>
                                        )}
                                        <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-800">
                                            <span className="text-xs text-gray-500 font-bold uppercase">완료</span>
                                            <div className="mt-1 text-xl font-bold text-green-400">{activeFolderStats.approved}</div>
                                        </div>
                                        <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-800">
                                            <span className="text-xs text-gray-500 font-bold uppercase">반려</span>
                                            <div className="mt-1 text-xl font-bold text-red-400">{activeFolderStats.rejected}</div>
                                        </div>
                                        <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-800">
                                            <span className="text-xs text-gray-500 font-bold uppercase">수정된 이미지</span>
                                            <div className="mt-1 text-xl font-bold text-purple-400">{activeFolderDetails.modifiedCount}</div>
                                        </div>
                                    </div>
                                )}

                                {/* Task Grid */}
                                <div className="flex-1 overflow-y-auto p-6 bg-gray-900/50">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                                            Task List {tasksInFolder.length > displayLimit && `(Showing ${displayLimit})`}
                                        </h3>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3">
                                        {renderedTasks.length === 0 ? (
                                            <div className="h-40 flex items-center justify-center text-gray-500 text-sm italic border border-dashed border-gray-800 rounded-xl">
                                                No pending tasks.
                                            </div>
                                        ) : (
                                            renderedTasks.map(task => (
                                                <div key={task.id} className="group bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between hover:border-gray-600 transition-all shadow-sm">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-14 h-14 bg-black rounded-lg overflow-hidden flex-shrink-0 relative border border-gray-800 group-hover:border-gray-600 transition-colors">
                                                            <img src={task.imageUrl} alt="" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                                                            {task.annotations.length > 0 && (
                                                                <div className="absolute bottom-0 right-0 bg-black/80 text-[10px] font-bold text-white px-1.5 py-0.5 rounded-tl">
                                                                    {task.annotations.length}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div>
                                                            <h3 className="text-gray-200 font-bold text-sm group-hover:text-blue-400 transition-colors">{task.name}</h3>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-bold
                                                        ${task.status === TaskStatus.TODO ? 'bg-gray-800 text-gray-400' : ''}
                                                        ${task.status === TaskStatus.IN_PROGRESS ? 'bg-blue-900/30 text-blue-300 border border-blue-800/50' : ''}
                                                        ${task.status === TaskStatus.SUBMITTED ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-800/50' : ''}
                                                        ${task.status === TaskStatus.APPROVED ? 'bg-green-900/30 text-green-300 border border-green-800/50' : ''}
                                                        ${task.status === TaskStatus.REJECTED ? 'bg-red-900/30 text-red-300 border border-red-800/50' : ''}
                                                    `}>
                                                                    {TaskStatusLabels[task.status]}
                                                                </span>
                                                                <span className="text-xs text-gray-600">Updated {new Date(task.lastUpdated).toLocaleDateString()}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <button
                                                        onClick={() => onSelectTask(task.id)}
                                                        className="opacity-0 group-hover:opacity-100 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-all shadow-md transform translate-x-2 group-hover:translate-x-0"
                                                    >
                                                        {role === UserRole.WORKER
                                                            ? (task.status === TaskStatus.REJECTED ? 'Fix' : 'Start')
                                                            : 'Review'}
                                                    </button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
                                <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mb-4 text-gray-600">
                                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                                </div>
                                <p>Select a folder to view details.</p>
                            </div>
                        )
                    )}
                </div>

                {/* Right Panel: Notice Board */}
                <div className="w-[800px] flex-shrink-0 flex flex-col bg-gray-900 border border-gray-800 rounded-xl shadow-md overflow-hidden">
                    <div className="p-4 border-b border-gray-800 bg-gray-800/30 flex items-center justify-between">
                        <h3 className="font-bold text-red-400 text-sm uppercase tracking-wide">Notice</h3>
                        {accountType === AccountType.ADMIN && (
                            <button
                                onClick={() => setIsEditingNotice(!isEditingNotice)}
                                className="text-xs text-blue-400 hover:text-blue-300"
                            >
                                {isEditingNotice ? 'Cancel' : 'Edit'}
                            </button>
                        )}
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto">
                        {isEditingNotice ? (
                            <div className="flex flex-col gap-2 h-full">
                                <textarea
                                    className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-gray-200 outline-none focus:border-blue-500 resize-none"
                                    value={tempNotice}
                                    onChange={(e) => setTempNotice(e.target.value)}
                                    placeholder="Write a notice..."
                                />
                                <button
                                    onClick={handleSaveNotice}
                                    className="w-full bg-blue-600 text-white font-bold py-2 rounded-lg hover:bg-blue-500"
                                >
                                    Save Notice
                                </button>
                            </div>
                        ) : (
                            <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                                {noticeContent || <span className="text-gray-500 italic">No notices posted.</span>}
                            </div>
                        )}
                    </div>
                </div>

            </div>
        </div >
    );
};

export default Dashboard;
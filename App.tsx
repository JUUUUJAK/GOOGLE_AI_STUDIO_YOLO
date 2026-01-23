import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { UserRole, Task, TaskStatus, YoloClass, User, AccountType } from './types';
import { COLOR_PALETTE } from './constants';
import * as Storage from './services/storage';
import Dashboard from './components/Dashboard';
import AnnotationCanvas from './components/AnnotationCanvas';
import History from './components/History';
import Login from './components/Login';

type View = 'DASHBOARD' | 'HISTORY';

const App: React.FC = () => {
    // Authentication State
    const [user, setUser] = useState<User | null>(null);

    // App State
    const [currentUserRole, setCurrentUserRole] = useState<UserRole>(UserRole.WORKER);
    const [currentView, setCurrentView] = useState<View>('DASHBOARD');
    const [currentTask, setCurrentTask] = useState<Task | null>(null);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [startTime, setStartTime] = useState<number>(0);

    // Label Management State
    const [selectedLabelFile, setSelectedLabelFile] = useState<string>('');
    const [availableLabelFiles, setAvailableLabelFiles] = useState<string[]>([]);
    const [currentClasses, setCurrentClasses] = useState<YoloClass[]>([]);
    const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);

    // Load tasks on mount
    useEffect(() => {
        const init = async () => {
            await Storage.initStorage();
            refreshTasks();

            // Load Label Files
            try {
                const res = await fetch('/api/label-files');
                if (res.ok) {
                    const files = await res.json();
                    setAvailableLabelFiles(files);
                    if (files.length > 0) {
                        const defaultFile = files.includes('labels_default.txt') ? 'labels_default.txt' : files[0];
                        setSelectedLabelFile(defaultFile);
                    }
                }
            } catch (e) {
                console.error("Failed to load label files", e);
            }
        };
        init();
    }, []);

    // Parse Classes when file selection changes
    useEffect(() => {
        if (!selectedLabelFile) return;

        const fetchLabels = async () => {
            try {
                const res = await fetch(`/api/label?path=labels/${selectedLabelFile}`);
                if (res.ok) {
                    const content = await res.text();
                    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    const parsedClasses: YoloClass[] = lines.map((name, index) => ({
                        id: index,
                        name: name,
                        color: COLOR_PALETTE[index % COLOR_PALETTE.length]
                    }));
                    setCurrentClasses(parsedClasses);

                    // Reset selected class to first one if valid
                    if (parsedClasses.length > 0) {
                        setSelectedClass(parsedClasses[0]);
                    } else {
                        setSelectedClass(null);
                    }
                }
            } catch (e) {
                console.error("Failed to load label content", e);
            }
        }
        fetchLabels();
    }, [selectedLabelFile]);

    const handleLogin = (authenticatedUser: User) => {
        setUser(authenticatedUser);
        // Set default view based on account type
        if (authenticatedUser.accountType === AccountType.ADMIN) {
            setCurrentUserRole(UserRole.REVIEWER);
        } else {
            setCurrentUserRole(UserRole.WORKER);
        }
    };

    const handleLogout = () => {
        setUser(null);
        setCurrentTask(null);
        setCurrentUserRole(UserRole.WORKER);
        setCurrentView('DASHBOARD');
    };

    const refreshTasks = () => {
        setTasks(Storage.getTasks());
    };

    const handleTaskSelect = useCallback(async (taskId: string) => {
        if (!user) return;
        const task = await Storage.getTaskById(taskId);
        if (task) {
            setCurrentTask(task);
            setStartTime(Date.now());
            if (currentUserRole === UserRole.WORKER && task.status === TaskStatus.TODO) {
                await Storage.updateTask(taskId, { status: TaskStatus.IN_PROGRESS }, user.username, currentUserRole);
                Storage.logAction(taskId, user.username, currentUserRole, 'START');
                refreshTasks();
            }
        }
    }, [currentUserRole, user]);

    const handleCloseTask = useCallback(() => {
        if (currentTask && startTime > 0 && user) {
            const duration = (Date.now() - startTime) / 1000;
            Storage.logAction(currentTask.id, user.username, currentUserRole, 'SAVE', duration);
        }
        setCurrentTask(null);
        setStartTime(0);
        refreshTasks();
    }, [currentTask, startTime, currentUserRole, user]);

    const handleUpdateAnnotations = async (newAnnotations: any[]) => {
        if (!currentTask || !user) return;
        const updated = await Storage.updateTask(currentTask.id, { annotations: newAnnotations, isModified: true }, user.username, currentUserRole);
        setCurrentTask(updated);
    };

    // Shared Logic for finding the next task based on criteria
    const findNextTask = (
        allTasks: Task[],
        currentId: string,
        currentFolder: string,
        direction: 'NEXT' | 'PREV',
        validStatuses: TaskStatus[]
    ): Task | null => {
        const folderTasks = allTasks.filter(t => t.folder === currentFolder);
        // Sort A-Z
        folderTasks.sort((a, b) => a.name.localeCompare(b.name));

        const currentIndex = folderTasks.findIndex(t => t.id === currentId);
        let targetTask = null;

        if (direction === 'NEXT') {
            if (currentIndex !== -1 && currentIndex < folderTasks.length - 1) {
                targetTask = folderTasks[currentIndex + 1];
            }
            if (!targetTask || !validStatuses.includes(targetTask.status)) {
                const forwardSearch = folderTasks.slice(currentIndex + 1).find(t => validStatuses.includes(t.status));
                if (forwardSearch) {
                    targetTask = forwardSearch;
                }
                // Removed wrapping logic: Do not go back to start if end is reached.
            }
        } else {
            if (currentIndex > 0) {
                targetTask = folderTasks[currentIndex - 1];
            }
        }
        return targetTask;
    };

    const navigateTask = useCallback((direction: 'NEXT' | 'PREV', validStatuses: TaskStatus[]) => {
        if (!currentTask) return;
        const allTasks = Storage.getTasks();
        const targetTask = findNextTask(allTasks, currentTask.id, currentTask.folder, direction, validStatuses);

        if (targetTask) {
            handleTaskSelect(targetTask.id);
        } else {
            if (direction === 'NEXT') {
                // alert("End of folder.");
            } else {
                alert("Start of folder.");
            }
        }
    }, [currentTask, handleTaskSelect]);

    const handleSubmit = useCallback(async (direction: 'NEXT' | 'PREV' = 'NEXT') => {
        if (!currentTask || !user) return;

        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTask(currentTask.id, { status: TaskStatus.SUBMITTED }, user.username, currentUserRole);
        Storage.logAction(currentTask.id, user.username, currentUserRole, 'SUBMIT', duration);

        const allTasks = Storage.getTasks();
        setTasks(allTasks);

        const validStatuses = [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.REJECTED];
        const targetTask = findNextTask(allTasks, currentTask.id, currentTask.folder, direction, validStatuses);

        if (targetTask) {
            handleTaskSelect(targetTask.id);
        } else {
            if (direction === 'NEXT') {
                alert("All tasks in this folder are completed!");
            } else {
                alert("This is the first task in the folder.");
            }
        }
    }, [currentTask, startTime, currentUserRole, handleTaskSelect, handleCloseTask, user]);

    const handleReview = useCallback(async (approved: boolean, direction: 'NEXT' | 'PREV' | null = null) => {
        if (!currentTask || !user) return;
        const newStatus = approved ? TaskStatus.APPROVED : TaskStatus.REJECTED;

        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTask(currentTask.id, { status: newStatus }, user.username, currentUserRole);
        Storage.logAction(currentTask.id, user.username, currentUserRole, approved ? 'APPROVE' : 'REJECT', duration);

        const allTasks = Storage.getTasks();
        setTasks(allTasks);

        if (!direction) {
            alert(approved ? "Task Approved" : "Task Rejected");
            return;
        }

        const validStatuses = [TaskStatus.SUBMITTED];
        const targetTask = findNextTask(allTasks, currentTask.id, currentTask.folder, direction, validStatuses);

        if (targetTask) {
            handleTaskSelect(targetTask.id);
        } else {
            if (direction === 'NEXT') {
                alert("All submitted tasks in this folder are reviewed!");
            } else {
                alert("Start of folder.");
            }
        }
    }, [currentTask, startTime, currentUserRole, handleTaskSelect, handleCloseTask, user]);

    // Keyboard Shortcuts for Main App
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!currentTask) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            const key = e.key.toLowerCase();

            // 1-9 Class Select
            if (key >= '1' && key <= '9') {
                const idx = parseInt(key) - 1;
                if (idx < currentClasses.length) setSelectedClass(currentClasses[idx]);
            }

            if (currentUserRole === UserRole.WORKER) {
                // a - Previous
                if (key === 'a') handleSubmit('PREV');
                // d - Next
                if (key === 'd') handleSubmit('NEXT');
            } else {
                // Reviewer Shortcuts

                // A: Prev
                if (key === 'a') {
                    // If already reviewed, just move PREV
                    if (currentTask.status === TaskStatus.APPROVED || currentTask.status === TaskStatus.REJECTED) {
                        navigateTask('PREV', [TaskStatus.SUBMITTED, TaskStatus.APPROVED, TaskStatus.REJECTED]);
                    } else {
                        handleReview(true, 'PREV');
                    }
                }

                // D: Next
                if (key === 'd') {
                    // If already reviewed, just move NEXT
                    if (currentTask.status === TaskStatus.APPROVED || currentTask.status === TaskStatus.REJECTED) {
                        navigateTask('NEXT', [TaskStatus.SUBMITTED, TaskStatus.APPROVED, TaskStatus.REJECTED]);
                    } else {
                        handleReview(true, 'NEXT');
                    }
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentTask, handleSubmit, handleReview, currentUserRole, currentClasses, navigateTask]);

    const currentFolderStats = useMemo(() => {
        if (!currentTask) return { completed: 0, total: 0 };
        const folderTasks = tasks.filter(t => t.folder === currentTask.folder);
        const completed = folderTasks.filter(t => t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED).length;
        return { completed, total: folderTasks.length };
    }, [currentTask, tasks]);

    if (!user) {
        return <Login onLogin={handleLogin} />;
    }

    return (
        <div className="h-screen bg-gray-950 text-gray-100 flex flex-col font-sans overflow-hidden">
            {/* Navbar */}
            <nav className="border-b border-gray-800 bg-gray-900 z-50 shadow-sm flex-shrink-0">
                <div className="w-full max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-xl shadow-lg">Y7</div>
                        <h1 className="font-bold text-xl tracking-tight">YOLOv7 Data Studio</h1>

                        {/* Main Navigation Tabs */}
                        <div className="ml-8 flex space-x-2">
                            <button
                                onClick={() => setCurrentView('DASHBOARD')}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${currentView === 'DASHBOARD' ? 'bg-gray-800 text-white shadow-inner' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'}`}
                            >
                                Dashboard
                            </button>
                            {/* Show History only for Admin */}
                            {user.accountType === AccountType.ADMIN && (
                                <button
                                    onClick={() => setCurrentView('HISTORY')}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${currentView === 'HISTORY' ? 'bg-gray-800 text-white shadow-inner' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'}`}
                                >
                                    History
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        {!currentTask && user.accountType === AccountType.ADMIN && (
                            <div className="flex bg-gray-800 rounded-lg p-1">
                                <button
                                    onClick={() => setCurrentUserRole(UserRole.WORKER)}
                                    className={`px-5 py-1.5 rounded-md text-sm font-medium transition-all ${currentUserRole === UserRole.WORKER ? 'bg-gray-700 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}
                                >
                                    Worker View
                                </button>
                                <button
                                    onClick={() => setCurrentUserRole(UserRole.REVIEWER)}
                                    className={`px-5 py-1.5 rounded-md text-sm font-medium transition-all ${currentUserRole === UserRole.REVIEWER ? 'bg-purple-900 text-white shadow' : 'text-gray-400 hover:text-gray-200'}`}
                                >
                                    Reviewer View
                                </button>
                            </div>
                        )}

                        <div className="flex items-center gap-4 border-l border-gray-800 pl-6">
                            <div className="text-right">
                                <p className="text-sm font-bold text-white leading-none">{user.username}</p>
                                <p className="text-[10px] text-gray-500 mt-1 uppercase tracking-wider">{user.accountType}</p>
                            </div>
                            <button
                                onClick={handleLogout}
                                className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
                                title="Logout"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </nav>

            <main className="flex-1 relative flex overflow-hidden">
                {currentView === 'HISTORY' && !currentTask && user.accountType === AccountType.ADMIN ? (
                    <History currentUser={user.username} accountType={user.accountType} />
                ) : (
                    <>
                        {!currentTask ? (
                            <Dashboard
                                role={currentUserRole}
                                accountType={user.accountType}
                                tasks={tasks}
                                onSelectTask={handleTaskSelect}
                                onRefresh={refreshTasks}
                                username={user.username}
                            />
                        ) : (
                            <div className="flex w-full h-full">
                                {/* Sidebar (Tools) */}
                                <aside className="w-80 bg-gray-900 border-r border-gray-800 flex flex-col z-20 shadow-2xl">
                                    <div className="p-6 border-b border-gray-800">
                                        <button
                                            onClick={handleCloseTask}
                                            className="text-gray-400 hover:text-white flex items-center gap-2 text-sm font-medium mb-4 transition-colors"
                                        >
                                            ← Back to Dashboard
                                        </button>
                                        <h2 className="font-bold text-lg text-white truncate" title={currentTask.name}>{currentTask.name}</h2>
                                        <div className="flex items-center gap-3 mt-3">
                                            <span className="text-xs font-bold text-gray-400 bg-gray-800 px-2.5 py-1 rounded border border-gray-700">
                                                {currentTask.status}
                                            </span>
                                            <span className="text-xs text-gray-500 border-l border-gray-700 pl-3">
                                                {currentTask.folder}
                                            </span>
                                        </div>

                                        <div className="mt-6 bg-gray-800/50 p-3 rounded-lg border border-gray-700/50">
                                            <div className="flex justify-between text-xs text-gray-400 mb-2 font-medium">
                                                <span>Folder Progress</span>
                                                <span>{currentFolderStats.completed} / {currentFolderStats.total}</span>
                                            </div>
                                            <div className="w-full bg-gray-700 h-2 rounded-full overflow-hidden">
                                                <div
                                                    className="bg-blue-500 h-full transition-all duration-300"
                                                    style={{ width: `${(currentFolderStats.completed / Math.max(currentFolderStats.total, 1)) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Label Set Selector */}
                                    <div className="p-6 bg-gray-800/30 border-b border-gray-800">
                                        <label className="text-xs text-gray-500 font-bold uppercase tracking-wider block mb-2">Label Set</label>
                                        <select
                                            value={selectedLabelFile}
                                            onChange={(e) => setSelectedLabelFile(e.target.value)}
                                            className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none shadow-sm"
                                        >
                                            {availableLabelFiles.map(fileName => (
                                                <option key={fileName} value={fileName}>{fileName}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex-1 overflow-y-auto p-4 space-y-0.5">
                                        <h3 className="px-2 text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Classes (1-9)</h3>
                                        {currentClasses.map((cls, idx) => (
                                            <button
                                                key={cls.id}
                                                onClick={() => setSelectedClass(cls)}
                                                className={`w-full flex items-center gap-3 px-3 py-1.5 rounded-md border transition-all ${selectedClass?.id === cls.id
                                                    ? 'bg-gray-800 border-gray-600 shadow-md'
                                                    : 'border-transparent hover:bg-gray-800/50'
                                                    }`}
                                            >
                                                <span className="w-3 h-3 rounded-full flex-shrink-0 shadow-sm" style={{ backgroundColor: cls.color }}></span>
                                                <span className="text-sm font-medium text-gray-200 truncate">{cls.name}</span>
                                                <span className="ml-auto text-xs text-gray-600 font-mono">
                                                    {idx + 1}
                                                </span>
                                            </button>
                                        ))}
                                    </div>

                                    <div className="p-6 border-t border-gray-800 space-y-3 bg-gray-900">
                                        {currentUserRole === UserRole.WORKER ? (
                                            <div className="flex gap-3">
                                                <button
                                                    onClick={() => handleSubmit('PREV')}
                                                    className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg shadow-sm border border-gray-700 transition-all text-sm flex items-center justify-center gap-2"
                                                    title="Submit & Prev (A)"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                                    Prev
                                                </button>
                                                <button
                                                    onClick={() => handleSubmit('NEXT')}
                                                    className="flex-[1.5] py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg shadow-lg transition-transform active:scale-[0.98] text-sm flex items-center justify-center gap-2"
                                                    title="Submit & Next (D)"
                                                >
                                                    <span>Submit & Next</span>
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="space-y-3">
                                                <button
                                                    onClick={() => handleReview(false)}
                                                    className="w-full py-3 bg-red-900/50 hover:bg-red-900 border border-red-800 text-red-100 font-bold rounded-lg transition-colors text-sm"
                                                >
                                                    Reject Task
                                                </button>
                                                <div className="flex gap-3">
                                                    <button
                                                        onClick={() => handleReview(true, 'PREV')}
                                                        className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg shadow-sm border border-gray-700 transition-all text-sm flex items-center justify-center gap-2"
                                                        title="Approve & Prev (A)"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                                        Prev
                                                    </button>
                                                    <button
                                                        onClick={() => handleReview(true, 'NEXT')}
                                                        className="flex-[1.5] py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg shadow transition-colors text-sm flex items-center justify-center gap-2"
                                                        title="Approve & Next (D)"
                                                    >
                                                        <span>Approve & Next</span>
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </aside>

                                {/* Canvas Area with Separate Status Bars */}
                                <div className="flex-1 flex flex-col bg-gray-950 relative overflow-hidden">
                                    {/* Top Bar: Current Status & Class */}
                                    <div className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6 z-30 shadow-md flex-shrink-0">
                                        <div className="flex items-center gap-4">
                                            <span className="text-gray-400 text-sm font-medium">Active Class:</span>
                                            <div className="flex items-center gap-2 bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-700">
                                                <span className="w-4 h-4 rounded-full" style={{ backgroundColor: selectedClass?.color || '#fff' }}></span>
                                                <span className="text-white font-bold text-base">{selectedClass?.name || 'None'}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={`w-2.5 h-2.5 rounded-full ${currentUserRole === UserRole.WORKER ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`}></span>
                                            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
                                                {currentUserRole === UserRole.WORKER ? "Edit Mode" : "View Mode"}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Main Canvas Area */}
                                    <div className="flex-1 relative overflow-hidden bg-black">
                                        <AnnotationCanvas
                                            imageUrl={currentTask.imageUrl}
                                            annotations={currentTask.annotations}
                                            currentClass={selectedClass || { id: -1, name: 'None', color: '#000' }}
                                            classes={currentClasses}
                                            readOnly={false}
                                            onUpdateAnnotations={handleUpdateAnnotations}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </main>
        </div>
    );
};

export default App;
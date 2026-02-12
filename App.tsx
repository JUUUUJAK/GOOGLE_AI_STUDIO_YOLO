import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { UserRole, Task, TaskStatus, TaskStatusLabels, YoloClass, User, AccountType, TaskIssueReasonCode, TaskIssueType } from './types';
import { COLOR_PALETTE } from './constants';
import * as Storage from './services/storage';
import Dashboard from './components/Dashboard';
import AnnotationCanvas from './components/AnnotationCanvas';
import History from './components/History';
import Login from './components/Login';
import { GuideViewer } from './components/GuideViewer';

const LoadingOverlay: React.FC<{ message: string }> = ({ message }) => (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-6 max-w-sm w-full mx-4">
            <div className="relative">
                <div className="w-16 h-16 border-4 border-slate-800 border-t-blue-500 rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center text-blue-500">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                </div>
            </div>
            <div className="text-center">
                <h3 className="text-xl font-bold text-white mb-2">{message}</h3>
                <p className="text-slate-400 text-sm">Please wait while we sync with the server...</p>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div className="bg-blue-600 h-full w-1/2 animate-[loading-bar_2s_infinite_ease-in-out]"></div>
            </div>
        </div>
        <style>{`
            @keyframes loading-bar {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(200%); }
            }
        `}</style>
    </div>
);

type View = 'DASHBOARD' | 'HISTORY';

const ISSUE_REASON_OPTIONS: Array<{ value: TaskIssueReasonCode; label: string }> = [
    { value: 'BLUR', label: '흐림' },
    { value: 'DUPLICATE', label: '가려짐' },
    { value: 'WRONG_CLASS', label: '확인불가' },
    { value: 'CORRUPT', label: '이미지불량' },
    { value: 'OTHER', label: '기타' }
];

const App: React.FC = () => {
    // Authentication State
    const [user, setUser] = useState<User | null>(null);

    // App State
    const [currentUserRole, setCurrentUserRole] = useState<UserRole>(UserRole.WORKER);
    const [currentView, setCurrentView] = useState<View>('DASHBOARD');
    const [currentTask, setCurrentTask] = useState<Task | null>(null);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [startTime, setStartTime] = useState<number>(0);
    const [isDataLoading, setIsDataLoading] = useState<boolean>(false);
    const [jumpIndex, setJumpIndex] = useState<string>('');
    const [hiddenClassIds, setHiddenClassIds] = useState<number[]>([]);
    const [customClassColors, setCustomClassColors] = useState<Record<number, string>>({});
    const [isIssueSubmitting, setIsIssueSubmitting] = useState<boolean>(false);
    const [issueRequestType, setIssueRequestType] = useState<TaskIssueType | null>(null);
    const [selectedIssueReason, setSelectedIssueReason] = useState<TaskIssueReasonCode>('OTHER');
    const [openIssueCount, setOpenIssueCount] = useState<number>(0);
    const [openIssueRequestsSignal, setOpenIssueRequestsSignal] = useState<number>(0);

    // Label Management State
    const [selectedLabelFile, setSelectedLabelFile] = useState<string>('');
    const [availableLabelFiles, setAvailableLabelFiles] = useState<string[]>([]);
    const [currentClasses, setCurrentClasses] = useState<YoloClass[]>([]);
    const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);

    // Guide State
    const [showGuide, setShowGuide] = useState(false);
    const [currentPdfUrl, setCurrentPdfUrl] = useState<string>('');
    const [guideList, setGuideList] = useState<{ title: string, filename: string }[]>([]);
    const [showGuidePicker, setShowGuidePicker] = useState(false);
    const guideDropdownRef = useRef<HTMLDivElement>(null);

    // Click outside to close guide dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (guideDropdownRef.current && !guideDropdownRef.current.contains(event.target as Node)) {
                setShowGuidePicker(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Load tasks on mount
    useEffect(() => {
        const init = async () => {
            setIsDataLoading(true);
            try {
                await Storage.initStorage();
                refreshTasks();

                // Load Label Files
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
                console.error("Initialization Failed", e);
            } finally {
                setIsDataLoading(false);
            }
        };
        init();
    }, []);

    // Parse Classes when file selection changes
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            const hasModified = tasks.some(t => t.isModified);
            if (hasModified) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [tasks]);

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

    useEffect(() => {
        if (!user || user.accountType !== AccountType.ADMIN) {
            setOpenIssueCount(0);
            return;
        }

        let disposed = false;
        const fetchOpenIssueCount = async () => {
            const count = await Storage.getOpenIssueCount();
            if (!disposed) setOpenIssueCount(count);
        };

        fetchOpenIssueCount();
        const intervalId = window.setInterval(fetchOpenIssueCount, 15000);
        return () => {
            disposed = true;
            window.clearInterval(intervalId);
        };
    }, [user]);

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

    const handleOpenIssues = () => {
        setCurrentTask(null);
        setCurrentView('DASHBOARD');
        setOpenIssueRequestsSignal(prev => prev + 1);
    };

    const refreshTasks = () => {
        setTasks(Storage.getTasks());
    };

    const handleSync = async () => {
        setIsDataLoading(true);
        try {
            await fetch('/api/sync', { method: 'POST' });
            await Storage.initStorage();
            await Storage.syncAllTaskPages();
            refreshTasks();
        } finally {
            setIsDataLoading(false);
        }
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

    const handleCloseTask = useCallback(async () => {
        if (currentTask && startTime > 0 && user) {
            const duration = (Date.now() - startTime) / 1000;
            // Sync any pending changes
            await Storage.syncTaskToServer(currentTask.id);

            // Smart Logging: Only log if modified OR stayed > 3 seconds
            if (currentTask.isModified || duration >= 3) {
                Storage.logAction(currentTask.id, user.username, currentUserRole, 'SAVE', duration, currentTask.isModified === true);
            }
        }
        setCurrentTask(null);
        setStartTime(0);
        setJumpIndex('');
        refreshTasks();
    }, [currentTask, startTime, currentUserRole, user]);

    const handleUpdateAnnotations = async (newAnnotations: any[]) => {
        if (!currentTask || !user) return;
        const updated = await Storage.updateTaskLocally(currentTask.id, { annotations: newAnnotations });
        setCurrentTask(updated);
    };

    const handleCreateIssue = useCallback((type: TaskIssueType) => {
        setIssueRequestType(type);
        setSelectedIssueReason('OTHER');
    }, []);

    const handleSubmitIssueRequest = useCallback(async () => {
        if (!currentTask || !user || !issueRequestType) return;
        const confirmed = window.confirm(issueRequestType === 'DELETE_REQUEST'
            ? '삭제 요청을 접수할까요?'
            : '확인 요청을 접수할까요?');
        if (!confirmed) return;

        setIsIssueSubmitting(true);
        try {
            await Storage.createTaskIssue({
                taskId: currentTask.id,
                type: issueRequestType,
                reasonCode: selectedIssueReason,
                createdBy: user.username
            });
            alert(issueRequestType === 'DELETE_REQUEST' ? '삭제 요청이 접수되었습니다.' : '확인 요청이 접수되었습니다.');
            setIssueRequestType(null);
            if (user.accountType === AccountType.ADMIN) {
                const count = await Storage.getOpenIssueCount();
                setOpenIssueCount(count);
            }
        } catch (e: any) {
            const msg = e?.message || '';
            if (msg.includes('409')) {
                alert('이미 동일 유형의 요청이 열려 있습니다.');
            } else {
                alert('요청 접수에 실패했습니다.');
            }
        } finally {
            setIsIssueSubmitting(false);
        }
    }, [currentTask, user, issueRequestType, selectedIssueReason]);

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

    const navigateTask = useCallback(async (direction: 'NEXT' | 'PREV', validStatuses: TaskStatus[]) => {
        if (!currentTask || !user) return;
        const allTasks = Storage.getTasks();

        // Filter tasks to stay within the same assignment context
        const relevantTasks = allTasks.filter(t =>
            currentUserRole === UserRole.REVIEWER || t.assignedWorker === user.username
        );

        const targetTask = findNextTask(relevantTasks, currentTask.id, currentTask.folder, direction, validStatuses);

        // SYNC BEFORE MOVE
        // Log "SAVE" action to capture time spent
        const duration = (Date.now() - startTime) / 1000;

        // Smart Logging: Only log if modified OR stayed > 3 seconds
        if (currentTask.isModified || duration >= 3) {
            Storage.logAction(currentTask.id, user.username, currentUserRole, 'SAVE', duration, currentTask.isModified === true);
        }
        await Storage.syncTaskToServer(currentTask.id);

        if (targetTask) {
            handleTaskSelect(targetTask.id);
            setJumpIndex('');
        } else {
            if (direction === 'NEXT') {
                // alert("End of folder.");
            } else {
                alert("Start of folder.");
            }
        }
    }, [currentTask, startTime, currentUserRole, user, handleTaskSelect]);

    const handleJumpToIndex = useCallback(async (index: number) => {
        if (!currentTask || !user) return;
        const allTasks = Storage.getTasks();
        const relevantTasks = allTasks.filter(t =>
            currentUserRole === UserRole.REVIEWER || t.assignedWorker === user.username
        );
        const folderTasks = relevantTasks.filter(t => t.folder === currentTask.folder);
        folderTasks.sort((a, b) => a.name.localeCompare(b.name));

        const targetIndex = Math.max(0, Math.min(index - 1, folderTasks.length - 1));
        const targetTask = folderTasks[targetIndex];

        if (targetTask && targetTask.id !== currentTask.id) {
            // SILENT NAVIGATION: Stop saving/syncing on jump/slider
            handleTaskSelect(targetTask.id);
            setJumpIndex('');
        }
    }, [currentTask, currentUserRole, user, handleTaskSelect]);

    const handleSubmit = useCallback(async (direction: 'NEXT' | 'PREV' = 'NEXT') => {
        if (!currentTask || !user) return;

        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTaskLocally(currentTask.id, { status: TaskStatus.SUBMITTED });

        // Single robust sync
        await Storage.syncTaskToServer(currentTask.id);

        Storage.logAction(currentTask.id, user.username, currentUserRole, 'SUBMIT', duration, currentTask.isModified === true);

        const allTasks = Storage.getTasks();
        setTasks(allTasks);

        const relevantTasks = allTasks.filter(t => t.assignedWorker === user.username);
        // Sequential Navigation: Include all statuses
        const validStatuses = Object.values(TaskStatus);
        const targetTask = findNextTask(relevantTasks, currentTask.id, currentTask.folder, direction, validStatuses);

        if (targetTask) {
            handleTaskSelect(targetTask.id);
            // ONLY clear jump index when navigation actually occurs
            setJumpIndex('');
        } else {
            if (direction === 'NEXT') {
                alert("This is the last task in the folder.");
            } else {
                alert("This is the first task in the folder.");
            }
        }
    }, [currentTask, startTime, currentUserRole, handleTaskSelect, user]);

    const handleReview = useCallback(async (approved: boolean, direction: 'NEXT' | 'PREV' | null = null) => {
        if (!currentTask || !user) return;
        const newStatus = approved ? TaskStatus.APPROVED : TaskStatus.REJECTED;

        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTaskLocally(currentTask.id, { status: newStatus });
        await Storage.syncTaskToServer(currentTask.id);
        Storage.logAction(currentTask.id, user.username, currentUserRole, approved ? 'APPROVE' : 'REJECT', duration);

        const allTasks = Storage.getTasks();
        setTasks(allTasks);

        if (!direction) {
            alert(approved ? "Task Approved" : "Task Rejected");
            return;
        }

        const relevantTasks = allTasks; // Reviewers can see all work in the folder
        // Sequential Navigation for Reviewers: Include all statuses
        const validStatuses = Object.values(TaskStatus);
        const targetTask = findNextTask(relevantTasks, currentTask.id, currentTask.folder, direction, validStatuses);

        if (targetTask) {
            handleTaskSelect(targetTask.id);
            setJumpIndex('');
        } else {
            if (direction === 'NEXT') {
                alert("This is the last task in the folder.");
            } else {
                alert("This is the first task in the folder.");
            }
        }
    }, [currentTask, startTime, currentUserRole, handleTaskSelect, handleCloseTask, user]);

    // Keyboard Shortcuts for Main App
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!currentTask) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            const key = e.key.toLowerCase();

            // Toggle All Visibility: '`'
            if (e.key === '`') {
                e.preventDefault();
                setHiddenClassIds(prev =>
                    prev.length > 0 ? [] : currentClasses.map(c => c.id)
                );
            }

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

                // A: Prev (Sequential)
                if (key === 'a') {
                    handleReview(true, 'PREV');
                }

                // D: Next (Sequential)
                if (key === 'd') {
                    handleReview(true, 'NEXT');
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentTask, handleSubmit, handleReview, currentUserRole, currentClasses, navigateTask]);

    const currentFolderStats = useMemo(() => {
        if (!currentTask) return { completed: 0, total: 0, approved: 0 };
        const folderTasks = tasks.filter(t => t.folder === currentTask.folder);
        const completed = folderTasks.filter(t => t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED).length;
        const approved = folderTasks.filter(t => t.status === TaskStatus.APPROVED).length;
        return { completed, total: folderTasks.length, approved };
    }, [currentTask, tasks]);

    const orderedCurrentFolderTasks = useMemo(() => {
        if (!currentTask || !user) return [];
        const relevantTasks = tasks.filter(t =>
            currentUserRole === UserRole.REVIEWER || t.assignedWorker === user.username
        );
        return relevantTasks
            .filter(t => t.folder === currentTask.folder)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [tasks, currentTask, currentUserRole, user]);

    const currentFolderTaskIndex = useMemo(() => {
        if (!currentTask) return -1;
        return orderedCurrentFolderTasks.findIndex(t => t.id === currentTask.id);
    }, [orderedCurrentFolderTasks, currentTask]);

    if (!user) {
        return <Login onLogin={handleLogin} />;
    }

    return (
        <div className="h-screen bg-slate-950 text-slate-100 flex flex-col font-sans overflow-hidden">
            {isDataLoading && <LoadingOverlay message="Loading Dataset" />}
            {/* Navbar */}
            <nav className="border-b border-slate-800 bg-slate-900 z-50 shadow-sm flex-shrink-0">
                <div className="w-full max-w-[1800px] mx-auto px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <img src="/logo.ico" alt="Logo" className="w-10 h-10 object-contain drop-shadow-md" />
                        <h1 className="font-bold text-xl tracking-tight">Intellivix Data Studio</h1>

                        {/* Main Navigation Tabs */}
                        <div className="ml-8 flex space-x-2">
                            <button
                                onClick={() => setCurrentView('DASHBOARD')}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${currentView === 'DASHBOARD' ? 'bg-slate-800 text-white shadow-inner' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
                            >
                                Dashboard
                            </button>
                            {/* Show History only for Admin */}
                            {user.accountType === AccountType.ADMIN && (
                                <button
                                    onClick={() => setCurrentView('HISTORY')}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${currentView === 'HISTORY' ? 'bg-slate-800 text-white shadow-inner' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
                                >
                                    History
                                </button>
                            )}

                            <div className="relative" ref={guideDropdownRef}>
                                <button
                                    onClick={async () => {
                                        if (showGuidePicker) {
                                            setShowGuidePicker(false);
                                            return;
                                        }

                                        if (guideList.length > 0) {
                                            setShowGuidePicker(true);
                                            return;
                                        }

                                        try {
                                            const res = await fetch('/guides/list.json');
                                            if (res.ok) {
                                                const guides = await res.json();
                                                if (guides.length === 0) {
                                                    alert('No guides available.');
                                                } else {
                                                    setGuideList(guides);
                                                    setShowGuidePicker(true);
                                                }
                                            } else {
                                                // Fallback if list.json fails
                                                setCurrentPdfUrl('/guides/Worker_Guide_v1.pdf');
                                                setShowGuide(true);
                                            }
                                        } catch (e) {
                                            setCurrentPdfUrl('/guides/Worker_Guide_v1.pdf');
                                            setShowGuide(true);
                                        }
                                    }}
                                    className={`px-4 py-2 hover:text-white hover:bg-slate-800/50 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${showGuidePicker ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
                                >
                                    <img src="/icons/book.svg" alt="" className="w-4 h-4 hidden" onError={(e) => (e.currentTarget.style.display = 'none')} />
                                    <span className="flex items-center gap-2">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                                        Guide
                                    </span>
                                </button>

                                {/* Dropdown Menu */}
                                {showGuidePicker && (
                                    <div className="absolute top-full right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-xl overflow-hidden z-[60] animate-in fade-in slide-in-from-top-2">
                                        <div className="p-2 flex flex-col gap-1">
                                            <div className="px-3 py-2 text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800 mb-1">
                                                Available Guides
                                            </div>
                                            {guideList.map((guide, idx) => (
                                                <button
                                                    key={idx}
                                                    onClick={() => {
                                                        setCurrentPdfUrl(`/guides/${guide.filename}`);
                                                        setShowGuide(true);
                                                        setShowGuidePicker(false);
                                                    }}
                                                    className="w-full text-left px-3 py-2.5 hover:bg-slate-800 rounded-lg text-slate-300 hover:text-white transition-colors flex items-center gap-3 group"
                                                >
                                                    <span className="w-6 h-6 rounded-md bg-slate-800 group-hover:bg-sky-900/50 flex items-center justify-center text-slate-500 group-hover:text-sky-400 transition-colors">
                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                                    </span>
                                                    <span className="text-sm font-medium truncate">{guide.title}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        {!currentTask && user.accountType === AccountType.ADMIN && (
                            <div className="flex bg-slate-800 rounded-lg p-1">
                                <button
                                    onClick={() => setCurrentUserRole(UserRole.WORKER)}
                                    className={`px-5 py-1.5 rounded-md text-sm font-medium transition-all ${currentUserRole === UserRole.WORKER ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                                >
                                    Worker View
                                </button>
                                <button
                                    onClick={() => setCurrentUserRole(UserRole.REVIEWER)}
                                    className={`px-5 py-1.5 rounded-md text-sm font-medium transition-all ${currentUserRole === UserRole.REVIEWER ? 'bg-purple-900 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                                >
                                    Reviewer View
                                </button>
                            </div>
                        )}

                        <div className="flex items-center gap-4 border-l border-slate-800 pl-6">
                            <div className="text-right">
                                <p className="text-sm font-bold text-white leading-none">{user.username}</p>
                                <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-wider">{user.accountType}</p>
                            </div>
                            {user.accountType === AccountType.ADMIN && (
                                <button
                                    onClick={handleOpenIssues}
                                    className="relative p-2 text-slate-400 hover:text-sky-300 hover:bg-sky-900/20 rounded-lg transition-colors"
                                    title="Issue Notifications"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                                    {openIssueCount > 0 && (
                                        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] leading-[18px] text-center rounded-full font-bold">
                                            {openIssueCount > 99 ? '99+' : openIssueCount}
                                        </span>
                                    )}
                                </button>
                            )}
                            <button
                                onClick={handleLogout}
                                className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
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
                                onSync={handleSync}
                                username={user.username}
                                openIssueRequestsSignal={openIssueRequestsSignal}
                            />
                        ) : (
                            <div className="flex w-full h-full">
                                {/* Sidebar (Tools) */}
                                <aside className="w-80 bg-slate-900 border-r border-slate-800 flex flex-col z-20 shadow-2xl">
                                    <div className="p-6 border-b border-slate-800">
                                        <button
                                            onClick={handleCloseTask}
                                            className="text-slate-400 hover:text-white flex items-center gap-2 text-sm font-medium mb-4 transition-colors"
                                        >
                                            ← Back to Dashboard
                                        </button>
                                        <h2 className="font-bold text-lg text-white truncate" title={currentTask.name}>{currentTask.name}</h2>
                                        <div className="flex items-center gap-3 mt-3">
                                            <span className="text-xs font-bold text-slate-400 bg-slate-800 px-2.5 py-1 rounded border border-slate-700">
                                                {TaskStatusLabels[currentTask.status]}
                                            </span>
                                            <span className="text-xs text-slate-500 border-l border-slate-700 pl-3">
                                                {currentTask.folder}
                                            </span>
                                        </div>

                                        <div className="mt-6 bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
                                            {currentUserRole === UserRole.REVIEWER ? (
                                                <>
                                                    <div className="flex justify-between text-xs text-slate-400 mb-2 font-medium">
                                                        <span>Review Progress</span>
                                                        <span>{currentFolderStats.approved} / {currentFolderStats.completed - currentFolderStats.approved}</span>
                                                    </div>
                                                    <div className="w-full bg-slate-700 h-2 rounded-full overflow-hidden">
                                                        <div
                                                            className="bg-purple-600 h-full transition-all duration-300"
                                                            style={{ width: `${currentFolderStats.completed > 0 ? (currentFolderStats.approved / currentFolderStats.completed) * 100 : 0}%` }}
                                                        />
                                                    </div>
                                                    <div className="mt-1 text-[10px] text-right text-slate-500">Approved / Pending</div>
                                                </>
                                            ) : (
                                                <>
                                                    <div className="flex justify-between text-xs text-slate-400 mb-2 font-medium">
                                                        <span>Folder Progress</span>
                                                        <span>{currentFolderStats.completed} / {currentFolderStats.total}</span>
                                                    </div>
                                                    <div className="w-full bg-slate-700 h-2 rounded-full overflow-hidden">
                                                        <div
                                                            className="bg-sky-500 h-full transition-all duration-300"
                                                            style={{ width: `${(currentFolderStats.completed / Math.max(currentFolderStats.total, 1)) * 100}%` }}
                                                        />
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    {/* Label Set Selector */}
                                    <div className="p-6 bg-slate-800/30 border-b border-slate-800">
                                        <label className="text-xs text-slate-500 font-bold uppercase tracking-wider block mb-2">라벨셋</label>
                                        <select
                                            value={selectedLabelFile}
                                            onChange={(e) => setSelectedLabelFile(e.target.value)}
                                            className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg p-2.5 focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-none shadow-sm"
                                        >
                                            {availableLabelFiles.map(fileName => (
                                                <option key={fileName} value={fileName}>{fileName}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex-1 overflow-y-auto p-4 space-y-0.5">
                                        <h3 className="px-2 text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Classes (1-9)</h3>
                                        {currentClasses.map((cls, idx) => (
                                            <div key={cls.id} className="group flex items-center gap-2">
                                                <button
                                                    onClick={() => setSelectedClass(cls)}
                                                    className={`flex-1 flex items-center gap-3 px-3 py-1.5 rounded-md border transition-all ${selectedClass?.id === cls.id
                                                        ? 'bg-slate-800 border-slate-600 shadow-md'
                                                        : 'border-transparent hover:bg-slate-800/50'
                                                        }`}
                                                >
                                                    <div className="relative group/color shrink-0">
                                                        <span
                                                            className="w-3.5 h-3.5 rounded-full block border border-white/20 shadow-sm cursor-pointer hover:scale-110 transition-transform"
                                                            style={{ backgroundColor: customClassColors[cls.id] || cls.color }}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                const parent = (e.currentTarget as HTMLElement).parentElement;
                                                                const picker = parent?.querySelector('input') as HTMLInputElement;
                                                                picker?.click();
                                                            }}
                                                        ></span>
                                                        <input
                                                            type="color"
                                                            className="absolute opacity-0 w-0 h-0 pointer-events-none"
                                                            value={customClassColors[cls.id] || cls.color}
                                                            onChange={(e) => setCustomClassColors(prev => ({ ...prev, [cls.id]: e.target.value }))}
                                                        />
                                                    </div>
                                                    <span className={`text-sm font-medium truncate ${hiddenClassIds.includes(cls.id) ? 'text-slate-600 line-through' : 'text-slate-200'}`}>
                                                        {cls.name}
                                                    </span>
                                                    <span className="ml-auto text-[10px] text-slate-600 font-mono">
                                                        {idx + 1}
                                                    </span>
                                                </button>

                                                <button
                                                    onClick={() => {
                                                        setHiddenClassIds(prev =>
                                                            prev.includes(cls.id) ? prev.filter(id => id !== cls.id) : [...prev, cls.id]
                                                        );
                                                    }}
                                                    className={`p-1.5 rounded-md transition-all ${hiddenClassIds.includes(cls.id) ? 'bg-red-900/40 text-red-400' : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'}`}
                                                    title={hiddenClassIds.includes(cls.id) ? "Show Class" : "Hide Class"}
                                                >
                                                    {hiddenClassIds.includes(cls.id) ? (
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" /></svg>
                                                    ) : (
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                                    )}
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="p-6 border-t border-slate-800 space-y-3 bg-slate-900">
                                        {currentUserRole === UserRole.WORKER ? (
                                            <div className="space-y-3">
                                                <div className="flex gap-3">
                                                    <button
                                                        onClick={() => handleSubmit('PREV')}
                                                        className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg shadow-sm border border-slate-700 transition-all text-sm flex items-center justify-center gap-2"
                                                        title="제출 & 이전 (A)"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                                        이전
                                                    </button>
                                                    <button
                                                        onClick={() => handleSubmit('NEXT')}
                                                        className="flex-[1.5] py-3 bg-lime-600 hover:bg-lime-500 text-white font-bold rounded-lg shadow-lg transition-transform active:scale-[0.98] text-sm flex items-center justify-center gap-2"
                                                        title="제출 & 다음 (D)"
                                                    >
                                                        <span>제출 & 다음</span>
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                                    </button>
                                                </div>
                                                <div className="grid grid-cols-2 gap-2">
                                                    <button
                                                        onClick={() => handleCreateIssue('REVIEW_REQUEST')}
                                                        disabled={isIssueSubmitting}
                                                        className="py-2 bg-blue-900/40 hover:bg-blue-900/60 border border-blue-800 text-blue-200 font-semibold rounded-lg text-xs transition-colors disabled:opacity-50"
                                                    >
                                                        확인 요청
                                                    </button>
                                                    <button
                                                        onClick={() => handleCreateIssue('DELETE_REQUEST')}
                                                        disabled={isIssueSubmitting}
                                                        className="py-2 bg-red-900/40 hover:bg-red-900/60 border border-red-800 text-red-200 font-semibold rounded-lg text-xs transition-colors disabled:opacity-50"
                                                    >
                                                        삭제 요청
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="space-y-3">
                                                <button
                                                    onClick={() => handleReview(false)}
                                                    className="w-full py-3 bg-red-900/50 hover:bg-red-900 border border-red-800 text-red-100 font-bold rounded-lg transition-colors text-sm"
                                                >
                                                    작업 반려
                                                </button>
                                                <div className="flex gap-3">
                                                    <button
                                                        onClick={() => handleReview(true, 'PREV')}
                                                        className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg shadow-sm border border-slate-700 transition-all text-sm flex items-center justify-center gap-2"
                                                        title="이전 (A)"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                                        이전
                                                    </button>
                                                    <button
                                                        onClick={() => handleReview(true, 'NEXT')}
                                                        className="flex-[1.5] py-3 bg-lime-600 hover:bg-lime-500 text-white font-bold rounded-lg shadow transition-colors text-sm flex items-center justify-center gap-2"
                                                        title="완료 & 다음 (D)"
                                                    >
                                                        <span>완료 & 다음</span>
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </aside>

                                {/* Canvas Area with Separate Status Bars */}
                                <div className="flex-1 flex flex-col bg-slate-950 relative overflow-hidden">
                                    {/* Top Bar: Current Status & Class */}
                                    <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 z-30 shadow-md flex-shrink-0">
                                        <div className="flex items-center gap-4">
                                            <span className="text-slate-400 text-sm font-medium">Active Class:</span>
                                            <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700">
                                                <span className="w-4 h-4 rounded-full" style={{ backgroundColor: selectedClass?.color || '#fff' }}></span>
                                                <span className="text-white font-bold text-base">{selectedClass?.name || 'None'}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={`w-2.5 h-2.5 rounded-full ${currentUserRole === UserRole.WORKER ? 'bg-lime-500 animate-pulse' : 'bg-slate-500'}`}></span>
                                            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
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
                                            hiddenClassIds={hiddenClassIds}
                                            customClassColors={customClassColors}
                                        />
                                    </div>

                                    {/* Bottom Navigation Control */}
                                    <div className="h-24 bg-slate-900 border-t border-slate-800 flex items-center px-8 gap-10 z-30 shadow-lg flex-shrink-0">
                                        <div className="flex items-center gap-4 min-w-[200px]">
                                            <span className="text-slate-400 text-sm font-bold uppercase tracking-wider">Jump To</span>
                                            <div className="relative">
                                                <input
                                                    type="number"
                                                    value={jumpIndex}
                                                    placeholder={(Math.max(currentFolderTaskIndex, 0) + 1).toString()}
                                                    onChange={(e) => setJumpIndex(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            handleJumpToIndex(parseInt(jumpIndex));
                                                        }
                                                    }}
                                                    className="w-28 bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xl font-bold text-white focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex-1 flex items-center gap-6">
                                            <input
                                                type="range"
                                                min="1"
                                                max={Math.max(orderedCurrentFolderTasks.length, 1)}
                                                value={Math.max(currentFolderTaskIndex, 0) + 1}
                                                onChange={(e) => handleJumpToIndex(parseInt(e.target.value))}
                                                className="flex-1 h-3 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                            />
                                            <div className="text-2xl font-mono text-slate-300 bg-slate-800 px-6 py-2 rounded-xl border border-slate-700 shadow-inner">
                                                <span className="text-white font-black">{Math.max(currentFolderTaskIndex, 0) + 1}</span>
                                                <span className="text-slate-500 mx-2">/</span>
                                                <span className="text-slate-400">{orderedCurrentFolderTasks.length}</span>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-3 text-sm text-slate-500 font-semibold italic">
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            Press Enter to jump
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </main>


            {issueRequestType && (
                <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6">
                        <h3 className="text-lg font-bold text-white mb-2">
                            {issueRequestType === 'DELETE_REQUEST' ? '삭제 요청' : '확인 요청'}
                        </h3>
                        <p className="text-sm text-slate-400 mb-4">요청 사유를 선택한 뒤 접수해주세요.</p>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">사유</label>
                        <select
                            value={selectedIssueReason}
                            onChange={(e) => setSelectedIssueReason(e.target.value as TaskIssueReasonCode)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-sky-500"
                        >
                            {ISSUE_REASON_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={() => setIssueRequestType(null)}
                                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-semibold"
                                disabled={isIssueSubmitting}
                            >
                                취소
                            </button>
                            <button
                                onClick={handleSubmitIssueRequest}
                                disabled={isIssueSubmitting}
                                className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold disabled:opacity-50"
                            >
                                {isIssueSubmitting ? '요청 중...' : '요청 보내기'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Guide Viewer Modal */}
            {showGuide && (
                <GuideViewer
                    pdfUrl={currentPdfUrl}
                    onClose={() => setShowGuide(false)}
                />
            )}
        </div>
    );
};

export default App;
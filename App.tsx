import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { UserRole, Task, TaskStatus, TaskStatusLabels, YoloClass, User, AccountType, TaskIssueReasonCode, TaskIssueType, PluginSourceType, WORKFLOW_CONFIG } from './types';
import { COLOR_PALETTE } from './constants';
import * as Storage from './services/storage';
import { apiUrl, resolveDatasetPublicUrl } from './services/apiBase';
import { resolveProjectMapEntryForFolder } from './services/projectMapResolve';
import Dashboard, { invalidateProjectDetailCache, type SelectTaskOptions } from './components/Dashboard';
import AnnotationCanvas from './components/AnnotationCanvas';
import VlmReviewPanel, { VlmDraftPayload } from './components/VlmReviewPanel';
import ClassificationPanel from './components/ClassificationPanel';
import Login from './components/Login';
import { GuideViewer } from './components/GuideViewer';
import { FirstTimeGuideModal, AdminGuideContent, WorkerGuideContent } from './components/FirstTimeGuideModal';

const LoadingOverlay: React.FC<{ message: string; detail?: string; progressLine?: string }> = ({
    message,
    detail,
    progressLine
}) => (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-6 max-w-lg w-full mx-4">
            <div className="relative">
                <div className="w-16 h-16 border-4 border-slate-800 border-t-blue-500 rounded-full animate-spin"></div>
                <div className="absolute inset-0 flex items-center justify-center text-blue-500">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                </div>
            </div>
            <div className="text-center w-full px-1">
                <h3 className="text-xl font-bold text-white mb-2">{message}</h3>
                <p className="text-slate-400 text-sm">{detail ?? '잠시만 기다려 주세요.'}</p>
                {progressLine ? (
                    <p className="text-emerald-300/95 text-xs font-mono mt-3 break-words leading-relaxed whitespace-pre-line text-left w-full">
                        {progressLine}
                    </p>
                ) : null}
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

type View = 'DASHBOARD';

const ISSUE_REASON_OPTIONS: Array<{ value: TaskIssueReasonCode; label: string }> = [
    { value: 'BLUR', label: '흐림' },
    { value: 'DUPLICATE', label: '가려짐' },
    { value: 'WRONG_CLASS', label: '확인불가' },
    { value: 'CORRUPT', label: '이미지불량' },
    { value: 'OTHER', label: '기타' }
];

/**
 * 같은 폴더·스코프(예: 배정 작업자) 태스크만 모은다.
 * 폴더 버킷은 Storage 폴더 인덱스로 O(1) 조회 후, 스코프만 해당 폴더 길이만큼 순회.
 */
function collectFolderNavTasks(folder: string, relevantFilter: (t: Task) => boolean): Task[] {
    const inFolder = Storage.getCachedTasksInFolderForNav(folder);
    const out: Task[] = [];
    for (let i = 0; i < inFolder.length; i++) {
        const t = inFolder[i];
        if (!relevantFilter(t)) continue;
        out.push(t);
    }
    return out;
}

/** 같은 폴더·스코프 안에서 이전/다음 태스크 (이미 collectFolderNavTasks 로 좁힌 목록 기준) */
function findAdjacentInFolderTaskList(
    folderTasks: Task[],
    currentId: string,
    direction: 'NEXT' | 'PREV',
    validStatuses: TaskStatus[]
): Task | null {
    if (folderTasks.length === 0) return null;

    const currentTask = folderTasks.find((t) => t.id === currentId);
    if (!currentTask) return null;

    const isVlmFolder = folderTasks.some((t) => t.sourceType === 'vlm-review');
    const compareTaskOrder = (a: Task, b: Task): number =>
        isVlmFolder
            ? a.id.localeCompare(b.id)
            : a.name.localeCompare(b.name, undefined, { numeric: true });

    // 대용량 폴더에서 매번 정렬(O(n log n))하지 않고, 단일 스캔(O(n))으로 이웃 태스크를 찾는다.
    // NEXT: 정렬 순서상 현재 다음 중 status가 valid인 첫 태스크(기존 slice+find와 동일).
    // PREV: 정렬 순서상 바로 이전 태스크(기존은 status 무시 — 레거시와 동일하게 유지).
    if (direction === 'PREV') {
        let prev: Task | null = null;
        for (const task of folderTasks) {
            const cmp = compareTaskOrder(task, currentTask);
            if (cmp >= 0) continue;
            if (!prev || compareTaskOrder(task, prev) > 0) prev = task;
        }
        return prev;
    }

    let candidate: Task | null = null;
    for (const task of folderTasks) {
        if (!validStatuses.includes(task.status)) continue;
        const cmpToCurrent = compareTaskOrder(task, currentTask);
        if (cmpToCurrent <= 0) continue;
        if (!candidate || compareTaskOrder(task, candidate) < 0) candidate = task;
    }
    return candidate;
}

/**
 * 로그인 직후 캐시가 부분만 있을 때 폴더 단위로 서버에서 보강한 뒤 한 번 더 이전/다음을 찾음.
 */
/** 검수자: 현재 태스크와 동일 배정 작업자만 이전/다음·슬라이더에 포함(VLM·네이티브·분류 공통). 배정 없으면 폴더 전체(레거시). */
function reviewerMatchesAssignedScope(t: Task, current: Task): boolean {
    const cw = String(current.assignedWorker || '').trim();
    if (!cw) return true;
    return String(t.assignedWorker || '').trim() === cw;
}

async function findNextTaskWithFolderHydration(
    direction: 'NEXT' | 'PREV',
    validStatuses: TaskStatus[],
    ctx: { currentId: string; currentFolder: string; relevantFilter: (t: Task) => boolean },
    onMerged: () => void
): Promise<Task | null> {
    const run = () =>
        findAdjacentInFolderTaskList(
            collectFolderNavTasks(ctx.currentFolder, ctx.relevantFilter),
            ctx.currentId,
            direction,
            validStatuses
        );
    let t = run();
    if (t) return t;
    await Storage.fetchAndMergeTasksByFolder(ctx.currentFolder);
    onMerged();
    return run();
}

/** overview·GET /api/projects 의 클래스 항목 필드 차이 흡수 */
function normalizeClassificationClassFromOverview(c: unknown, paletteIndex: number): YoloClass | null {
    if (c == null || typeof c !== 'object') return null;
    const o = c as Record<string, unknown>;
    const rawId = o.id ?? o.classId;
    const id = typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : Number(rawId);
    const name = String(o.name ?? o.label ?? '').trim();
    if (!Number.isFinite(id)) return null;
    return {
        id,
        name: name || `클래스 ${id}`,
        color: COLOR_PALETTE[paletteIndex % COLOR_PALETTE.length]
    };
}

function mapRawOverviewClassesToYolo(raw: unknown): YoloClass[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out: YoloClass[] = [];
    for (let i = 0; i < raw.length; i++) {
        const yc = normalizeClassificationClassFromOverview(raw[i], out.length);
        if (yc) out.push(yc);
    }
    return out;
}

/** ReviewQueuePanel과 동일 정렬(폴더 → 파일명/id) */
function sortWorkerTasksLikeReviewQueue(list: Task[]): Task[] {
    const isVlm = list.some((t) => t.sourceType === 'vlm-review');
    return [...list].sort((a, b) => {
        const fc = String(a.folder).localeCompare(String(b.folder));
        if (fc !== 0) return fc;
        return isVlm ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

function taskBelongsToReviewerQueueProject(t: Task, queueProjectId: string | null | undefined): boolean {
    if (queueProjectId == null || String(queueProjectId).trim() === '') return true;
    const snap = Storage.getProjectOverviewCacheSnapshot();
    const projectMap = snap?.projectMap ?? {};
    const resolved = resolveProjectMapEntryForFolder(t.folder, projectMap);
    const pid = resolved?.projectId ?? '__unmapped__';
    return pid === queueProjectId;
}

function buildReviewerQueueList(
    allTasks: Task[],
    workerScope: string,
    queueFilter: 'pending' | 'all',
    validStatuses: TaskStatus[],
    queueProjectId?: string | null
): Task[] {
    const w = String(workerScope || '').trim();
    let list = allTasks.filter((t) => String(t.assignedWorker || '').trim() === w);
    if (queueProjectId != null && String(queueProjectId).trim() !== '') {
        list = list.filter((t) => taskBelongsToReviewerQueueProject(t, queueProjectId));
    }
    if (queueFilter === 'pending') {
        list = list.filter((t) => t.status === TaskStatus.SUBMITTED);
    }
    list = list.filter((t) => validStatuses.includes(t.status));
    return sortWorkerTasksLikeReviewQueue(list);
}

function findAdjacentReviewerQueue(
    allTasks: Task[],
    currentId: string,
    direction: 'NEXT' | 'PREV',
    validStatuses: TaskStatus[],
    workerScope: string,
    queueFilter: 'pending' | 'all',
    queueProjectId?: string | null
): Task | null {
    const sorted = buildReviewerQueueList(allTasks, workerScope, queueFilter, validStatuses, queueProjectId);
    const idx = sorted.findIndex((t) => t.id === currentId);
    if (idx === -1) return null;
    const j = direction === 'NEXT' ? idx + 1 : idx - 1;
    return j >= 0 && j < sorted.length ? sorted[j] : null;
}

/**
 * 승인/거부 직후처럼 currentId가 큐 목록에 없을 때도 동작.
 * 스냅샷에 이웃이 없었던 경우(다음 폴더가 캐시에 없음) 서버 보강 뒤 이 함수로 정렬상 다음/이전 태스크를 찾음.
 */
function findAdjacentReviewerQueueFromAnchor(
    allTasks: Task[],
    anchor: Task,
    direction: 'NEXT' | 'PREV',
    validStatuses: TaskStatus[],
    workerScope: string,
    queueFilter: 'pending' | 'all',
    queueProjectId?: string | null
): Task | null {
    const list = buildReviewerQueueList(allTasks, workerScope, queueFilter, validStatuses, queueProjectId);
    if (list.length === 0) return null;
    const isVlm = list.some((t) => t.sourceType === 'vlm-review');
    const cmp = (a: Task, b: Task): number => {
        const fc = String(a.folder).localeCompare(String(b.folder));
        if (fc !== 0) return fc;
        return isVlm ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true });
    };
    if (direction === 'NEXT') {
        let best: Task | null = null;
        for (const t of list) {
            if (cmp(anchor, t) < 0) {
                if (!best || cmp(t, best) < 0) best = t;
            }
        }
        return best;
    }
    let best: Task | null = null;
    for (const t of list) {
        if (cmp(t, anchor) < 0) {
            if (!best || cmp(t, best) > 0) best = t;
        }
    }
    return best;
}

/** SUBMITTED 목록에서 승인/반려 후 현재 항목이 빠질 때 이웃(스냅샷 기준) */
function findNeighborReviewerQueueFromSnapshot(
    preSorted: Task[],
    currentId: string,
    direction: 'NEXT' | 'PREV'
): Task | null {
    const idx = preSorted.findIndex((t) => t.id === currentId);
    if (idx === -1) return null;
    const j = direction === 'NEXT' ? idx + 1 : idx - 1;
    return j >= 0 && j < preSorted.length ? preSorted[j] : null;
}

async function hydrateReviewerQueueCache(ws: string, queueProjectId: string | null): Promise<void> {
    const w = String(ws || '').trim();
    if (!w) return;
    if (queueProjectId != null && queueProjectId !== '') {
        const overview = Storage.getProjectOverviewCacheSnapshot();
        const map = overview?.projectMap ?? {};
        let folders: string[] = [];
        if (queueProjectId === '__unmapped__') {
            const set = new Set<string>();
            overview?.folders?.forEach((row) => {
                const pid = row.projectId ? String(row.projectId) : '';
                if (!pid) set.add(row.folder);
            });
            folders = [...set];
        } else {
            folders = Object.entries(map)
                .filter(([, v]) => String(v.projectId) === queueProjectId)
                .map(([k]) => k);
        }
        if (folders.length > 0) {
            await Storage.fetchAndMergeWorkerTasksForProjectFolders(w, folders);
            return;
        }
    }
    await Storage.fetchAndMergeWorkerTasks(w);
}

const App: React.FC = () => {
    /** 동일 계정(관리자/동일 작업자) 재로그인 시 태스크 캐시 유지 → 전체 재페이징으로 API를 잠식하지 않음 */
    const lastTasksLoginKeyRef = useRef<string | null>(null);

    // Authentication State
    const [user, setUser] = useState<User | null>(null);

    // App State
    const [currentUserRole, setCurrentUserRole] = useState<UserRole>(UserRole.WORKER);
    const [currentView, setCurrentView] = useState<View>('DASHBOARD');
    const [currentTask, setCurrentTask] = useState<Task | null>(null);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [startTime, setStartTime] = useState<number>(0);
    const [isDataLoading, setIsDataLoading] = useState<boolean>(false);
    /** 전체 디스크 스캔 등: 서버 job 폴링 메시지 */
    const [syncLoadingDetail, setSyncLoadingDetail] = useState<string>('');
    /** 관리자: 분류 프로젝트 폴더 진입 시 대량 merge */
    const [isFolderPrepareLoading, setIsFolderPrepareLoading] = useState<boolean>(false);
    const [jumpIndex, setJumpIndex] = useState<string>('');
    const [hiddenClassIds, setHiddenClassIds] = useState<number[]>([]);
    const [customClassColors, setCustomClassColors] = useState<Record<number, string>>({});
    const [isIssueSubmitting, setIsIssueSubmitting] = useState<boolean>(false);
    const [issueRequestType, setIssueRequestType] = useState<TaskIssueType | null>(null);
    const [selectedIssueReason, setSelectedIssueReason] = useState<TaskIssueReasonCode>('OTHER');
    const [openIssueCount, setOpenIssueCount] = useState<number>(0);
    const [openIssueRequestsSignal, setOpenIssueRequestsSignal] = useState<number>(0);
    /** 작업자 Work List용 overview 강제 재조회(목록 새로고침 등) */
    const [workerOverviewRefreshKey, setWorkerOverviewRefreshKey] = useState(0);
    /** 검수자 Work List·통계: 마지막으로 연 태스크의 배정 작업자로 좁힘(동일 폴더에 여러 작업자 분배 시) */
    const [reviewerScopeWorker, setReviewerScopeWorker] = useState<string | null>(null);
    /** 검수 큐에서 연 경우 폴더 경계 없이 이전/다음 */
    const [reviewerNavMode, setReviewerNavMode] = useState<'folder' | 'queue'>('folder');
    const [reviewerQueueFilter, setReviewerQueueFilter] = useState<'pending' | 'all'>('pending');
    /** 검수 큐에서 프로젝트 범위로 불러온 경우 이전/다음·슬라이더도 동일 프로젝트만 */
    const [reviewerQueueProjectId, setReviewerQueueProjectId] = useState<string | null>(null);

    // Label Management State
    const [selectedLabelFile, setSelectedLabelFile] = useState<string>('');
    const [availableLabelFiles, setAvailableLabelFiles] = useState<string[]>([]);
    const [currentClasses, setCurrentClasses] = useState<YoloClass[]>([]);
    const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);
    const [undoSignal, setUndoSignal] = useState<number>(0);
    const [redoSignal, setRedoSignal] = useState<number>(0);

    // Guide State
    const [showGuide, setShowGuide] = useState(false);
    const [currentPdfUrl, setCurrentPdfUrl] = useState<string>('');
    const [guideList, setGuideList] = useState<{ title: string, filename: string }[]>([]);
    const [showGuidePicker, setShowGuidePicker] = useState(false);
    const [showAdminGuide, setShowAdminGuide] = useState(false);
    const [showWorkerGuide, setShowWorkerGuide] = useState(false);
    const guideDropdownRef = useRef<HTMLDivElement>(null);
    const vlmDraftRef = useRef<VlmDraftPayload | null>(null);
    const vlmSubmitInFlightRef = useRef(false);
    const taskSelectSeqRef = useRef(0);
    const handleVlmDraftChange = useCallback((payload: VlmDraftPayload) => {
        vlmDraftRef.current = payload;
    }, []);
    const classificationDraftRef = useRef<number | null>(null);
    const [classificationClassesForPanel, setClassificationClassesForPanel] = useState<YoloClass[]>([]);
    const [classificationSelectedClassId, setClassificationSelectedClassId] = useState<number | null>(null);
    /** 폴더 단위 분류 클래스 — 한 세션에서 같은 폴더 재진입 시 overview/detail 생략 */
    const classificationClassesByFolderRef = useRef<Map<string, YoloClass[]>>(new Map());
    /** 프로젝트 저장·overview 강제 새로고침 시 분류 클래스 캐시를 버리고 다시 로드 */
    const [classificationOverviewEpoch, setClassificationOverviewEpoch] = useState(0);
    /** overview 캐시가 비어 있어도 분류 폴더(native-yolo 행)를 올바르게 인식하도록 선조회 후 계산 */
    const [folderMappedToClassification, setFolderMappedToClassification] = useState(false);

    useEffect(() => {
        const ev = Storage.PROJECT_OVERVIEW_INVALIDATE_EVENT;
        const onInvalidate = () => {
            classificationClassesByFolderRef.current.clear();
            setClassificationOverviewEpoch((n) => n + 1);
        };
        window.addEventListener(ev, onInvalidate);
        return () => window.removeEventListener(ev, onInvalidate);
    }, []);

    useEffect(() => {
        if (!currentTask?.folder) {
            setFolderMappedToClassification(false);
            return;
        }
        const folder = currentTask.folder;
        let cancelled = false;
        (async () => {
            let snap = Storage.getProjectOverviewCacheSnapshot();
            if (!snap?.projects?.length) {
                try {
                    await Storage.getProjectOverview();
                } catch (_e) {
                    if (!cancelled) setFolderMappedToClassification(false);
                    return;
                }
                snap = Storage.getProjectOverviewCacheSnapshot();
            }
            if (cancelled) return;
            setFolderMappedToClassification(Storage.isFolderMappedToImageClassificationProject(folder));
        })();
        return () => {
            cancelled = true;
        };
    }, [currentTask?.folder, classificationOverviewEpoch]);

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
            try {
                const res = await fetch(apiUrl('/api/label-files'));
                if (res.ok) {
                    const files = await res.json();
                    setAvailableLabelFiles(files);
                    if (files.length > 0) {
                        const defaultFile = files.includes('labels_default.txt') ? 'labels_default.txt' : files[0];
                        setSelectedLabelFile(defaultFile);
                    }
                }
            } catch (e) {
                console.error("Label file load failed", e);
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
                const res = await fetch(apiUrl(`/api/label?path=labels/${selectedLabelFile}`));
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

    const handleLogin = async (authenticatedUser: User) => {
        setUser(authenticatedUser);
        const loginKey =
            authenticatedUser.accountType === AccountType.ADMIN
                ? '__ADMIN__'
                : String(authenticatedUser.username || '').trim() || '__WORKER__';
        if (lastTasksLoginKeyRef.current !== loginKey) {
            Storage.clearTaskCache();
            lastTasksLoginKeyRef.current = loginKey;
        }

        if (authenticatedUser.accountType === AccountType.ADMIN) {
            setCurrentUserRole(UserRole.REVIEWER);
            Storage.setWorkerScope(null);
            setReviewerScopeWorker(null);
            setReviewerNavMode('folder');
            setReviewerQueueFilter('pending');
            setReviewerQueueProjectId(null);
        } else {
            setCurrentUserRole(UserRole.WORKER);
            Storage.setWorkerScope(authenticatedUser.username);
        }

        setIsDataLoading(true);
        try {
            await Storage.initStorage();
            refreshTasks();
            /**
             * 관리자 Reviewer 뷰에서 상단 Total Progress/Tasks 를 위해 전량 백그라운드 로드하던 경로.
             * 수십만 건 /api/datasets 연속 호출·DB 부하를 유발하므로 제거.
             * 초기 배치(VITE_TASK_INITIAL_SYNC_BATCHES)만 메모리에 두고, 폴더/프로젝트는 서버 overview·페이징 API 사용.
             */
        } catch (e) {
            console.error("Post-login init failed", e);
        } finally {
            setIsDataLoading(false);
        }
    };

    const handleLogout = () => {
        void Storage.stopTaskListBackgroundDrain();
        setUser(null);
        setCurrentTask(null);
        setCurrentUserRole(UserRole.WORKER);
        setCurrentView('DASHBOARD');
        Storage.setWorkerScope(null);
        setReviewerScopeWorker(null);
        setReviewerNavMode('folder');
        setReviewerQueueFilter('pending');
        setReviewerQueueProjectId(null);
    };

    const handleOpenIssues = () => {
        setCurrentTask(null);
        setCurrentView('DASHBOARD');
        setOpenIssueRequestsSignal(prev => prev + 1);
    };

    const refreshTasks = useCallback(() => {
        setTasks(Storage.getTasks());
    }, []);

    /** 디스크 스캔 없음 — DB·캐시만 갱신 (기본 동작) */
    const handleSync = async () => {
        setIsDataLoading(true);
        try {
            await Storage.stopTaskListBackgroundDrain();
            await Storage.initStorage({ fullTaskSync: true });
            Storage.invalidateProjectOverviewCache();
            invalidateProjectDetailCache();
            setWorkerOverviewRefreshKey((k) => k + 1);
            refreshTasks();
        } finally {
            setIsDataLoading(false);
        }
    };

    /** datasets 전체 디스크 스캔 — 명시적으로만 사용 (비동기 job + 진행 메시지 폴링) */
    const handleFullDiskSync = async () => {
        const ok = window.confirm(
            'datasets 폴더 전체를 디스크에서 스캔합니다.\n데이터가 많으면 수 분 이상 걸릴 수 있습니다.\n계속할까요?'
        );
        if (!ok) return;
        setIsDataLoading(true);
        setSyncLoadingDetail('서버에 동기화 작업 요청 중…');
        try {
            const res = await fetch(apiUrl('/api/sync?full=1'), { method: 'POST' });
            const data = (await res.json().catch(() => ({}))) as {
                jobId?: string;
                async?: boolean;
                error?: string;
            };
            if (!res.ok) {
                alert(String(data.error || res.statusText));
                return;
            }
            if (data.jobId && data.async) {
                const jobId = data.jobId;
                const deadline = Date.now() + 2 * 60 * 60 * 1000;
                for (;;) {
                    if (Date.now() > deadline) {
                        alert(
                            '동기화 진행 확인 시간(2시간)이 초과되었습니다. 서버에서 작업이 끝났는지 로그로 확인해 주세요.'
                        );
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 450));
                    const st = await fetch(apiUrl(`/api/sync/job/${encodeURIComponent(jobId)}`));
                    const job = (await st.json().catch(() => ({}))) as {
                        status?: string;
                        message?: string;
                        error?: string;
                        filesScanned?: number;
                        filesTotal?: number;
                        percent?: number;
                        phase?: string;
                    };
                    if (!st.ok) {
                        alert(String(job.error || st.statusText || '진행 상태를 가져오지 못했습니다.'));
                        return;
                    }
                    const diskProgressLines = [
                        typeof job.message === 'string' && job.message ? job.message : '',
                        typeof job.filesTotal === 'number' &&
                        job.filesTotal > 0 &&
                        typeof job.filesScanned === 'number'
                            ? `이미지 ${job.filesScanned.toLocaleString()} / ${job.filesTotal.toLocaleString()}${typeof job.percent === 'number' ? ` (${job.percent}%)` : ''}`
                            : ''
                    ].filter((s) => s.length > 0);
                    setSyncLoadingDetail(diskProgressLines.length > 0 ? diskProgressLines.join('\n') : '');
                    if (job.status === 'done') break;
                    if (job.status === 'error') {
                        alert(String(job.error || job.message || '디스크 동기화에 실패했습니다.'));
                        return;
                    }
                }
            }
            setSyncLoadingDetail('목록 갱신 중…');
            await Storage.stopTaskListBackgroundDrain();
            await Storage.initStorage({ fullTaskSync: true });
            Storage.invalidateProjectOverviewCache();
            invalidateProjectDetailCache();
            setWorkerOverviewRefreshKey((k) => k + 1);
            refreshTasks();
        } finally {
            setSyncLoadingDetail('');
            setIsDataLoading(false);
        }
    };

    const handleSyncProject = async (projectId: string) => {
        setIsDataLoading(true);
        try {
            const syncRes = await fetch(
                apiUrl(`/api/sync?projectId=${encodeURIComponent(projectId)}`),
                { method: 'POST' }
            );
            if (!syncRes.ok) {
                const errBody = (await syncRes.json().catch(() => null)) as { error?: string } | null;
                alert(typeof errBody?.error === 'string' ? errBody.error : `프로젝트 스캔 실패 (${syncRes.status})`);
                return;
            }
            const syncBody = (await syncRes.json().catch(() => ({}))) as {
                async?: boolean;
                jobId?: string;
            };
            if (syncBody.async === true && typeof syncBody.jobId === 'string' && syncBody.jobId.trim()) {
                const jobId = syncBody.jobId.trim();
                const deadline = Date.now() + 4 * 60 * 60 * 1000;
                setSyncLoadingDetail('서버: 프로젝트 매핑 폴더 동기화 진행 중…');
                for (;;) {
                    if (Date.now() > deadline) {
                        alert(
                            '동기화 진행 확인 시간(4시간)이 초과되었습니다. 서버 로그를 확인한 뒤 필요하면 다시 시도해 주세요.'
                        );
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 450));
                    const st = await fetch(apiUrl(`/api/sync/job/${encodeURIComponent(jobId)}`));
                    const job = (await st.json().catch(() => ({}))) as {
                        status?: string;
                        message?: string;
                        error?: string;
                        filesScanned?: number;
                        filesTotal?: number;
                        percent?: number;
                    };
                    if (!st.ok) {
                        alert(String(job.error || st.statusText || '진행 상태를 가져오지 못했습니다.'));
                        return;
                    }
                    const lines = [
                        '서버: 디스크 → DB (프로젝트 매핑 폴더)',
                        typeof job.message === 'string' && job.message ? job.message : '',
                        typeof job.filesTotal === 'number' &&
                        job.filesTotal > 0 &&
                        typeof job.filesScanned === 'number'
                            ? `이미지 ${job.filesScanned.toLocaleString()} / ${job.filesTotal.toLocaleString()}${typeof job.percent === 'number' ? ` (${job.percent}%)` : ''}`
                            : ''
                    ].filter((s) => s.length > 0);
                    setSyncLoadingDetail(lines.join('\n'));
                    if (job.status === 'done') break;
                    if (job.status === 'error') {
                        alert(String(job.error || job.message || '프로젝트 동기화에 실패했습니다.'));
                        return;
                    }
                }
            }
            await Storage.stopTaskListBackgroundDrain();
            await Storage.syncTasksDelta();
            Storage.invalidateProjectOverviewCache();
            invalidateProjectDetailCache();
            setWorkerOverviewRefreshKey((k) => k + 1);
            refreshTasks();
        } finally {
            setSyncLoadingDetail('');
            setIsDataLoading(false);
        }
    };

    const handleSyncFolders = async (folders: string[]) => {
        if (folders.length === 0) return;
        setIsDataLoading(true);
        try {
            const params = new URLSearchParams();
            folders.forEach((f) => params.append('folders', f));
            const syncRes = await fetch(apiUrl(`/api/sync?${params.toString()}`), { method: 'POST' });
            if (!syncRes.ok) {
                const errBody = (await syncRes.json().catch(() => null)) as { error?: string } | null;
                alert(typeof errBody?.error === 'string' ? errBody.error : `폴더 스캔 실패 (${syncRes.status})`);
                return;
            }
            const syncBody = (await syncRes.json().catch(() => ({}))) as {
                async?: boolean;
                jobId?: string;
            };
            if (syncBody.async === true && typeof syncBody.jobId === 'string' && syncBody.jobId.trim()) {
                const jobId = syncBody.jobId.trim();
                const deadline = Date.now() + 4 * 60 * 60 * 1000;
                setSyncLoadingDetail('서버: 선택 폴더 동기화 진행 중…');
                for (;;) {
                    if (Date.now() > deadline) {
                        alert(
                            '폴더 동기화 진행 확인 시간(4시간)이 초과되었습니다. 서버 로그를 확인한 뒤 필요하면 다시 시도해 주세요.'
                        );
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 450));
                    const st = await fetch(apiUrl(`/api/sync/job/${encodeURIComponent(jobId)}`));
                    const job = (await st.json().catch(() => ({}))) as {
                        status?: string;
                        message?: string;
                        error?: string;
                        filesScanned?: number;
                        filesTotal?: number;
                        percent?: number;
                    };
                    if (!st.ok) {
                        alert(String(job.error || st.statusText || '진행 상태를 가져오지 못했습니다.'));
                        return;
                    }
                    const lines = [
                        '① 서버: 디스크 → DB (선택 폴더)',
                        typeof job.message === 'string' && job.message ? job.message : '',
                        typeof job.filesTotal === 'number' &&
                        job.filesTotal > 0 &&
                        typeof job.filesScanned === 'number'
                            ? `이미지 ${job.filesScanned.toLocaleString()} / ${job.filesTotal.toLocaleString()}${typeof job.percent === 'number' ? ` (${job.percent}%)` : ''}`
                            : ''
                    ].filter((s) => s.length > 0);
                    setSyncLoadingDetail(lines.join('\n'));
                    if (job.status === 'done') break;
                    if (job.status === 'error') {
                        alert(String(job.error || job.message || '폴더 동기화에 실패했습니다.'));
                        return;
                    }
                }
            }
            await Storage.mergeTasksFromServerForFoldersAfterDiskSync(folders);
            Storage.invalidateProjectOverviewCache();
            invalidateProjectDetailCache();
            setWorkerOverviewRefreshKey((k) => k + 1);
            refreshTasks();

            try {
                const preview = await Storage.pruneDatasetsScope({
                    kind: 'stale_files_under_folders',
                    folders,
                    dryRun: true
                });
                const staleTotal = preview.deletedNative + preview.deletedVlm;
                if (staleTotal > 0) {
                    const okPrune = window.confirm(
                        `선택한 폴더 범위에 디스크에는 없는데 DB에만 남아 있는 작업이 있습니다.\n네이티브 ${preview.deletedNative}건, VLM ${preview.deletedVlm}건\n\n이 작업들을 DB에서 삭제할까요?\n삭제 후에는 되돌리기 어렵습니다.`
                    );
                    if (okPrune) {
                        await Storage.pruneDatasetsScope({
                            kind: 'stale_files_under_folders',
                            folders,
                            dryRun: false
                        });
                        await Storage.syncTasksDelta();
                        invalidateProjectDetailCache();
                        setWorkerOverviewRefreshKey((k) => k + 1);
                        refreshTasks();
                        alert('DB에서 고아 작업을 정리했습니다.');
                    }
                }
            } catch (e) {
                console.error('stale prune preview/execute:', e);
            }
        } finally {
            setSyncLoadingDetail('');
            setIsDataLoading(false);
        }
    };

    const handleAdoptFolders = async (
        paths: string[],
        projectId: string,
        assignedWorker?: string | null
    ) => {
        if (paths.length === 0 || !projectId) return;
        setIsDataLoading(true);
        const started = Date.now();
        const pathSummary =
            paths.length <= 2 ? paths.map((p) => String(p || '').replace(/\\/g, '/')).join(', ') : `${paths.length}개 경로`;
        const fmtElapsed = () => {
            const sec = Math.floor((Date.now() - started) / 1000);
            const mm = Math.floor(sec / 60);
            const ss = String(sec % 60).padStart(2, '0');
            return `${mm}:${ss}`;
        };
        try {
            setSyncLoadingDetail(`등록 요청 전송 중…\n경로: ${pathSummary}`);
            const body: { paths: string[]; projectId: string; assignedWorker?: string } = { paths, projectId };
            const w = assignedWorker != null ? String(assignedWorker).trim() : '';
            if (w) body.assignedWorker = w;
            const res = await fetch(apiUrl('/api/datasets/adopt'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = (await res.json().catch(() => ({}))) as {
                error?: string;
                async?: boolean;
                jobId?: string;
                syncedPaths?: string[];
                missingPaths?: string[];
            };
            if (!res.ok) {
                alert(typeof data.error === 'string' ? data.error : '등록·스캔에 실패했습니다.');
                return;
            }

            /** 서버(YOLO_API_STUDIO)는 비동기 job + filesScanned 폴링으로 진행 표시 */
            if (data.async === true && typeof data.jobId === 'string' && data.jobId.trim()) {
                const jobId = data.jobId.trim();
                const deadline = Date.now() + 4 * 60 * 60 * 1000;
                for (;;) {
                    if (Date.now() > deadline) {
                        alert(
                            '서버 등록 작업 확인 시간(4시간)이 초과되었습니다.\n서버 로그에서 작업이 끝났는지 확인한 뒤, 필요하면 DB 새로고침을 해 주세요.'
                        );
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 450));
                    const st = await fetch(apiUrl(`/api/sync/job/${encodeURIComponent(jobId)}`));
                    const job = (await st.json().catch(() => ({}))) as {
                        status?: string;
                        message?: string;
                        error?: string;
                        filesScanned?: number;
                        filesTotal?: number;
                        percent?: number;
                        phase?: string;
                    };
                    if (!st.ok) {
                        alert(String(job.error || st.statusText || '진행 상태를 가져오지 못했습니다.'));
                        return;
                    }
                    const scanLine =
                        typeof job.filesTotal === 'number' &&
                        job.filesTotal > 0 &&
                        typeof job.filesScanned === 'number'
                            ? `이미지 ${job.filesScanned.toLocaleString()} / ${job.filesTotal.toLocaleString()}${typeof job.percent === 'number' ? ` (${job.percent}%)` : ''} · PostgreSQL은 약 150건 단위로 갱신`
                            : typeof job.filesScanned === 'number' && job.filesScanned > 0
                              ? `누적 처리 이미지: ${job.filesScanned.toLocaleString()}건`
                              : '';
                    setSyncLoadingDetail(
                        [
                            '① 서버: 프로젝트 등록·디스크 → DB 반영',
                            typeof job.message === 'string' && job.message ? job.message : '',
                            scanLine,
                            `경과 ${fmtElapsed()}`,
                            `경로: ${pathSummary}`,
                            '',
                            '탭을 닫지 마세요. SQLite는 스캔 중에는 중간 진행률이 없고, 선행 카운트 후 완료 시 건수가 표시됩니다.'
                        ]
                            .filter((line) => line.length > 0)
                            .join('\n')
                    );
                    if (job.status === 'done') break;
                    if (job.status === 'error') {
                        alert(String(job.error || job.message || '등록·스캔에 실패했습니다.'));
                        return;
                    }
                }
            }

            const mergePaths =
                Array.isArray(data.syncedPaths) && data.syncedPaths.length > 0 ? data.syncedPaths : paths;
            setSyncLoadingDetail(
                [
                    '② 브라우저: 작업 목록 캐시에 합치는 중',
                    '(폴더별로 서버에서 페이지를 가져옵니다)',
                    `경로: ${pathSummary}`,
                    `경과 ${fmtElapsed()} · 대용량이면 추가로 수십 분 걸릴 수 있습니다`
                ].join('\n')
            );
            await Storage.mergeTasksFromServerForFoldersAfterDiskSync(mergePaths);
            Storage.invalidateProjectOverviewCache();
            invalidateProjectDetailCache();
            setWorkerOverviewRefreshKey((k) => k + 1);
            refreshTasks();

            const missing = Array.isArray(data.missingPaths) ? data.missingPaths : [];
            if (missing.length > 0) {
                const lines = missing.slice(0, 12).join('\n');
                const more = missing.length > 12 ? `\n… 외 ${missing.length - 12}개` : '';
                const okPrune = window.confirm(
                    `다음 경로는 datasets 아래에 없습니다.\n${lines}${more}\n\nDB에 남아 있는 해당 경로 접두의 작업(네이티브·VLM)을 삭제할까요?\n삭제 후에는 되돌리기 어렵습니다.`
                );
                if (okPrune) {
                    try {
                        await Storage.pruneDatasetsScope({ kind: 'missing_folder_roots', paths: missing });
                        await Storage.syncTasksDelta();
                        invalidateProjectDetailCache();
                        setWorkerOverviewRefreshKey((k) => k + 1);
                        refreshTasks();
                        alert('요청한 경로 기준 DB 정리를 반영했습니다.');
                    } catch (e) {
                        alert(e instanceof Error ? e.message : String(e));
                    }
                }
            }
        } finally {
            setSyncLoadingDetail('');
            setIsDataLoading(false);
        }
    };

    const handleLightRefresh = async () => {
        setIsDataLoading(true);
        try {
            await Storage.stopTaskListBackgroundDrain();
            // 작업자: 전량 /api/datasets 루프(resyncTasksFromServerFull) 금지 — 초기 배치·델타만 + overview 재조회
            if (user?.accountType !== AccountType.ADMIN) {
                Storage.clearTaskCache();
                Storage.invalidateProjectOverviewCache();
                await Storage.initStorage();
                setWorkerOverviewRefreshKey((k) => k + 1);
            } else {
                await Storage.initStorage({ fullTaskSync: true });
            }
            refreshTasks();
        } finally {
            setIsDataLoading(false);
        }
    };

    const queueSelectOptions = useMemo((): SelectTaskOptions | undefined => {
        if (currentUserRole !== UserRole.REVIEWER || reviewerNavMode !== 'queue' || !reviewerScopeWorker) return undefined;
        const o: SelectTaskOptions = {
            reviewerScopeWorker,
            reviewerNavMode: 'queue',
            reviewerQueueFilter
        };
        if (reviewerQueueProjectId != null && reviewerQueueProjectId !== '') {
            o.reviewerQueueProjectId = reviewerQueueProjectId;
        }
        return o;
    }, [currentUserRole, reviewerNavMode, reviewerScopeWorker, reviewerQueueFilter, reviewerQueueProjectId]);

    const handleTaskSelect = useCallback(async (taskId: string, options?: SelectTaskOptions) => {
        if (!user) return;
        const seq = ++taskSelectSeqRef.current;
        const task = await Storage.getTaskById(taskId);
        if (taskSelectSeqRef.current !== seq) return;
        if (task) {
            setCurrentTask(task);
            setStartTime(Date.now());
            if (currentUserRole === UserRole.REVIEWER) {
                if (options?.reviewerNavMode === 'queue' && String(options.reviewerScopeWorker || '').trim()) {
                    setReviewerNavMode('queue');
                    setReviewerQueueFilter(options.reviewerQueueFilter ?? 'pending');
                    setReviewerScopeWorker(String(options.reviewerScopeWorker).trim());
                    const qp = options.reviewerQueueProjectId;
                    setReviewerQueueProjectId(
                        qp != null && String(qp).trim() !== '' ? String(qp).trim() : null
                    );
                } else {
                    setReviewerNavMode('folder');
                    setReviewerQueueProjectId(null);
                    if (options && Object.prototype.hasOwnProperty.call(options, 'reviewerScopeWorker')) {
                        setReviewerScopeWorker(options.reviewerScopeWorker ?? null);
                    } else {
                        const w = String(task.assignedWorker || '').trim();
                        setReviewerScopeWorker(w || null);
                    }
                }
            }
            if (currentUserRole === UserRole.WORKER) {
                Storage.logAction(taskId, user.username, currentUserRole, 'START');
                if (task.status === TaskStatus.TODO) {
                    await Storage.updateTask(taskId, { status: TaskStatus.IN_PROGRESS }, user.username, currentUserRole);
                    if (taskSelectSeqRef.current === seq) refreshTasks();
                }
            }
        }
    }, [currentUserRole, user]);

    const reviewerPickAdjacentTask = useCallback(async (
        direction: 'NEXT' | 'PREV',
        validStatuses: TaskStatus[],
        scopeTask: Task,
        prePendingQueueSnapshot: Task[] | null
    ): Promise<Task | null> => {
        if (!(currentUserRole === UserRole.REVIEWER && reviewerNavMode === 'queue' && reviewerScopeWorker)) {
            return findNextTaskWithFolderHydration(direction, validStatuses, {
                currentId: scopeTask.id,
                currentFolder: scopeTask.folder,
                relevantFilter: (t) =>
                    currentUserRole === UserRole.REVIEWER
                        ? reviewerMatchesAssignedScope(t, scopeTask)
                        : t.assignedWorker === user!.username
            }, () => setTasks(Storage.getTasks()));
        }
        const ws = reviewerScopeWorker;
        if (reviewerQueueFilter === 'pending' && prePendingQueueSnapshot) {
            const neighbor = findNeighborReviewerQueueFromSnapshot(prePendingQueueSnapshot, scopeTask.id, direction);
            if (neighbor) {
                let t = Storage.getTasks().find((x) => x.id === neighbor.id) ?? null;
                if (!t) {
                    await hydrateReviewerQueueCache(ws, reviewerQueueProjectId);
                    setTasks(Storage.getTasks());
                    t = Storage.getTasks().find((x) => x.id === neighbor.id) ?? null;
                }
                if (t) return t;
            } else {
                await hydrateReviewerQueueCache(ws, reviewerQueueProjectId);
                setTasks(Storage.getTasks());
            }
            return findAdjacentReviewerQueueFromAnchor(
                Storage.getTasks(),
                scopeTask,
                direction,
                validStatuses,
                ws,
                'pending',
                reviewerQueueProjectId
            );
        }
        let t = findAdjacentReviewerQueue(
            Storage.getTasks(),
            scopeTask.id,
            direction,
            validStatuses,
            ws,
            reviewerQueueFilter,
            reviewerQueueProjectId
        );
        if (!t) {
            await hydrateReviewerQueueCache(ws, reviewerQueueProjectId);
            setTasks(Storage.getTasks());
            t = findAdjacentReviewerQueue(
                Storage.getTasks(),
                scopeTask.id,
                direction,
                validStatuses,
                ws,
                reviewerQueueFilter,
                reviewerQueueProjectId
            );
        }
        return t;
    }, [currentUserRole, reviewerNavMode, reviewerQueueFilter, reviewerQueueProjectId, reviewerScopeWorker, user]);

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
        setReviewerNavMode('folder');
        setReviewerQueueFilter('pending');
        setReviewerQueueProjectId(null);
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
            const scopeTask = currentTask;
            const validStatusesAll = Object.values(TaskStatus);
            let prePendingSnap: Task[] | null = null;
            if (
                currentUserRole === UserRole.REVIEWER &&
                reviewerNavMode === 'queue' &&
                reviewerScopeWorker &&
                reviewerQueueFilter === 'pending'
            ) {
                prePendingSnap = buildReviewerQueueList(
                    Storage.getTasks(),
                    reviewerScopeWorker,
                    'pending',
                    validStatusesAll,
                    reviewerQueueProjectId
                );
            }
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
            // Update local tasks immediately after issue creation to reflect ISSUE_PENDING status
            await refreshTasks();
            
            // Sync currentTask state to reflect the new ISSUE_PENDING status immediately
            const updated = Storage.getTasks().find(t => t.id === currentTask.id);
            if (updated) setCurrentTask(updated);

            // Auto-move to NEXT if navigation is possible (폴더 보강 후 재시도)
            const targetTask = await reviewerPickAdjacentTask('NEXT', validStatusesAll, scopeTask, prePendingSnap);
            if (targetTask) {
                handleTaskSelect(targetTask.id, queueSelectOptions);
                setJumpIndex('');
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
    }, [currentTask, user, issueRequestType, selectedIssueReason, currentUserRole, reviewerNavMode, reviewerQueueFilter, reviewerQueueProjectId, reviewerScopeWorker, reviewerPickAdjacentTask, handleTaskSelect, queueSelectOptions]);

    const navigateTask = useCallback(async (direction: 'NEXT' | 'PREV', validStatuses: TaskStatus[]) => {
        if (!currentTask || !user) return;

        // SYNC BEFORE MOVE
        const duration = (Date.now() - startTime) / 1000;
        if (currentTask.isModified || duration >= 3) {
            Storage.logAction(currentTask.id, user.username, currentUserRole, 'SAVE', duration, currentTask.isModified === true);
        }
        await Storage.syncTaskToServer(currentTask.id);

        const targetTask = await reviewerPickAdjacentTask(direction, validStatuses, currentTask, null);

        if (targetTask) {
            handleTaskSelect(targetTask.id, queueSelectOptions);
            setJumpIndex('');
        } else {
            if (direction === 'NEXT') {
                // alert("End of folder.");
            } else {
                alert("Start of folder.");
            }
        }
    }, [currentTask, startTime, currentUserRole, user, handleTaskSelect, reviewerPickAdjacentTask, queueSelectOptions]);

    const handleJumpToIndex = useCallback(async (index: number) => {
        if (!currentTask || !user) return;
        if (currentUserRole === UserRole.REVIEWER && reviewerNavMode === 'queue' && reviewerScopeWorker) {
            const validStatuses = Object.values(TaskStatus);
            const buildQueue = () =>
                buildReviewerQueueList(
                    Storage.getTasks(),
                    reviewerScopeWorker,
                    reviewerQueueFilter,
                    validStatuses,
                    reviewerQueueProjectId
                );
            let queueTasks = buildQueue();
            if (queueTasks.length === 0 || index > queueTasks.length) {
                await hydrateReviewerQueueCache(reviewerScopeWorker, reviewerQueueProjectId);
                setTasks(Storage.getTasks());
                queueTasks = buildQueue();
            }
            const targetIndex = Math.max(0, Math.min(index - 1, queueTasks.length - 1));
            const targetTask = queueTasks[targetIndex];
            if (targetTask && targetTask.id !== currentTask.id) {
                handleTaskSelect(targetTask.id, queueSelectOptions);
                setJumpIndex('');
            }
            return;
        }
        const buildFolderTasks = () => {
            const relevantFilter = (t: Task) =>
                currentUserRole === UserRole.REVIEWER
                    ? reviewerMatchesAssignedScope(t, currentTask)
                    : t.assignedWorker === user.username;
            const folderTasks = collectFolderNavTasks(currentTask.folder, relevantFilter);
            const isVlm = currentTask.sourceType === 'vlm-review';
            folderTasks.sort((a, b) => (isVlm ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true })));
            return folderTasks;
        };
        let folderTasks = buildFolderTasks();
        if (folderTasks.length === 0 || index > folderTasks.length) {
            await Storage.fetchAndMergeTasksByFolder(currentTask.folder);
            setTasks(Storage.getTasks());
            folderTasks = buildFolderTasks();
        }

        const targetIndex = Math.max(0, Math.min(index - 1, folderTasks.length - 1));
        const targetTask = folderTasks[targetIndex];

        if (targetTask && targetTask.id !== currentTask.id) {
            // SILENT NAVIGATION: Stop saving/syncing on jump/slider
            handleTaskSelect(targetTask.id, queueSelectOptions);
            setJumpIndex('');
        }
    }, [currentTask, currentUserRole, user, handleTaskSelect, reviewerNavMode, reviewerScopeWorker, reviewerQueueFilter, reviewerQueueProjectId, queueSelectOptions]);

    const handleSubmit = useCallback(async (direction: 'NEXT' | 'PREV' = 'NEXT') => {
        if (!currentTask || !user) return;

        if (currentTask.status === TaskStatus.ISSUE_PENDING) {
            // Navigation-only move for locked tasks
            const validStatuses = Object.values(TaskStatus);
            const targetTask = await findNextTaskWithFolderHydration(direction, validStatuses, {
                currentId: currentTask.id,
                currentFolder: currentTask.folder,
                relevantFilter: (t) => t.assignedWorker === user.username
            }, () => setTasks(Storage.getTasks()));
            if (targetTask) {
                handleTaskSelect(targetTask.id);
                setJumpIndex('');
            } else {
                alert(direction === 'NEXT' ? "This is the last task." : "This is the first task.");
            }
            return;
        }

        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTaskLocally(currentTask.id, { status: TaskStatus.SUBMITTED });

        // Single robust sync
        await Storage.syncTaskToServer(currentTask.id);

        Storage.logAction(currentTask.id, user.username, currentUserRole, 'SUBMIT', duration, currentTask.isModified === true);

        setTasks(Storage.getTasks());

        const validStatuses = Object.values(TaskStatus);
        const targetTask = await findNextTaskWithFolderHydration(direction, validStatuses, {
            currentId: currentTask.id,
            currentFolder: currentTask.folder,
            relevantFilter: (t) => t.assignedWorker === user.username
        }, () => setTasks(Storage.getTasks()));

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
    }, [currentTask, startTime, currentUserRole, handleTaskSelect, user]);

    const handleSubmitCurrentOnly = useCallback(async () => {
        if (!currentTask || !user) return;
        if (currentTask.status === TaskStatus.ISSUE_PENDING) {
            alert("이슈 처리 중인 태스크는 제출할 수 없습니다.");
            return;
        }
        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTaskLocally(currentTask.id, { status: TaskStatus.SUBMITTED });
        await Storage.syncTaskToServer(currentTask.id);
        Storage.logAction(currentTask.id, user.username, currentUserRole, 'SUBMIT', duration, currentTask.isModified === true);
        const allTasks = Storage.getTasks();
        setTasks(allTasks);
        const updated = allTasks.find(t => t.id === currentTask.id);
        if (updated) setCurrentTask(updated);
    }, [currentTask, startTime, currentUserRole, user]);

    const handleReview = useCallback(async (approved: boolean, direction: 'NEXT' | 'PREV' | null = null) => {
        if (!currentTask || !user) return;
        const scopeTask = currentTask;
        const newStatus = approved ? TaskStatus.APPROVED : TaskStatus.REJECTED;

        const validStatuses = Object.values(TaskStatus);
        let prePendingSnap: Task[] | null = null;
        if (
            currentUserRole === UserRole.REVIEWER &&
            reviewerNavMode === 'queue' &&
            reviewerScopeWorker &&
            reviewerQueueFilter === 'pending' &&
            direction
        ) {
            prePendingSnap = buildReviewerQueueList(
                Storage.getTasks(),
                reviewerScopeWorker,
                'pending',
                validStatuses,
                reviewerQueueProjectId
            );
        }

        const duration = (Date.now() - startTime) / 1000;
        await Storage.updateTaskLocally(currentTask.id, { status: newStatus });
        await Storage.syncTaskToServer(currentTask.id);
        Storage.logAction(currentTask.id, user.username, currentUserRole, approved ? 'APPROVE' : 'REJECT', duration);

        setTasks(Storage.getTasks());

        if (!direction) {
            alert(approved ? "Task Approved" : "Task Rejected");
            return;
        }

        const targetTask = await reviewerPickAdjacentTask(direction, validStatuses, scopeTask, prePendingSnap);

        if (targetTask) {
            handleTaskSelect(targetTask.id, queueSelectOptions);
            setJumpIndex('');
        } else {
            const queueEnd =
                currentUserRole === UserRole.REVIEWER &&
                reviewerNavMode === 'queue' &&
                Boolean(reviewerScopeWorker?.trim());
            if (direction === 'NEXT') {
                alert(queueEnd ? '검수 큐에서 더 이상 다음 작업이 없습니다.' : 'This is the last task in the folder.');
            } else {
                alert(queueEnd ? '검수 큐에서 더 이상 이전 작업이 없습니다.' : 'This is the first task in the folder.');
            }
        }
    }, [currentTask, startTime, currentUserRole, handleTaskSelect, handleCloseTask, user, reviewerNavMode, reviewerQueueFilter, reviewerQueueProjectId, reviewerScopeWorker, reviewerPickAdjacentTask, queueSelectOptions]);

    const workflowType: PluginSourceType = useMemo(() => {
        const st = currentTask?.sourceType ?? 'native-yolo';
        if (st === 'vlm-review') return 'vlm-review';
        if (st === 'image-classification') return 'image-classification';
        if (folderMappedToClassification && st === 'native-yolo') return 'image-classification';
        return st as PluginSourceType;
    }, [currentTask?.sourceType, folderMappedToClassification]);

    const workflowUiConfig = WORKFLOW_CONFIG[workflowType];
    const isVlmTask = workflowType === 'vlm-review';
    const isClassificationTask = workflowType === 'image-classification';

    const yoloClassBoxCounts = useMemo(() => {
        const m = new Map<number, number>();
        const ann = currentTask?.annotations;
        if (!ann?.length) return m;
        for (const b of ann) {
            m.set(b.classId, (m.get(b.classId) ?? 0) + 1);
        }
        return m;
    }, [currentTask?.id, currentTask?.annotations]);

    /** 이미지(태스크) 바뀔 때마다: 선택된 분류 id만 갱신 (서버 호출 없음) */
    useEffect(() => {
        if (!currentTask || !isClassificationTask) {
            setClassificationSelectedClassId(null);
            return;
        }
        try {
            const raw = currentTask.sourceData;
            const parsed = raw ? (() => { try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : null; } catch (_) { return null; } })() : null;
            const classId = parsed?.classId ?? null;
            setClassificationSelectedClassId(classId);
        } catch (_) {
            setClassificationSelectedClassId(null);
        }
    }, [currentTask?.id, currentTask?.sourceData, isClassificationTask]);

    /**
     * 분류 클래스: overview → (비면) overview 강제 재조회 → (비면) GET /api/projects 폴백.
     * 빈 배열은 ref에 넣지 않음(프로젝트 수정 후에도 빈 목록이 캐시에 고정되는 문제 방지).
     * 프로젝트 저장·overview 무효화 시 epoch으로 이 effect가 다시 돈다.
     */
    useEffect(() => {
        if (!currentTask || !isClassificationTask) {
            setClassificationClassesForPanel([]);
            return;
        }
        const folder = currentTask.folder;
        const cache = classificationClassesByFolderRef.current;
        const cachedPositive = cache.get(folder);
        if (cachedPositive !== undefined && cachedPositive.length > 0) {
            setClassificationClassesForPanel(cachedPositive);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                let overview = await Storage.getProjectOverview();
                let projectId = resolveProjectMapEntryForFolder(folder, overview.projectMap || {})?.projectId;
                if (!projectId || cancelled) {
                    if (!cancelled) setClassificationClassesForPanel([]);
                    return;
                }
                let projectRow = overview.projects?.find((p) => String(p.id) === String(projectId));
                let classes = mapRawOverviewClassesToYolo(projectRow?.classificationClasses);
                if (classes.length === 0 && !cancelled) {
                    overview = await Storage.getProjectOverview(true);
                    projectId = resolveProjectMapEntryForFolder(folder, overview.projectMap || {})?.projectId;
                    if (!projectId || cancelled) {
                        if (!cancelled) setClassificationClassesForPanel([]);
                        return;
                    }
                    projectRow = overview.projects?.find((p) => String(p.id) === String(projectId));
                    classes = mapRawOverviewClassesToYolo(projectRow?.classificationClasses);
                }
                if (classes.length === 0 && !cancelled) {
                    const list = await Storage.getProjects();
                    const def = list.find((p) => String(p.id) === String(projectId));
                    classes = mapRawOverviewClassesToYolo(def?.classificationClasses);
                }
                if (!cancelled) {
                    if (classes.length > 0) {
                        cache.set(folder, classes);
                    } else {
                        cache.delete(folder);
                    }
                    setClassificationClassesForPanel(classes);
                }
            } catch (_e) {
                if (!cancelled) setClassificationClassesForPanel([]);
            }
        })();
        return () => { cancelled = true; };
    }, [currentTask?.folder, isClassificationTask, classificationOverviewEpoch]);

    const handleClassificationSave = useCallback(async (classId: number | null) => {
        if (!currentTask || !user) return;
        const updates: Partial<Task> = { isModified: true, sourceType: 'image-classification' };
        if (classId != null) updates.sourceData = JSON.stringify({ classId });
        await Storage.updateTask(currentTask.id, updates, user.username, currentUserRole);
        const updated = Storage.getTasks().find(t => t.id === currentTask.id) || currentTask;
        setCurrentTask({
            ...updated,
            sourceType: 'image-classification',
            ...(classId != null ? { sourceData: updates.sourceData as string } : {})
        });
        setTasks(Storage.getTasks());
    }, [currentTask, user, currentUserRole]);

    const mergeVlmPayloadIntoSourceData = useCallback((task: Task, payload: VlmDraftPayload): string => {
        let parsed: Record<string, unknown> = {};
        try {
            if (typeof task.sourceData === 'string' && task.sourceData) parsed = JSON.parse(task.sourceData);
            else if (task.sourceData && typeof task.sourceData === 'object') parsed = task.sourceData as Record<string, unknown>;
        } catch (_) { }
        const rawResultData = (parsed.rawResultData as Record<string, unknown>) || {};
        return JSON.stringify({
            ...parsed,
            ui: { reviewResult: payload.reviewResult, dueDate: payload.dueDate, editedGptResponse: payload.gptResponse },
            rawResultData: { ...rawResultData, reviewResult: payload.reviewResult, editedAnswer: payload.gptResponse }
        });
    }, []);

    const handleVlmSaveDraft = useCallback(async (payload: VlmDraftPayload) => {
        if (!currentTask || !user) return;
        const sourceData = mergeVlmPayloadIntoSourceData(currentTask, payload);
        await Storage.updateTask(currentTask.id, { sourceData, reviewerNotes: payload.note, isModified: true }, user.username, currentUserRole);
        const updated = Storage.getTasks().find(t => t.id === currentTask.id) || currentTask;
        setCurrentTask({ ...updated, sourceData, reviewerNotes: payload.note });
        setTasks(Storage.getTasks());
    }, [currentTask, user, currentUserRole, mergeVlmPayloadIntoSourceData]);

    const handleVlmSubmitCurrent = useCallback(async (payload: VlmDraftPayload) => {
        if (!currentTask || !user) return;

        if (currentTask.status === TaskStatus.ISSUE_PENDING) {
            alert("이슈 처리 중인 태스크는 제출할 수 없습니다.");
            return;
        }

        const duration = (Date.now() - startTime) / 1000;
        const sourceData = mergeVlmPayloadIntoSourceData(currentTask, payload);
        let newStatus = TaskStatus.SUBMITTED;
        if (currentUserRole === UserRole.REVIEWER) {
            newStatus = TaskStatus.APPROVED;
        }
        await Storage.updateTask(currentTask.id, { sourceData, reviewerNotes: payload.note, status: newStatus, isModified: true }, user.username, currentUserRole);
        Storage.logAction(currentTask.id, user.username, currentUserRole, newStatus === TaskStatus.APPROVED ? 'APPROVE' : 'SUBMIT', duration, true);
        const allTasks = Storage.getTasks();
        setTasks(allTasks);
        const updated = allTasks.find(t => t.id === currentTask.id);
        if (updated) setCurrentTask(updated);
    }, [currentTask, user, currentUserRole, startTime, mergeVlmPayloadIntoSourceData]);

    const handleVlmSubmitMove = useCallback(async (payload: VlmDraftPayload, direction: 'NEXT' | 'PREV') => {
        if (!currentTask || !user) return;
        if (vlmSubmitInFlightRef.current) return;
        vlmSubmitInFlightRef.current = true;
        const taskId = currentTask.id;
        const scopeTask = currentTask;
        try {
            const validStatuses = Object.values(TaskStatus);
            let prePendingSnap: Task[] | null = null;
            if (
                currentUserRole === UserRole.REVIEWER &&
                reviewerNavMode === 'queue' &&
                reviewerScopeWorker &&
                reviewerQueueFilter === 'pending'
            ) {
                prePendingSnap = buildReviewerQueueList(
                    Storage.getTasks(),
                    reviewerScopeWorker,
                    'pending',
                    validStatuses,
                    reviewerQueueProjectId
                );
            }
            if (currentTask.status === TaskStatus.ISSUE_PENDING) {
                const targetTask = await reviewerPickAdjacentTask(direction, validStatuses, scopeTask, prePendingSnap);
                if (targetTask) {
                    handleTaskSelect(targetTask.id, queueSelectOptions);
                    setJumpIndex('');
                } else {
                    const queueEnd =
                        currentUserRole === UserRole.REVIEWER &&
                        reviewerNavMode === 'queue' &&
                        Boolean(reviewerScopeWorker?.trim());
                    alert(
                        direction === 'NEXT'
                            ? queueEnd
                                ? '검수 큐에서 더 이상 다음 작업이 없습니다.'
                                : 'This is the last task.'
                            : queueEnd
                              ? '검수 큐에서 더 이상 이전 작업이 없습니다.'
                              : 'This is the first task.'
                    );
                }
                return;
            }

            const duration = (Date.now() - startTime) / 1000;
            const sourceData = mergeVlmPayloadIntoSourceData(currentTask, payload);
            let newStatus = TaskStatus.SUBMITTED;
            if (currentUserRole === UserRole.REVIEWER) {
                newStatus = TaskStatus.APPROVED;
            }
            await Storage.updateTask(taskId, { sourceData, reviewerNotes: payload.note, status: newStatus, isModified: true }, user.username, currentUserRole);
            Storage.logAction(taskId, user.username, currentUserRole, newStatus === TaskStatus.APPROVED ? 'APPROVE' : 'SUBMIT', duration, true);
            setTasks(Storage.getTasks());
            const targetTask = await reviewerPickAdjacentTask(direction, validStatuses, scopeTask, prePendingSnap);
            if (targetTask) {
                handleTaskSelect(targetTask.id, queueSelectOptions);
                setJumpIndex('');
            } else {
                const queueEnd =
                    currentUserRole === UserRole.REVIEWER &&
                    reviewerNavMode === 'queue' &&
                    Boolean(reviewerScopeWorker?.trim());
                if (direction === 'NEXT') {
                    alert(queueEnd ? '검수 큐에서 더 이상 다음 작업이 없습니다.' : 'This is the last task in the folder.');
                } else {
                    alert(queueEnd ? '검수 큐에서 더 이상 이전 작업이 없습니다.' : 'This is the first task in the folder.');
                }
            }
        } finally {
            vlmSubmitInFlightRef.current = false;
        }
    }, [currentTask, user, currentUserRole, startTime, handleTaskSelect, mergeVlmPayloadIntoSourceData, reviewerNavMode, reviewerQueueFilter, reviewerQueueProjectId, reviewerScopeWorker, reviewerPickAdjacentTask, queueSelectOptions]);

    // Keyboard Shortcuts for Main App
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            const isCtrlS = e.ctrlKey && key === 's';
            if (isCtrlS) e.preventDefault(); // 항상 브라우저 '페이지 저장' 방지

            if (!currentTask) return;
            const focusOnInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
            if (focusOnInput && !isCtrlS) {
                const isNavOrSave = key === 'a' || key === 'd';
                const isClassKey = key >= '1' && key <= '9';
                if (!(isClassificationTask && (isNavOrSave || isClassKey))) return;
            }

            // Toggle All Visibility: '`'
            if (e.key === '`') {
                e.preventDefault();
                setHiddenClassIds(prev =>
                    prev.length > 0 ? [] : currentClasses.map(c => c.id)
                );
            }

            // W / S: Active class 이전/다음
            if (currentClasses.length > 0 && (key === 'w' || key === 's')) {
                const idx = currentClasses.findIndex(c => c.id === selectedClass?.id);
                if (key === 'w') {
                    if (idx <= 0) setSelectedClass(currentClasses[currentClasses.length - 1]);
                    else setSelectedClass(currentClasses[idx - 1]);
                } else {
                    if (idx < 0 || idx >= currentClasses.length - 1) setSelectedClass(currentClasses[0]);
                    else setSelectedClass(currentClasses[idx + 1]);
                }
            }

            // 1-9 Class Select
            if (key >= '1' && key <= '9') {
                const idx = parseInt(key) - 1;
                if (idx < currentClasses.length) setSelectedClass(currentClasses[idx]);
            }

            if (isVlmTask) {
                if (key === 'a' || key === 'd' || isCtrlS) {
                    if (currentTask.status === TaskStatus.ISSUE_PENDING) return;
                    const direction = key === 'a' ? 'PREV' : 'NEXT';
                    if (vlmDraftRef.current) {
                        handleVlmSubmitMove(vlmDraftRef.current, direction);
                    } else {
                        if (currentUserRole === UserRole.WORKER) handleSubmit(direction);
                        else handleReview(true, direction);
                    }
                    (document.activeElement as HTMLElement)?.blur();
                }
                return;
            }

            if (isClassificationTask) {
                if (key >= '1' && key <= '9') {
                    const idx = parseInt(key, 10) - 1;
                    if (idx >= 0 && classificationClassesForPanel[idx]) {
                        e.preventDefault();
                        const classId = classificationClassesForPanel[idx].id;
                        setClassificationSelectedClassId(classId);
                        classificationDraftRef.current = classId;
                    }
                }
                if (key === 'a' || key === 'd' || isCtrlS) {
                    e.preventDefault();
                    if (currentTask.status === TaskStatus.ISSUE_PENDING) return;
                    const direction = key === 'a' ? 'PREV' : 'NEXT';
                    (async () => {
                        await handleClassificationSave(classificationDraftRef.current);
                        if (currentUserRole === UserRole.WORKER) await handleSubmit(direction);
                        else await handleReview(true, direction);
                    })();
                }
                return;
            }

            if (currentUserRole === UserRole.WORKER) {
                // a - Previous
                if (key === 'a') handleSubmit('PREV');
                // d / Ctrl+S - Next (save and next)
                if (key === 'd' || isCtrlS) handleSubmit('NEXT');
            } else {
                // Reviewer Shortcuts

                // A: Prev (Sequential)
                if (key === 'a') {
                    handleReview(true, 'PREV');
                }

                // D / Ctrl+S: Next (Sequential)
                if (key === 'd' || isCtrlS) {
                    handleReview(true, 'NEXT');
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentTask, handleSubmit, handleReview, handleVlmSubmitMove, handleClassificationSave, isVlmTask, isClassificationTask, currentUserRole, currentClasses, selectedClass, navigateTask, classificationClassesForPanel]);

    const currentFolderStats = useMemo(() => {
        if (!currentTask || !user) return { completed: 0, total: 0, approved: 0 };
        if (currentUserRole === UserRole.REVIEWER && reviewerNavMode === 'queue' && reviewerScopeWorker) {
            const validStatuses = Object.values(TaskStatus);
            const queueTasks = buildReviewerQueueList(
                tasks,
                reviewerScopeWorker,
                reviewerQueueFilter,
                validStatuses,
                reviewerQueueProjectId
            );
            const completed = queueTasks.filter(t => t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED).length;
            const approved = queueTasks.filter(t => t.status === TaskStatus.APPROVED).length;
            return { completed, total: queueTasks.length, approved };
        }
        let folderTasks = tasks.filter(t => t.folder === currentTask.folder);
        if (currentUserRole === UserRole.WORKER) {
            folderTasks = folderTasks.filter(t => t.assignedWorker === user.username);
        } else if (currentUserRole === UserRole.REVIEWER) {
            folderTasks = folderTasks.filter(t => reviewerMatchesAssignedScope(t, currentTask));
        }
        const completed = folderTasks.filter(t => t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED).length;
        const approved = folderTasks.filter(t => t.status === TaskStatus.APPROVED).length;
        return { completed, total: folderTasks.length, approved };
    }, [currentTask, tasks, currentUserRole, user, reviewerNavMode, reviewerScopeWorker, reviewerQueueFilter, reviewerQueueProjectId]);

    const orderedCurrentFolderTasks = useMemo(() => {
        if (!currentTask || !user) return [];
        if (currentUserRole === UserRole.REVIEWER && reviewerNavMode === 'queue' && reviewerScopeWorker) {
            const validStatuses = Object.values(TaskStatus);
            return buildReviewerQueueList(
                tasks,
                reviewerScopeWorker,
                reviewerQueueFilter,
                validStatuses,
                reviewerQueueProjectId
            );
        }
        const relevantTasks = tasks.filter(t =>
            currentUserRole === UserRole.REVIEWER
                ? reviewerMatchesAssignedScope(t, currentTask)
                : t.assignedWorker === user.username
        );
        const inFolder = relevantTasks.filter(t => t.folder === currentTask.folder);
        const isVlm = currentTask.sourceType === 'vlm-review';
        inFolder.sort((a, b) => isVlm ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true }));
        return inFolder;
    }, [tasks, currentTask, currentUserRole, user, reviewerNavMode, reviewerScopeWorker, reviewerQueueFilter, reviewerQueueProjectId]);

    const currentFolderTaskIndex = useMemo(() => {
        if (!currentTask) return -1;
        return orderedCurrentFolderTasks.findIndex(t => t.id === currentTask.id);
    }, [orderedCurrentFolderTasks, currentTask]);

    if (!user) {
        return <Login onLogin={handleLogin} />;
    }

    return (
        <div className="h-screen bg-slate-950 text-slate-100 flex flex-col font-sans overflow-hidden">
            {(isDataLoading || isFolderPrepareLoading) && (
                <LoadingOverlay
                    message={isDataLoading ? '데이터 동기화 중' : '작업 폴더를 불러오는 중'}
                    detail={
                        isDataLoading
                            ? '서버와 동기화하는 중입니다.'
                            : '폴더 내 작업 목록을 가져오는 중입니다. 이미지가 많으면 시간이 걸릴 수 있습니다.'
                    }
                    progressLine={isDataLoading ? syncLoadingDetail : undefined}
                />
            )}
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
                            <div className="relative" ref={guideDropdownRef}>
                                <button
                                    onClick={async () => {
                                        if (showGuidePicker) {
                                            setShowGuidePicker(false);
                                            return;
                                        }

                                        try {
                                            // Always refetch guide list so newly added files appear without page reload.
                                            const res = await fetch(`/guides/list.json?ts=${Date.now()}`, { cache: 'no-store' });
                                            if (res.ok) {
                                                const guides = await res.json();
                                                if (guides.length === 0) {
                                                    alert('No guides available.');
                                                } else {
                                                    setGuideList(guides);
                                                    setShowGuidePicker(true);
                                                }
                                            } else {
                                                // Fallback: if we already have a list in memory, open it.
                                                if (guideList.length > 0) {
                                                    setShowGuidePicker(true);
                                                } else {
                                                    setCurrentPdfUrl('/guides/Worker_Guide_v1.pdf');
                                                    setShowGuide(true);
                                                }
                                            }
                                        } catch (e) {
                                            // Network fallback: use in-memory list if available.
                                            if (guideList.length > 0) {
                                                setShowGuidePicker(true);
                                            } else {
                                                setCurrentPdfUrl('/guides/Worker_Guide_v1.pdf');
                                                setShowGuide(true);
                                            }
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
                                {user.accountType === AccountType.ADMIN && (
                                    <button
                                        onClick={() => setShowAdminGuide(true)}
                                        className="px-4 py-2 hover:text-white hover:bg-slate-800/50 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-slate-400"
                                    >
                                        <span>관리자 가이드</span>
                                    </button>
                                )}
                                <button
                                    onClick={() => setShowWorkerGuide(true)}
                                    className="px-4 py-2 hover:text-white hover:bg-slate-800/50 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-slate-400"
                                >
                                    <span>작업자 가이드</span>
                                </button>
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        {!currentTask && user.accountType === AccountType.ADMIN && (
                            <div className="flex bg-slate-800 rounded-lg p-1">
                                <button
                                    onClick={() => {
                                        setCurrentUserRole(UserRole.WORKER);
                                        setReviewerScopeWorker(null);
                                    }}
                                    className={`px-5 py-1.5 rounded-md text-sm font-medium transition-all ${currentUserRole === UserRole.WORKER ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                                >
                                    Worker View
                                </button>
                                <button
                                    onClick={() => {
                                        setCurrentUserRole(UserRole.REVIEWER);
                                        setReviewerScopeWorker(null);
                                    }}
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
                <>
                    <div style={{ display: currentTask ? 'none' : 'flex' }} className="flex-1 w-full h-full overflow-hidden">
                        <Dashboard
                            role={currentUserRole}
                            accountType={user.accountType}
                            tasks={tasks}
                            onSelectTask={handleTaskSelect}
                            onRefresh={refreshTasks}
                            onSync={handleSync}
                            onFullDiskSync={handleFullDiskSync}
                            onSyncProject={handleSyncProject}
                            onSyncFolders={handleSyncFolders}
                            onAdoptFolders={
                                user.accountType === AccountType.ADMIN ? handleAdoptFolders : undefined
                            }
                            onLightRefresh={handleLightRefresh}
                            onFolderPrepareLoading={setIsFolderPrepareLoading}
                            username={user.username}
                            openIssueRequestsSignal={openIssueRequestsSignal}
                            workerOverviewRefreshKey={workerOverviewRefreshKey}
                            reviewerScopeWorker={reviewerScopeWorker}
                            onClearReviewerScope={() => setReviewerScopeWorker(null)}
                        />
                    </div>
                    {currentTask ? (
                        <div className="flex w-full h-full">
                            {/* Sidebar (Tools) */}
                            <aside className="w-80 bg-slate-900 border-r border-slate-800 flex flex-col z-20 shadow-2xl">
                                <div className="p-6 border-b border-slate-800">
                                    <button
                                        onClick={handleCloseTask}
                                        className="text-slate-400 hover:text-white flex items-center gap-2 text-sm font-medium mb-4 transition-colors"
                                    >
                                        ← 이전으로
                                    </button>
                                    <h2 className="font-bold text-lg text-white truncate" title={currentTask.name}>{currentTask.name}</h2>
                                    <div className="flex items-center gap-3 mt-3">
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider
                                            ${currentTask.status === TaskStatus.TODO ? 'bg-slate-800 text-slate-400 border-slate-700' : ''}
                                            ${currentTask.status === TaskStatus.IN_PROGRESS ? 'bg-sky-900/30 text-sky-300 border-sky-800/50' : ''}
                                            ${currentTask.status === TaskStatus.SUBMITTED ? 'bg-amber-900/30 text-amber-300 border-amber-800/50' : ''}
                                            ${currentTask.status === TaskStatus.APPROVED ? 'bg-lime-900/30 text-lime-300 border-lime-800/50' : ''}
                                            ${currentTask.status === TaskStatus.REJECTED ? 'bg-rose-900/30 text-rose-300 border-rose-800/50' : ''}
                                            ${currentTask.status === TaskStatus.ISSUE_PENDING ? 'bg-purple-900/30 text-purple-300 border-purple-800/50' : ''}
                                        `}>
                                            {TaskStatusLabels[currentTask.status] || currentTask.status}
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

                                {workflowUiConfig.showYoloSidebar && (
                                    <>
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
                                                        className={`flex-1 flex items-center gap-2.5 px-2 py-1.5 rounded-md border transition-all min-w-0 ${selectedClass?.id === cls.id
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
                                                        <div className="flex items-baseline gap-1.5 min-w-0 flex-1" title={`단축키 ${idx + 1}`}>
                                                            <span className={`text-sm font-medium truncate min-w-0 ${hiddenClassIds.includes(cls.id) ? 'text-slate-600 line-through' : 'text-slate-200'}`}>
                                                                {cls.name}
                                                            </span>
                                                            <span className="shrink-0 text-[10px] font-mono text-slate-500 tabular-nums">
                                                                {idx + 1}
                                                            </span>
                                                        </div>
                                                        <span
                                                            className={`shrink-0 tabular-nums text-xs font-bold leading-none rounded-full px-2 py-0.5 text-right border min-w-[1.35rem] ${(yoloClassBoxCounts.get(cls.id) ?? 0) > 0 ? 'border-white/20 shadow-[0_0_8px_rgba(168,230,27,0.35)]' : 'text-slate-500 border-transparent'}`}
                                                            style={(yoloClassBoxCounts.get(cls.id) ?? 0) > 0 ? { backgroundColor: '#A8E617', color: '#1A1A2E' } : undefined}
                                                            title="현재 이미지 박스 수"
                                                        >
                                                            {yoloClassBoxCounts.get(cls.id) ?? 0}
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
                                                            className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg shadow-sm border border-slate-700 transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                                                            title="제출 & 이전 (A)"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                                            이전
                                                        </button>
                                                        <button
                                                            onClick={() => handleSubmit('NEXT')}
                                                            className="flex-[1.5] py-3 bg-lime-600 hover:bg-lime-500 text-white font-bold rounded-lg shadow-lg transition-transform active:scale-[0.98] text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                                                            title="제출 & 다음 (D)"
                                                        >
                                                            <span>{currentTask.status === TaskStatus.ISSUE_PENDING ? '다음' : '제출 & 다음'}</span>
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
                                    </>
                                )}

                            </aside>

                            {/* Canvas Area with Separate Status Bars */}
                            <div className="flex-1 flex flex-col bg-slate-950 relative overflow-hidden">
                                {workflowUiConfig.showYoloSidebar && (
                                    <>
                                        {/* Top Bar: Current Status & Class (YOLO only) */}
                                        <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 z-30 shadow-md flex-shrink-0">
                                            <div className="flex items-center gap-4">
                                                <span className="text-slate-400 text-sm font-medium">Active Class:</span>
                                                <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700">
                                                    <span className="w-4 h-4 rounded-full" style={{ backgroundColor: selectedClass?.color || '#fff' }}></span>
                                                    <span className="text-white font-bold text-base">{selectedClass?.name || 'None'}</span>
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    <button
                                                        onClick={() => setUndoSignal((prev) => prev + 1)}
                                                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                                                        title="Undo (Ctrl+Z)"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14L4 9m0 0l5-5M4 9h10a6 6 0 010 12h-2" />
                                                        </svg>
                                                    </button>
                                                    <button
                                                        onClick={() => setRedoSignal((prev) => prev + 1)}
                                                        className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                                                        title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 14l5-5m0 0l-5-5m5 5H10a6 6 0 000 12h2" />
                                                        </svg>
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2.5 h-2.5 rounded-full ${currentUserRole === UserRole.WORKER ? 'bg-lime-500 animate-pulse' : 'bg-slate-500'}`}></span>
                                                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                                                    {currentUserRole === UserRole.WORKER ? "Edit Mode" : "View Mode"}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Main Canvas Area (YOLO) */}
                                        <div className="flex-1 relative overflow-hidden bg-black">
                                            <AnnotationCanvas
                                                imageUrl={resolveDatasetPublicUrl(currentTask.imageUrl)}
                                                annotations={currentTask.annotations}
                                                currentClass={selectedClass || { id: -1, name: 'None', color: '#000' }}
                                                classes={currentClasses}
                                                readOnly={false}
                                                onUpdateAnnotations={handleUpdateAnnotations}
                                                hiddenClassIds={hiddenClassIds}
                                                customClassColors={customClassColors}
                                                undoSignal={undoSignal}
                                                redoSignal={redoSignal}
                                            />
                                        </div>
                                    </>
                                )}

                                {isVlmTask && (
                                    <div className="flex-1 relative overflow-hidden bg-slate-950">
                                        <VlmReviewPanel
                                            task={currentTask}
                                            readOnly={currentUserRole === UserRole.REVIEWER ? false : (currentTask.status === TaskStatus.APPROVED)}
                                            workerName={currentTask.assignedWorker || user?.username}
                                            remainingCount={Math.max(0, (orderedCurrentFolderTasks?.length ?? 0) - (currentFolderTaskIndex ?? 0) - 1)}
                                            onRefreshTask={async () => { setTasks(Storage.getTasks()); const t = Storage.getTasks().find(x => x.id === currentTask.id); if (t) setCurrentTask(t); }}
                                            onSaveDraft={handleVlmSaveDraft}
                                            onSubmitCurrent={handleVlmSubmitCurrent}
                                            onSubmitAndNext={(payload) => handleVlmSubmitMove(payload, 'NEXT')}
                                            onDraftChange={handleVlmDraftChange}
                                        />
                                    </div>
                                )}

                                {isClassificationTask && (
                                    <div className="flex-1 relative overflow-hidden bg-slate-950">
                                        <ClassificationPanel
                                            task={currentTask}
                                            classes={classificationClassesForPanel}
                                            selectedClassId={classificationSelectedClassId}
                                            onSelectedClassIdChange={(id) => {
                                                setClassificationSelectedClassId(id);
                                                classificationDraftRef.current = id;
                                            }}
                                            readOnly={currentUserRole === UserRole.REVIEWER ? false : (currentTask.status === TaskStatus.APPROVED)}
                                            remainingCount={Math.max(0, (orderedCurrentFolderTasks?.length ?? 0) - (currentFolderTaskIndex ?? 0) - 1)}
                                            onSave={handleClassificationSave}
                                            onSubmit={handleSubmitCurrentOnly}
                                            onSubmitAndNext={() => handleSubmit('NEXT')}
                                            onDraftChange={(classId) => { classificationDraftRef.current = classId; }}
                                        />
                                    </div>
                                )}

                                {/* Bottom Navigation Control */}
                                <div className="h-24 bg-slate-900 border-t border-slate-800 flex items-center px-8 gap-10 z-30 shadow-lg flex-shrink-0 overflow-hidden min-w-0">
                                    <div className="flex items-center gap-4 min-w-[200px] shrink-0">
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
                                                disabled={false} // Allow jumping even if locked
                                                className="w-28 bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-xl font-bold text-white focus:ring-2 focus:ring-blue-500 outline-none transition-all disabled:opacity-30"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex-1 flex items-center gap-6 min-w-0">
                                        <input
                                            type="range"
                                            min="1"
                                            max={Math.max(orderedCurrentFolderTasks.length, 1)}
                                            value={Math.max(currentFolderTaskIndex, 0) + 1}
                                            disabled={false} // Allow interaction even if locked
                                            onChange={(e) => handleJumpToIndex(parseInt(e.target.value))}
                                            className="flex-1 min-w-0 h-3 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                        />
                                        <div className="text-2xl font-mono text-slate-300 bg-slate-800 px-6 py-2 rounded-xl border border-slate-700 shadow-inner">
                                            <span className="text-white font-black">{Math.max(currentFolderTaskIndex, 0) + 1}</span>
                                            <span className="text-slate-500 mx-2">/</span>
                                            <span className="text-slate-400">{orderedCurrentFolderTasks.length}</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3 text-sm text-slate-500 font-semibold italic shrink-0">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        Press Enter to jump
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : null}
                </>
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

            {/* First-time guides (admin / worker) */}
            {showAdminGuide && (
                <FirstTimeGuideModal title="관리자 가이드" onClose={() => setShowAdminGuide(false)}>
                    <AdminGuideContent />
                </FirstTimeGuideModal>
            )}
            {showWorkerGuide && (
                <FirstTimeGuideModal title="작업자 가이드" onClose={() => setShowWorkerGuide(false)}>
                    <WorkerGuideContent />
                </FirstTimeGuideModal>
            )}
        </div>
    );
};

export default App;
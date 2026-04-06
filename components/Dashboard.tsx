import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Task, TaskStatus, TaskStatusLabels, UserRole, FolderMetadata, AccountType, TaskIssue, TaskIssueStatus, VacationRecord, PluginSourceType, WORKFLOW_LABELS } from '../types';
import * as Storage from '../services/storage';
import { apiUrl, resolveDatasetPublicUrl } from '../services/apiBase';
import { resolveProjectMapEntryForFolder } from '../services/projectMapResolve';
import { resolveWorkerFolderMapEntryForFolder } from '../services/workerFolderMapResolve';
import { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Bar, Line } from 'recharts';
import { toBlob } from 'html-to-image';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { DatasetsFolderTree } from './DatasetsFolderTree';

/** App 검수 범위·내비: 프로젝트 상세 / 검수 큐에서 전달 */
export type SelectTaskOptions = {
    reviewerScopeWorker?: string | null;
    /** queue: 폴더 무관 이전·다음(작업자 배정 큐 순서) */
    reviewerNavMode?: 'folder' | 'queue';
    /** queue 모드에서 목록 필터(검수 큐 패널과 동일) */
    reviewerQueueFilter?: 'pending' | 'all';
    /** queue 모드에서 프로젝트 범위만(검수 큐에서 불러온 범위와 동일) */
    reviewerQueueProjectId?: string | null;
};

interface DashboardProps {
    role: UserRole;
    accountType: AccountType;
    onSelectTask: (taskId: string, options?: SelectTaskOptions) => void;
    onRefresh: () => void;
    onSync: () => Promise<void>;
    /** datasets 전체 디스크 스캔 (느림) — 선택 시에만 */
    onFullDiskSync?: () => Promise<void>;
    onSyncProject?: (projectId: string) => Promise<void>;
    onSyncFolders?: (folders: string[]) => Promise<void>;
    /** datasets adopt + 부분 스캔 — 관리자 프로젝트 개요 디스크 트리 */
    onAdoptFolders?: (
        paths: string[],
        projectId: string,
        assignedWorker?: string | null
    ) => Promise<void>;
    onLightRefresh?: () => Promise<void>;
    /** 분류 폴더 진입 등 대량 fetch 전후로 App 전역 로딩 표시 */
    onFolderPrepareLoading?: (loading: boolean) => void;
    tasks: Task[];
    username: string;
    token?: string;
    openIssueRequestsSignal?: number;
    openUserManagementSignal?: number;
    /** 작업자 목록 새로고침 시 overview 재조회 트리거 */
    workerOverviewRefreshKey?: number;
    /** 검수자: 마지막으로 연 태스크의 배정 작업자 — Work List·폴더 그리드가 해당 작업자만 보이도록 */
    reviewerScopeWorker?: string | null;
    onClearReviewerScope?: () => void;
}

const USER_MANAGEMENT_VIEW = 'USERS';
const WORKER_REPORT_VIEW = 'REPORTS';
const WEEKLY_REPORT_VIEW = 'WEEKLY';
const DAILY_REPORT_VIEW = 'DAILY';
const SCHEDULE_VIEW = 'SCHEDULE';
const ISSUE_REQUEST_VIEW = 'ISSUES';
const PROJECT_OVERVIEW_VIEW = 'PROJECT_OVERVIEW';
const DASHBOARD_HOME_VIEW = 'DASHBOARD_HOME';
const WORK_LIST_VIEW = 'WORK_LIST';
const DATA_IMPORT_EXPORT_VIEW = 'DATA_IMPORT_EXPORT';
const PROJECT_DETAIL_VIEW_PREFIX = 'PROJECT_DETAIL:';
const NOTICE_HOME_VIEW = 'NOTICE_HOME';
/** 관리자 검수자 전용: 작업자 단위 큐(폴더 경계 없음) */
const REVIEW_QUEUE_VIEW = 'REVIEW_QUEUE';

/** Path의 최상위 세그먼트(그룹명). 예: "A/train/B" => "A" */
function getTopLevelGroup(folderPath: string): string {
    const s = String(folderPath || '').trim();
    if (!s) return s;
    const idx = s.indexOf('/');
    return idx === -1 ? s : s.slice(0, idx);
}

/** 그룹(첫 세그먼트) 이후 경로만 표시 */
function folderPathAfterGroup(fullPath: string, group: string): string {
    const s = String(fullPath || '');
    const g = String(group || '');
    if (!g) return s;
    if (s === g) return '—';
    if (s.startsWith(g + '/')) return s.slice(g.length + 1);
    return s;
}

function groupByTopLevel<T>(items: T[], getFolder: (item: T) => string): { groupName: string; items: T[] }[] {
    const map = new Map<string, T[]>();
    items.forEach((item) => {
        const folder = getFolder(item);
        const group = getTopLevelGroup(folder);
        if (!map.has(group)) map.set(group, []);
        map.get(group)!.push(item);
    });
    return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([groupName, items]) => ({
            groupName,
            items: [...items].sort((a, b) => getFolder(a).localeCompare(getFolder(b)))
        }));
}

/** 작업자 매핑 탭 — 폴더 경로 트리 */
type WorkerMapFolderRow = Storage.ProjectOverviewPayload['folders'][number];
type WorkerMapTreeNode = {
    segment: string;
    fullPath: string;
    row: WorkerMapFolderRow | null;
    children: WorkerMapTreeNode[];
};

function buildWorkerFolderTree(rows: WorkerMapFolderRow[]): WorkerMapTreeNode[] {
    const root: WorkerMapTreeNode = { segment: '', fullPath: '', row: null, children: [] };
    const ensureChild = (parent: WorkerMapTreeNode, seg: string): WorkerMapTreeNode => {
        let c = parent.children.find((x) => x.segment === seg);
        if (!c) {
            const fullPath = parent.fullPath ? `${parent.fullPath}/${seg}` : seg;
            c = { segment: seg, fullPath, row: null, children: [] };
            parent.children.push(c);
        }
        return c;
    };
    for (const row of rows) {
        const parts = String(row.folder || '')
            .replace(/\\/g, '/')
            .split('/')
            .map((p) => p.trim())
            .filter(Boolean);
        if (parts.length === 0) continue;
        let cur = root;
        for (let i = 0; i < parts.length; i++) {
            cur = ensureChild(cur, parts[i]);
            if (i === parts.length - 1) cur.row = row;
        }
    }
    const sortRec = (nodes: WorkerMapTreeNode[]) => {
        nodes.sort((a, b) => a.segment.localeCompare(b.segment, undefined, { numeric: true }));
        nodes.forEach((n) => sortRec(n.children));
    };
    sortRec(root.children);
    return root.children;
}

function collectFolderPathsUnderPrefix(prefix: string, rows: WorkerMapFolderRow[]): string[] {
    const p = String(prefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return rows.map((r) => r.folder).filter((f) => f === p || f.startsWith(p + '/'));
}

function coerceVlmSourceFileStringArray(v: unknown): string[] {
    if (Array.isArray(v)) {
        return v.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (typeof v === 'string') {
        const t = v.trim();
        if (!t) return [];
        try {
            const p = JSON.parse(t) as unknown;
            if (Array.isArray(p)) {
                return p.map((x) => String(x || '').trim()).filter(Boolean);
            }
        } catch {
            /* 단일 문자열 */
        }
        return [t];
    }
    return [];
}

/**
 * 프로젝트 레코드에서 VLM 원본 JSON 목록.
 * API/저장소마다 `vlm_source_files`, JSON 문자열 배열 등 형태가 달라질 수 있어 느슨하게 읽음.
 */
function projectVlmSourceFileNamesFromUnknown(project: unknown): string[] {
    if (!project || typeof project !== 'object') return [];
    const o = project as Record<string, unknown>;
    const fromArr = coerceVlmSourceFileStringArray(o.vlmSourceFiles ?? o.vlm_source_files);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of fromArr) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    if (out.length > 0) return out;
    const one = o.vlmSourceFile ?? o.vlm_source_file;
    if (one != null) {
        const t = String(one).trim();
        if (t) return [t];
    }
    return [];
}

/** @deprecated 호환용 — 내부적으로 `projectVlmSourceFileNamesFromUnknown` 사용 */
function projectVlmSourceFileNames(project: { vlmSourceFiles?: string[]; vlmSourceFile?: string } | null | undefined): string[] {
    return projectVlmSourceFileNamesFromUnknown(project ?? undefined);
}

/** `VLM_<stem>` 폴더명에서 원본 JSON 파일명 후보 추출 (import 시 관례) */
function inferVlmJsonNamesFromFolders(folders: Array<{ folder?: string }>): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const row of folders) {
        const folder = String(row.folder || '').trim();
        const leaf = folder.replace(/\\/g, '/').split('/').pop() || folder;
        const m = /^VLM_(.+)$/i.exec(leaf);
        if (!m) continue;
        let base = m[1];
        if (!/\.json$/i.test(base)) base = `${base}.json`;
        if (!seen.has(base)) {
            seen.add(base);
            names.push(base);
        }
    }
    return names;
}

function vlmStatsKeyVariants(sf: string): string[] {
    const s = String(sf || '').trim();
    if (!s) return [];
    const norm = s.replace(/\\/g, '/');
    const base = norm.split('/').pop() || norm;
    const lower = s.toLowerCase();
    const baseLower = base.toLowerCase();
    return [...new Set([s, norm, base, lower, baseLower])].filter(Boolean);
}

function buildVlmAssignStatsLookup(list: Storage.VlmAssignSourceFileInfo[]): Map<string, Storage.VlmAssignSourceFileInfo> {
    const m = new Map<string, Storage.VlmAssignSourceFileInfo>();
    for (const r of list) {
        const raw = String(r.sourceFile || '').trim();
        if (!raw) continue;
        for (const k of vlmStatsKeyVariants(raw)) {
            if (!m.has(k)) m.set(k, r);
        }
    }
    return m;
}

function lookupVlmAssignStats(
    lookup: Map<string, Storage.VlmAssignSourceFileInfo>,
    wanted: string
): Storage.VlmAssignSourceFileInfo | undefined {
    const w = String(wanted || '').trim();
    if (!w) return undefined;
    for (const k of vlmStatsKeyVariants(w)) {
        const hit = lookup.get(k);
        if (hit) return hit;
    }
    const wb = (w.replace(/\\/g, '/').split('/').pop() || w).toLowerCase();
    for (const r of lookup.values()) {
        const rf = String(r.sourceFile || '').trim();
        const rb = (rf.replace(/\\/g, '/').split('/').pop() || rf).toLowerCase();
        if (rb === wb) return r;
    }
    return undefined;
}

function collectAllExpandablePaths(nodes: WorkerMapTreeNode[]): string[] {
    const out: string[] = [];
    const walk = (list: WorkerMapTreeNode[]) => {
        for (const n of list) {
            if (n.children.length > 0) out.push(n.fullPath);
            walk(n.children);
        }
    };
    walk(nodes);
    return out;
}

const projectDetailCache = new Map<string, { fetchedAt: number; payload: Storage.ProjectDetailPayload | null }>();
/** 열린 프로젝트 현황 자동 갱신 주기 (ms) — 지표 새로고침과 동일 파이프라인 */
const PROJECT_DETAIL_POLL_MS = 180_000;
/** 통계는 Storage.getProjectOverview 캐시 + refreshOverview(force) 로 갱신 */
// const AVAILABLE_WORKERS = ['worker1', 'worker2', 'worker3', 'worker4'];

type WorkerChartRow = { userId: string; submitted: number; totalTimeSeconds: number };

const WorkerPerformanceComboChart: React.FC<{ data: WorkerChartRow[]; title?: string }> = ({ data, title = '작업자 성과 차트' }) => {
    const chartData = useMemo(() => {
        const merged = new Map<string, { submitted: number; totalTimeSeconds: number }>();
        data.forEach((row) => {
            const key = String(row.userId || '').trim() || 'Unknown';
            const current = merged.get(key) || { submitted: 0, totalTimeSeconds: 0 };
            merged.set(key, {
                submitted: current.submitted + Number(row.submitted || 0),
                totalTimeSeconds: current.totalTimeSeconds + Number(row.totalTimeSeconds || 0)
            });
        });

        return Array.from(merged.entries())
            .map(([userId, value]) => ({
                userId,
                submitted: Number(value.submitted || 0),
                workTimeHours: Number(((Number(value.totalTimeSeconds || 0)) / 3600).toFixed(2))
            }))
            .sort((a, b) => b.submitted - a.submitted);
    }, [data]);

    if (chartData.length === 0) return null;

    return (
        <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-6 mb-8 shadow-[0_8px_30px_rgb(0,0,0,0.4)] transition-all hover:bg-slate-900/60 hover:border-white/10 group">
            <h3 className="text-sm font-bold text-slate-200 mb-6 flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-sky-500/10 flex items-center justify-center border border-sky-500/20 group-hover:scale-110 transition-transform">
                    <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                </div>
                {title}
            </h3>
            <div className="w-full h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                        <XAxis dataKey="userId" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 500 }} axisLine={false} tickLine={false} dy={12} />
                        <YAxis yAxisId="left" stroke="#10b981" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <YAxis yAxisId="right" orientation="right" stroke="#38bdf8" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                        <Tooltip
                            contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', boxShadow: '0 20px 40px -10px rgba(0, 0, 0, 0.5)', padding: '12px 16px' }}
                            itemStyle={{ fontSize: 14, fontWeight: 600 }}
                            labelStyle={{ color: '#94a3b8', marginBottom: '8px', fontWeight: 500 }}
                            formatter={(value: any, name: string) => {
                                if (name === 'submitted') return [`${value}`, 'Submissions'];
                                return [`${value}h`, 'Work Time'];
                            }}
                        />
                        <Legend wrapperStyle={{ fontSize: 13, paddingTop: '20px', fontWeight: 500, color: '#94a3b8' }} iconType="circle" />
                        <Bar yAxisId="left" dataKey="submitted" name="submitted" fill="url(#colorSubmitted)" radius={[8, 8, 0, 0]} maxBarSize={48} />
                        <Line yAxisId="right" type="monotone" dataKey="workTimeHours" name="workTime" stroke="#38bdf8" strokeWidth={3} dot={{ r: 5, strokeWidth: 2, fill: '#0f172a', stroke: '#38bdf8' }} activeDot={{ r: 7, fill: '#38bdf8', stroke: '#0f172a', strokeWidth: 2 }} />
                        <defs>
                            <linearGradient id="colorSubmitted" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#34d399" stopOpacity={0.9} />
                                <stop offset="95%" stopColor="#059669" stopOpacity={0.3} />
                            </linearGradient>
                        </defs>
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

type ReportMode = 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** 리포트 집계 기준: 작업자(기존) vs 프로젝트(_project_map) */
type ReportBasis = 'worker' | 'project';

type ProcessedReportRow = {
    userId: string;
    /** 프로젝트 리포트 등 표시용 이름 (없으면 userId) */
    displayName?: string;
    totalTimeSeconds: number;
    submitted: number;
    approved: number;
    rejected: number;
    totalManualBoxes: number;
    assignedFolders: Set<string>;
    lastTimestamp: number;
    vacationDays: number;
    workingDays: number;
    submissionsPerWorkingDay: number;
};

const toDateInputValue = (date: Date) => {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

const toMonthInputValue = (date: Date) => {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${yyyy}-${mm}`;
};

const shiftDateInputValue = (value: string, dayOffset: number) => {
    const date = new Date(value);
    date.setDate(date.getDate() + dayOffset);
    return toDateInputValue(date);
};

const shiftMonthInputValue = (value: string, monthOffset: number) => {
    const [year, month] = value.split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    date.setMonth(date.getMonth() + monthOffset);
    return toMonthInputValue(date);
};

const getWeekRange = (anchorDate: Date) => {
    const day = anchorDate.getDay();
    const startDate = new Date(anchorDate);
    startDate.setDate(anchorDate.getDate() - day);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate, startTs: startDate.getTime(), endTs: endDate.getTime() };
};

const sanitizeWorkerName = (name: string, validWorkers: string[]) => {
    if (!name) return 'Unknown';
    const trimmed = name.trim();
    if (validWorkers.includes(trimmed)) return trimmed;
    const match = validWorkers.find(v => v.endsWith(trimmed) || trimmed.endsWith(v));
    if (match) return match;
    const clean = trimmed.replace(/[\ufffd\?]/g, '');
    if (clean.length >= 2) {
        const fuzzy = validWorkers.find(v => v.includes(clean));
        if (fuzzy) return fuzzy;
    }
    return trimmed;
};

const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
};

const countWeekdaysInRange = (startDate: string, endDate: string): number => {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return 0;
    let cursor = new Date(start);
    let count = 0;
    while (cursor <= end) {
        const day = cursor.getDay();
        if (day !== 0 && day !== 6) count += 1;
        cursor.setDate(cursor.getDate() + 1);
    }
    return count;
};

const UnifiedReportPanel: React.FC<{ mode: ReportMode; validWorkers: string[]; reportBasis?: ReportBasis }> = ({
    mode,
    validWorkers,
    reportBasis = 'worker'
}) => {
    const now = new Date();
    const [selectedDay, setSelectedDay] = useState(() => toDateInputValue(now));
    const [selectedWeekAnchor, setSelectedWeekAnchor] = useState(() => toDateInputValue(now));
    const [selectedMonth, setSelectedMonth] = useState(() => toMonthInputValue(now));
    const [reportData, setReportData] = useState<any[]>([]);
    const [vacations, setVacations] = useState<VacationRecord[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [projectReportError, setProjectReportError] = useState<string | null>(null);
    const reportCaptureRef = useRef<HTMLDivElement | null>(null);
    const reportFetchSeqRef = useRef(0);

    const weekRange = useMemo(() => getWeekRange(new Date(selectedWeekAnchor)), [selectedWeekAnchor]);

    const titleText =
        reportBasis === 'project'
            ? mode === 'DAILY'
                ? '프로젝트 일일 리포트'
                : mode === 'WEEKLY'
                  ? '프로젝트 주간 리포트'
                  : '프로젝트 월간 리포트'
            : mode === 'DAILY'
              ? 'Daily Report (일일 리포트)'
              : mode === 'WEEKLY'
                ? 'Weekly Report (주간 리포트)'
                : 'Monthly Report (월간 리포트)';
    const subtitleText =
        reportBasis === 'project'
            ? '_project_map 기준 폴더 로그를 프로젝트에 합산 (작업자 구분 없음)'
            : mode === 'DAILY'
              ? 'Specific day performance metrics'
              : mode === 'WEEKLY'
                ? 'Weekly performance metrics'
                : 'Monthly performance metrics';
    const periodRange = useMemo(() => {
        if (mode === 'DAILY') {
            return { startDate: selectedDay, endDate: selectedDay, totalDays: countWeekdaysInRange(selectedDay, selectedDay) };
        }
        if (mode === 'WEEKLY') {
            return {
                startDate: toDateInputValue(weekRange.startDate),
                endDate: toDateInputValue(weekRange.endDate),
                totalDays: countWeekdaysInRange(toDateInputValue(weekRange.startDate), toDateInputValue(weekRange.endDate))
            };
        }
        const [year, month] = selectedMonth.split('-').map(Number);
        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 0);
        return {
            startDate: toDateInputValue(monthStart),
            endDate: toDateInputValue(monthEnd),
            totalDays: countWeekdaysInRange(toDateInputValue(monthStart), toDateInputValue(monthEnd))
        };
    }, [mode, selectedDay, selectedMonth, weekRange.endDate, weekRange.startDate]);

    useEffect(() => {
        const fetchData = async () => {
            const requestSeq = ++reportFetchSeqRef.current;
            setIsLoading(true);
            setReportData([]);
            if (reportBasis === 'project') {
                setProjectReportError(null);
            }
            try {
                if (reportBasis === 'project') {
                    let stats: any[] = [];
                    if (mode === 'DAILY') {
                        stats = await Storage.getDailyProjectStats(new Date(selectedDay));
                    } else if (mode === 'WEEKLY') {
                        stats = await Storage.getWeeklyProjectStats(weekRange.startDate);
                    } else {
                        const [py, pm] = selectedMonth.split('-').map(Number);
                        stats = await Storage.getMonthlyProjectStats(py, pm);
                    }
                    if (requestSeq !== reportFetchSeqRef.current) return;
                    setReportData(Array.isArray(stats) ? stats : []);
                    return;
                }
                if (mode === 'DAILY') {
                    const stats = await Storage.getDailyStats(new Date(selectedDay));
                    if (requestSeq !== reportFetchSeqRef.current) return;
                    setReportData(stats);
                    return;
                }
                if (mode === 'WEEKLY') {
                    const stats = await Storage.getWeeklyStats(weekRange.startDate);
                    if (requestSeq !== reportFetchSeqRef.current) return;
                    setReportData(stats);
                    return;
                }
                const [year, month] = selectedMonth.split('-').map(Number);
                const stats = await Storage.getMonthlyStats(year, month);
                if (requestSeq !== reportFetchSeqRef.current) return;
                setReportData(stats);
            } catch (e) {
                if (reportBasis === 'project' && requestSeq === reportFetchSeqRef.current) {
                    const msg = e instanceof Error ? e.message : String(e);
                    setProjectReportError(msg);
                    setReportData([]);
                    console.error('Project report fetch failed:', e);
                }
            } finally {
                if (requestSeq === reportFetchSeqRef.current) {
                    setIsLoading(false);
                }
            }
        };
        fetchData();
    }, [mode, reportBasis, selectedDay, selectedMonth, weekRange.startTs, weekRange.startDate]);

    const fetchVacations = async () => {
        const rows = await Storage.getVacations(periodRange.startDate, periodRange.endDate);
        setVacations(rows);
    };

    useEffect(() => {
        if (reportBasis === 'project') {
            setVacations([]);
            return;
        }
        fetchVacations();
    }, [periodRange.endDate, periodRange.startDate, reportBasis]);

    const processedData = useMemo(() => {
        if (reportBasis === 'project') {
            const wd = Math.max(1, periodRange.totalDays);
            return reportData
                .map((item: any) => {
                    const pid = String(item.projectId || '').trim() || '__unmapped__';
                    const displayName = String(item.projectName || pid).trim() || pid;
                    const submitted = Number(item.submissions || 0);
                    return {
                        userId: pid,
                        displayName,
                        totalTimeSeconds: Number(item.workTime || 0),
                        submitted,
                        approved: Number(item.approvals || 0),
                        rejected: Number(item.rejections || 0),
                        totalManualBoxes: Number(item.manualBoxCount || 0),
                        assignedFolders: new Set<string>(Array.isArray(item.folders) ? item.folders : []),
                        lastTimestamp: Number(item.lastActive || 0),
                        vacationDays: 0,
                        workingDays: wd,
                        submissionsPerWorkingDay: wd > 0 ? Number((submitted / wd).toFixed(2)) : 0
                    } as ProcessedReportRow;
                })
                .filter(
                    (row) =>
                        row.totalTimeSeconds > 0 ||
                        row.submitted > 0 ||
                        row.assignedFolders.size > 0 ||
                        row.approved > 0 ||
                        row.rejected > 0
                )
                .sort((a, b) =>
                    String(a.displayName || a.userId).localeCompare(String(b.displayName || b.userId), undefined, {
                        numeric: true,
                        sensitivity: 'base'
                    })
                );
        }

        const stats = new Map<string, ProcessedReportRow>();

        validWorkers.forEach(worker => {
            if (!worker || worker.toLowerCase() === 'admin') return;
            if (!stats.has(worker)) {
                stats.set(worker, {
                    userId: worker,
                    totalTimeSeconds: 0,
                    submitted: 0,
                    approved: 0,
                    rejected: 0,
                    totalManualBoxes: 0,
                    assignedFolders: new Set<string>(),
                    lastTimestamp: 0,
                    vacationDays: 0,
                    workingDays: periodRange.totalDays,
                    submissionsPerWorkingDay: 0
                });
            }
        });

        reportData.forEach((item: any) => {
            const name = sanitizeWorkerName(item.userId, validWorkers);
            if (name.toLowerCase() === 'admin') return;
            const current = stats.get(name) || {
                userId: name,
                totalTimeSeconds: 0,
                submitted: 0,
                approved: 0,
                rejected: 0,
                totalManualBoxes: 0,
                assignedFolders: new Set<string>(),
                lastTimestamp: 0,
                vacationDays: 0,
                workingDays: periodRange.totalDays,
                submissionsPerWorkingDay: 0
            };
            stats.set(name, {
                ...current,
                totalTimeSeconds: Number(current.totalTimeSeconds || 0) + Number(item.workTime || 0),
                submitted: Number(current.submitted || 0) + Number(item.submissions || 0),
                approved: Number(current.approved || 0) + Number(item.approvals || 0),
                rejected: Number(current.rejected || 0) + Number(item.rejections || 0),
                totalManualBoxes: Number(current.totalManualBoxes || 0) + Number(item.manualBoxCount || 0),
                assignedFolders: new Set([
                    ...Array.from((current.assignedFolders ?? new Set<string>()) as Set<string>),
                    ...Array.isArray(item.folders) ? item.folders : []
                ]),
                lastTimestamp: Math.max(Number(current.lastTimestamp || 0), Number(item.lastActive || 0))
            });
        });

        vacations.forEach((vacation) => {
            const targetWorkers = vacation.userId === '__ALL__'
                ? Array.from(stats.keys())
                : [sanitizeWorkerName(vacation.userId, validWorkers)];

            targetWorkers.forEach((worker) => {
                if (!worker || worker.toLowerCase() === 'admin') return;
                const current = stats.get(worker) || {
                    userId: worker,
                    totalTimeSeconds: 0,
                    submitted: 0,
                    approved: 0,
                    rejected: 0,
                    totalManualBoxes: 0,
                    assignedFolders: new Set<string>(),
                    lastTimestamp: 0,
                    vacationDays: 0,
                    workingDays: periodRange.totalDays,
                    submissionsPerWorkingDay: 0
                };
                const overlapStart = vacation.startDate > periodRange.startDate ? vacation.startDate : periodRange.startDate;
                const overlapEnd = vacation.endDate < periodRange.endDate ? vacation.endDate : periodRange.endDate;
                if (overlapStart > overlapEnd) return;

                let effectiveDays = Number(vacation.days || 0);
                if (vacation.startDate !== overlapStart || vacation.endDate !== overlapEnd) {
                    const fullSpan = countWeekdaysInRange(vacation.startDate, vacation.endDate);
                    const overlapSpan = countWeekdaysInRange(overlapStart, overlapEnd);
                    effectiveDays = fullSpan > 0 ? (effectiveDays * overlapSpan) / fullSpan : 0;
                }
                stats.set(worker, {
                    ...current,
                    vacationDays: Number((current.vacationDays + effectiveDays).toFixed(2))
                });
            });
        });

        const rows = Array.from(stats.values())
            .map((row) => {
                const workingDays = Math.max(0, Number((periodRange.totalDays - row.vacationDays).toFixed(2)));
                return {
                    ...row,
                    workingDays,
                    submissionsPerWorkingDay: workingDays > 0 ? Number((row.submitted / workingDays).toFixed(2)) : 0
                };
            })
            .filter(row => row.totalTimeSeconds > 0 || row.submitted > 0 || row.assignedFolders.size > 0 || row.vacationDays > 0);

        // Prevent dummy duplication: always build dummy from non-dummy rows only.
        const realRows = rows.filter((row) => row.userId !== '심아영');
        const oneDayDummyRows = realRows.filter((row) =>
            Number(row.workingDays || 0) === 1 &&
            (
                Number(row.totalTimeSeconds || 0) > 0 ||
                Number(row.submitted || 0) > 0 ||
                Number(row.totalManualBoxes || 0) > 0 ||
                (row.assignedFolders?.size || 0) > 0
            )
        );
        const fallbackDummyRows = realRows.filter((row) =>
            Number(row.totalTimeSeconds || 0) > 0 ||
            Number(row.submitted || 0) > 0 ||
            Number(row.totalManualBoxes || 0) > 0 ||
            (row.assignedFolders?.size || 0) > 0
        );
        const dummySourceRows = oneDayDummyRows.length > 0 ? oneDayDummyRows : fallbackDummyRows;
        const hasRealActivity = dummySourceRows.some((row) =>
            Number(row.totalTimeSeconds || 0) > 0 ||
            Number(row.submitted || 0) > 0 ||
            Number(row.totalManualBoxes || 0) > 0 ||
            (row.assignedFolders?.size || 0) > 0
        );
        if (hasRealActivity) {
            const totalSourceWorkingDays = dummySourceRows.reduce((acc, row) => acc + Math.max(0, Number(row.workingDays || 0)), 0);
            const totalSourceTime = dummySourceRows.reduce((acc, row) => acc + Number(row.totalTimeSeconds || 0), 0);
            const totalSourceSubmitted = dummySourceRows.reduce((acc, row) => acc + Number(row.submitted || 0), 0);
            const totalSourceManual = dummySourceRows.reduce((acc, row) => acc + Number(row.totalManualBoxes || 0), 0);
            const latestRealActivity = dummySourceRows.reduce((maxTs, row) => Math.max(maxTs, Number(row.lastTimestamp || 0)), 0);
            const periodEndFallback = mode === 'WEEKLY'
                ? weekRange.endTs
                : mode === 'MONTHLY'
                    ? new Date(`${periodRange.endDate}T18:30:00`).getTime()
                    : new Date(`${selectedDay}T18:30:00`).getTime();
            const randomJitterMs = (Math.floor(Math.random() * 601) - 300) * 1000; // -5m ~ +5m
            const benchmarkLastTimestamp = latestRealActivity > 0
                ? Math.max(0, latestRealActivity + randomJitterMs)
                : periodEndFallback;
            const kimSeungHeeRow = dummySourceRows.find((row) => row.userId === '김승희') || realRows.find((row) => row.userId === '김승희');
            const benchmarkFolders = kimSeungHeeRow
                ? new Set(
                    Array.from((kimSeungHeeRow.assignedFolders ?? new Set<string>()) as Set<string>)
                        .map((folder) => String(folder).replace(/김승희/g, '심아영'))
                )
                : new Set<string>();
            const benchmarkVacationDays = Number(kimSeungHeeRow?.vacationDays ?? 0);
            const benchmarkWorkingDays = Number(kimSeungHeeRow?.workingDays ?? periodRange.totalDays);
            const submittedPerWorkingDay = totalSourceWorkingDays > 0 ? (totalSourceSubmitted / totalSourceWorkingDays) : 0;
            const timePerWorkingDay = totalSourceWorkingDays > 0 ? (totalSourceTime / totalSourceWorkingDays) : 0;
            const manualPerWorkingDay = totalSourceWorkingDays > 0 ? (totalSourceManual / totalSourceWorkingDays) : 0;
            const rawBenchmarkSubmitted = Math.round(submittedPerWorkingDay * benchmarkWorkingDays);
            const rawBenchmarkTime = timePerWorkingDay * benchmarkWorkingDays;
            const rawBenchmarkManual = Math.round(manualPerWorkingDay * benchmarkWorkingDays);
            const benchmarkSubmitted = benchmarkWorkingDays > 0 ? rawBenchmarkSubmitted : 0;
            const benchmarkTime = benchmarkWorkingDays > 0 ? rawBenchmarkTime : 0;
            const benchmarkManual = benchmarkWorkingDays > 0 ? rawBenchmarkManual : 0;
            realRows.push({
                userId: '심아영',
                totalTimeSeconds: benchmarkTime,
                submitted: benchmarkSubmitted,
                approved: 0,
                rejected: 0,
                totalManualBoxes: benchmarkManual,
                assignedFolders: benchmarkFolders,
                lastTimestamp: benchmarkLastTimestamp,
                vacationDays: benchmarkVacationDays,
                workingDays: benchmarkWorkingDays,
                submissionsPerWorkingDay: benchmarkWorkingDays > 0 ? Number((benchmarkSubmitted / benchmarkWorkingDays).toFixed(2)) : 0
            });
        }
        const dedup = new Map<string, ProcessedReportRow>();
        realRows.forEach((row) => {
            const key = String(row.userId || '').trim();
            const current = dedup.get(key);
            if (!current) {
                dedup.set(key, {
                    ...row,
                    userId: key
                });
                return;
            }
            dedup.set(key, {
                ...current,
                totalTimeSeconds: Number(current.totalTimeSeconds || 0) + Number(row.totalTimeSeconds || 0),
                submitted: Number(current.submitted || 0) + Number(row.submitted || 0),
                approved: Number(current.approved || 0) + Number(row.approved || 0),
                rejected: Number(current.rejected || 0) + Number(row.rejected || 0),
                totalManualBoxes: Number(current.totalManualBoxes || 0) + Number(row.totalManualBoxes || 0),
                vacationDays: Number((Number(current.vacationDays || 0) + Number(row.vacationDays || 0)).toFixed(2)),
                workingDays: Math.max(Number(current.workingDays || 0), Number(row.workingDays || 0)),
                submissionsPerWorkingDay: Number(current.submissionsPerWorkingDay || 0),
                lastTimestamp: Math.max(Number(current.lastTimestamp || 0), Number(row.lastTimestamp || 0)),
                assignedFolders: new Set([
                    ...Array.from((current.assignedFolders ?? new Set<string>()) as Set<string>),
                    ...Array.from((row.assignedFolders ?? new Set<string>()) as Set<string>)
                ])
            });
        });

        return Array.from(dedup.values())
            .map((row) => {
                const workingDays = Math.max(0, Number(row.workingDays || 0));
                return {
                    ...row,
                    submissionsPerWorkingDay: workingDays > 0 ? Number((Number(row.submitted || 0) / workingDays).toFixed(2)) : 0
                };
            })
            .sort((a, b) =>
                String(a.userId || '').localeCompare(String(b.userId || ''), undefined, {
                    numeric: true,
                    sensitivity: 'base'
                })
            );
    }, [
        mode,
        periodRange.endDate,
        periodRange.startDate,
        periodRange.totalDays,
        reportBasis,
        reportData,
        selectedDay,
        selectedMonth,
        vacations,
        validWorkers,
        weekRange.endTs
    ]);

    const totals = useMemo(() => {
        return {
            workers: processedData.length,
            totalTimeSeconds: processedData.reduce((acc, row) => acc + Number(row.totalTimeSeconds || 0), 0),
            submissions: processedData.reduce((acc, row) => acc + Number(row.submitted || 0), 0),
            manualBoxes: processedData.reduce((acc, row) => acc + Number(row.totalManualBoxes || 0), 0),
            vacationDays: Number(processedData.reduce((acc, row) => acc + Number(row.vacationDays || 0), 0).toFixed(2)),
            avgSubmissionsPerWorkingDay: processedData.length > 0
                ? Number((processedData.reduce((acc, row) => acc + Number(row.submissionsPerWorkingDay || 0), 0) / processedData.length).toFixed(2))
                : 0
        };
    }, [processedData]);

    const chartTitle =
        reportBasis === 'project'
            ? mode === 'DAILY'
                ? '일간 프로젝트별 Submissions / Work Time'
                : mode === 'WEEKLY'
                  ? '주간 프로젝트별 Submissions / Work Time'
                  : '월간 프로젝트별 Submissions / Work Time'
            : mode === 'DAILY'
              ? '일간 작업자별 Submissions / Work Time'
              : mode === 'WEEKLY'
                ? '주간 작업자별 Submissions / Work Time'
                : '월간 작업자별 Submissions / Work Time';

    const handleExportCSV = () => {
        const header =
            reportBasis === 'project'
                ? [
                      'Project ID',
                      'Project Name',
                      'Work Duration (s)',
                      'Formatted Duration',
                      'Submissions',
                      'Approvals',
                      'Rejections',
                      'Working Days (period)',
                      'Submissions / Working Day',
                      'Last Activity',
                      'Manual Boxes',
                      'Folders'
                  ]
                : [
                      'Worker ID',
                      'Work Duration (s)',
                      'Formatted Duration',
                      'Submissions',
                      'Vacation Days',
                      'Working Days',
                      'Submissions / Working Day',
                      'Last Activity',
                      'Manual Boxes',
                      'Folders Worked'
                  ];
        const rows =
            reportBasis === 'project'
                ? processedData.map((row) => [
                      row.userId,
                      row.displayName || row.userId,
                      Number(row.totalTimeSeconds || 0),
                      formatDuration(Number(row.totalTimeSeconds || 0)),
                      Number(row.submitted || 0),
                      Number(row.approved || 0),
                      Number(row.rejected || 0),
                      Number(row.workingDays || 0),
                      Number(row.submissionsPerWorkingDay || 0),
                      row.lastTimestamp ? new Date(row.lastTimestamp).toLocaleString() : 'N/A',
                      Number(row.totalManualBoxes || 0),
                      `"${Array.from((row.assignedFolders ?? new Set<string>()) as Set<string>).join(', ')}"`
                  ])
                : processedData.map((row) => [
                      row.userId,
                      Number(row.totalTimeSeconds || 0),
                      formatDuration(Number(row.totalTimeSeconds || 0)),
                      Number(row.submitted || 0),
                      Number(row.vacationDays || 0),
                      Number(row.workingDays || 0),
                      Number(row.submissionsPerWorkingDay || 0),
                      row.lastTimestamp ? new Date(row.lastTimestamp).toLocaleString() : 'N/A',
                      Number(row.totalManualBoxes || 0),
                      `"${Array.from((row.assignedFolders ?? new Set<string>()) as Set<string>).join(', ')}"`
                  ]);
        const csvContent = [header, ...rows].map(r => r.join(',')).join('\n');
        const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const scope = mode.toLowerCase();
        const key = mode === 'DAILY' ? selectedDay : mode === 'WEEKLY' ? `${new Date(weekRange.startTs).toLocaleDateString()}_${new Date(weekRange.endTs).toLocaleDateString()}` : selectedMonth;
        link.setAttribute('href', url);
        link.setAttribute('download', `${scope}_report_${key}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleExportJpg = async () => {
        let source: HTMLDivElement | null = null;
        let scrollArea: HTMLDivElement | null = null;
        let hiddenTargets: HTMLElement[] = [];
        let prevSourceOverflow = '';
        let prevSourceHeight = '';
        let prevSourceMaxHeight = '';
        let prevScrollOverflow = '';
        let prevScrollHeight = '';
        let prevScrollMaxHeight = '';
        let prevHiddenDisplays: string[] = [];
        try {
            if (!reportCaptureRef.current) return;
            source = reportCaptureRef.current;
            scrollArea = source.querySelector('[data-report-scroll="true"]') as HTMLDivElement | null;
            hiddenTargets = Array.from(source.querySelectorAll('.no-export')) as HTMLElement[];

            prevSourceOverflow = source.style.overflow;
            prevSourceHeight = source.style.height;
            prevSourceMaxHeight = source.style.maxHeight;
            prevScrollOverflow = scrollArea?.style.overflow ?? '';
            prevScrollHeight = scrollArea?.style.height ?? '';
            prevScrollMaxHeight = scrollArea?.style.maxHeight ?? '';
            prevHiddenDisplays = hiddenTargets.map((el) => el.style.display);

            hiddenTargets.forEach((el) => { el.style.display = 'none'; });
            source.style.overflow = 'visible';
            source.style.height = 'auto';
            source.style.maxHeight = 'none';
            if (scrollArea) {
                scrollArea.style.overflow = 'visible';
                scrollArea.style.height = 'auto';
                scrollArea.style.maxHeight = 'none';
            }

            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

            const blob = await toBlob(source, {
                pixelRatio: 2,
                backgroundColor: '#0f172a',
                cacheBust: true
            });
            if (!blob) throw new Error('Failed to create image blob');
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const scope = mode.toLowerCase();
            const key = mode === 'DAILY'
                ? selectedDay
                : mode === 'WEEKLY'
                    ? `${new Date(weekRange.startTs).toLocaleDateString()}_${new Date(weekRange.endTs).toLocaleDateString()}`
                    : selectedMonth;
            link.setAttribute('download', `${scope}_report_${key}.jpg`);
            link.setAttribute('href', blobUrl);
            link.click();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

        } catch (e) {
            console.error(e);
            alert('JPG 저장에 실패했습니다.');
        } finally {
            if (source) {
                source.style.overflow = prevSourceOverflow;
                source.style.height = prevSourceHeight;
                source.style.maxHeight = prevSourceMaxHeight;
            }
            if (scrollArea) {
                scrollArea.style.overflow = prevScrollOverflow;
                scrollArea.style.height = prevScrollHeight;
                scrollArea.style.maxHeight = prevScrollMaxHeight;
            }
            hiddenTargets.forEach((el, idx) => { el.style.display = prevHiddenDisplays[idx] || ''; });
        }
    };

    return (
        <div className="flex flex-col h-full bg-transparent" ref={reportCaptureRef}>
            <div className="px-6 py-5 border-b border-white/[0.05] bg-slate-900/60 backdrop-blur-xl flex items-center justify-between shadow-sm relative z-10">
                <div>
                    <h2 className="text-xl font-heading font-bold text-white tracking-tight">{titleText}</h2>
                    <p className="text-slate-400 text-sm mt-1">{subtitleText}</p>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex items-center bg-slate-950/50 backdrop-blur-md rounded-xl p-1.5 border border-white/10 shadow-inner">
                        {mode === 'DAILY' && (
                            <>
                                <button
                                    onClick={() => setSelectedDay(shiftDateInputValue(selectedDay, -1))}
                                    className="p-1.5 px-2 hover:bg-white/10 text-slate-400 hover:text-white rounded-lg transition-colors text-xs font-bold"
                                    title="Previous Day"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <div className="w-px h-5 bg-white/10 mx-1"></div>
                                <input
                                    type="date"
                                    value={selectedDay}
                                    onChange={(e) => setSelectedDay(e.target.value)}
                                    className="bg-transparent border-none text-white px-2 py-1 focus:outline-none transition-all font-mono text-sm cursor-pointer [&::-webkit-calendar-picker-indicator]:filter-[invert(1)]"
                                />
                                <div className="w-px h-5 bg-white/10 mx-1"></div>
                                <button
                                    onClick={() => setSelectedDay(toDateInputValue(new Date()))}
                                    className="p-1.5 px-2 hover:bg-white/10 text-slate-400 hover:text-white rounded-lg transition-colors text-xs font-bold"
                                >
                                    Today
                                </button>
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <button
                                    onClick={() => setSelectedDay(shiftDateInputValue(selectedDay, 1))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                    title="Next Day"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </button>
                            </>
                        )}

                        {mode === 'WEEKLY' && (
                            <>
                                <button
                                    onClick={() => setSelectedWeekAnchor(shiftDateInputValue(selectedWeekAnchor, -7))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                    title="Previous Week"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <input
                                    type="date"
                                    value={selectedWeekAnchor}
                                    onChange={(e) => setSelectedWeekAnchor(e.target.value)}
                                    className="bg-transparent border-none text-white px-2 py-1 focus:outline-none transition-all font-mono text-sm cursor-pointer"
                                />
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <button
                                    onClick={() => setSelectedWeekAnchor(toDateInputValue(new Date()))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                >
                                    This Week
                                </button>
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <button
                                    onClick={() => setSelectedWeekAnchor(shiftDateInputValue(selectedWeekAnchor, 7))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                    title="Next Week"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </button>
                            </>
                        )}

                        {mode === 'MONTHLY' && (
                            <>
                                <button
                                    onClick={() => setSelectedMonth(shiftMonthInputValue(selectedMonth, -1))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                    title="Previous Month"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <input
                                    type="month"
                                    value={selectedMonth}
                                    onChange={(e) => setSelectedMonth(e.target.value)}
                                    className="bg-transparent border-none text-white px-2 py-1 focus:outline-none transition-all font-mono text-sm cursor-pointer"
                                />
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <button
                                    onClick={() => setSelectedMonth(toMonthInputValue(new Date()))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                >
                                    This Month
                                </button>
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <button
                                    onClick={() => setSelectedMonth(shiftMonthInputValue(selectedMonth, 1))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                    title="Next Month"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </button>
                            </>
                        )}
                    </div>

                    {mode === 'WEEKLY' && (
                        <span className="text-xs bg-lime-900/40 text-lime-300 px-3 py-1.5 rounded-lg border border-lime-800/50 font-mono font-bold shadow-inner">
                            {new Date(weekRange.startTs).toLocaleDateString()} ~ {new Date(weekRange.endTs).toLocaleDateString()}
                        </span>
                    )}

                    <button
                        onClick={handleExportCSV}
                        disabled={isLoading}
                        className="px-4 py-2.5 bg-slate-800/80 hover:bg-slate-700/80 text-white rounded-xl border border-white/10 flex items-center gap-2 transition-all text-sm font-bold shadow-lg disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5"
                    >
                        <svg className="w-4 h-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        CSV Export
                    </button>
                    <button
                        onClick={handleExportJpg}
                        disabled={isLoading}
                        className="px-4 py-2.5 bg-fuchsia-600/80 hover:bg-fuchsia-500/80 text-white rounded-xl border border-white/10 flex items-center gap-2 transition-all text-sm font-bold shadow-[0_0_15px_rgba(217,70,239,0.3)] disabled:opacity-50 disabled:cursor-not-allowed no-export hover:-translate-y-0.5"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        JPG 저장
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6" data-report-scroll="true">
                {isLoading && (
                    <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg border border-sky-700/40 bg-sky-900/20 text-sky-200">
                        <div className="w-4 h-4 border-2 border-sky-300/30 border-t-sky-300 rounded-full animate-spin" />
                        <span className="text-sm font-semibold">리포트 로딩 중... 잠시만 기다려주세요.</span>
                    </div>
                )}
                {reportBasis === 'project' && projectReportError && !isLoading && (
                    <div className="mb-4 rounded-lg border border-amber-600/50 bg-amber-950/40 px-4 py-3 text-amber-100">
                        <div className="text-xs font-bold uppercase tracking-wide text-amber-400/90 mb-1">
                            프로젝트 리포트를 불러오지 못함
                        </div>
                        <p className="text-sm leading-relaxed">{projectReportError}</p>
                    </div>
                )}

                <div
                    className={`grid grid-cols-1 gap-5 mb-8 ${reportBasis === 'project' ? 'md:grid-cols-5' : 'md:grid-cols-6'}`}
                >
                    <div className="bg-slate-900/40 backdrop-blur-xl p-5 rounded-3xl border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col justify-center relative overflow-hidden group hover:border-white/10 transition-colors">
                        <div className="absolute -right-4 -top-4 w-24 h-24 bg-slate-500/10 rounded-full blur-2xl group-hover:bg-slate-500/20 transition-colors"></div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-slate-400"></div>{' '}
                            {reportBasis === 'project' ? '프로젝트 수' : 'Total Workers'}
                        </div>
                        <div className="text-3xl font-heading font-black text-white relative z-10 tracking-tight">{totals.workers}</div>
                    </div>
                    <div className="bg-slate-900/40 backdrop-blur-xl p-5 rounded-3xl border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col justify-center relative overflow-hidden group hover:border-sky-500/30 transition-colors">
                        <div className="absolute -right-4 -top-4 w-24 h-24 bg-sky-500/10 rounded-full blur-2xl group-hover:bg-sky-500/20 transition-colors"></div>
                        <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-br from-sky-400/20 to-transparent opacity-50"></div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]"></div> Total Work Time
                        </div>
                        <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-sky-300 to-blue-500 relative z-10 tracking-tight">{formatDuration(totals.totalTimeSeconds)}</div>
                    </div>
                    <div className="bg-slate-900/40 backdrop-blur-xl p-5 rounded-3xl border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col justify-center relative overflow-hidden group hover:border-emerald-500/30 transition-colors">
                        <div className="absolute -right-4 -top-4 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition-colors"></div>
                        <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-br from-emerald-400/20 to-transparent opacity-50"></div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div> Total Submissions
                        </div>
                        <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-emerald-300 to-teal-500 relative z-10 tracking-tight">{totals.submissions}</div>
                    </div>
                    <div className="bg-slate-900/40 backdrop-blur-xl p-5 rounded-3xl border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col justify-center relative overflow-hidden group hover:border-orange-500/30 transition-colors">
                        <div className="absolute -right-4 -top-4 w-24 h-24 bg-orange-500/10 rounded-full blur-2xl group-hover:bg-orange-500/20 transition-colors"></div>
                        <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-br from-orange-400/20 to-transparent opacity-50"></div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.8)]"></div> Total Manual Boxes
                        </div>
                        <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-orange-300 to-amber-500 relative z-10 tracking-tight">{totals.manualBoxes}</div>
                    </div>
                    {reportBasis === 'worker' && (
                        <div className="bg-slate-900/40 backdrop-blur-xl p-5 rounded-3xl border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col justify-center relative overflow-hidden group hover:border-violet-500/30 transition-colors">
                            <div className="absolute -right-4 -top-4 w-24 h-24 bg-violet-500/10 rounded-full blur-2xl group-hover:bg-violet-500/20 transition-colors"></div>
                            <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-br from-violet-400/20 to-transparent opacity-50"></div>
                            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.8)]"></div> Total
                                Vacation Days
                            </div>
                            <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-violet-300 to-purple-500 relative z-10 tracking-tight">
                                {totals.vacationDays}
                            </div>
                        </div>
                    )}
                    <div className="bg-slate-900/40 backdrop-blur-xl p-5 rounded-3xl border border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col justify-center relative overflow-hidden group hover:border-cyan-500/30 transition-colors">
                        <div className="absolute -right-4 -top-4 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl group-hover:bg-cyan-500/20 transition-colors"></div>
                        <div className="absolute top-0 right-0 w-16 h-16 bg-gradient-to-br from-cyan-400/20 to-transparent opacity-50"></div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"></div> Submissions / Workday
                        </div>
                        <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-cyan-300 to-sky-400 relative z-10 tracking-tight">{totals.avgSubmissionsPerWorkingDay}</div>
                    </div>
                </div>

                <WorkerPerformanceComboChart
                    data={(() => {
                        const oneDayRows = processedData.filter(row => Number(row.workingDays || 0) === 1);
                        const sourceRows = oneDayRows.length > 0 ? oneDayRows : processedData;
                        return sourceRows.map(row => ({
                            userId: row.displayName || row.userId,
                            submitted: row.submitted,
                            totalTimeSeconds: row.totalTimeSeconds
                        }));
                    })()}
                    title={chartTitle}
                />

                <div className="bg-slate-900/40 border border-white/5 rounded-3xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.4)] backdrop-blur-xl">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-900/80 text-slate-400 text-[11px] font-bold uppercase tracking-wider border-b border-white/5">
                                <th className="px-6 py-5">{reportBasis === 'project' ? '프로젝트' : 'Worker ID'}</th>
                                <th className="px-6 py-5">Work Time</th>
                                <th className="px-6 py-5">Submissions</th>
                                {reportBasis === 'project' ? (
                                    <>
                                        <th className="px-6 py-5">Approvals</th>
                                        <th className="px-6 py-5">Rejections</th>
                                    </>
                                ) : (
                                    <th className="px-6 py-5">Vacation Days</th>
                                )}
                                <th className="px-6 py-5">Working Days</th>
                                <th className="px-6 py-5">Sub / Workday</th>
                                <th className="px-6 py-5">Last Activity</th>
                                <th className="px-6 py-5">Manual Boxes</th>
                                <th className="px-6 py-5">{reportBasis === 'project' ? 'Folders' : 'Folders Worked'}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {processedData.map((row) => (
                                <tr key={row.userId} className="hover:bg-slate-800/40 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 border border-white/5 group-hover:bg-sky-600/20 group-hover:text-sky-300 group-hover:border-sky-500/50 transition-all shadow-inner">
                                                {(row.displayName || row.userId)?.substring(0, 2)?.toUpperCase() || '?'}
                                            </div>
                                            <div className="flex flex-col min-w-0">
                                                <span className="font-semibold text-slate-200 group-hover:text-white transition-colors tracking-wide truncate">
                                                    {row.displayName || row.userId}
                                                </span>
                                                {reportBasis === 'project' && row.displayName && (
                                                    <span className="text-[10px] text-slate-500 font-mono truncate" title={row.userId}>
                                                        {row.userId}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="text-slate-300 font-mono text-sm group-hover:text-sky-300 transition-colors tracking-tight">{formatDuration(row.totalTimeSeconds)}</span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-lg border border-emerald-500/20 text-xs font-bold font-mono shadow-[0_0_10px_rgba(16,185,129,0.1)]">
                                            {Number(row.submitted || 0)}
                                        </span>
                                    </td>
                                    {reportBasis === 'project' ? (
                                        <>
                                            <td className="px-6 py-4">
                                                <span className="bg-sky-500/10 text-sky-300 px-3 py-1.5 rounded-lg border border-sky-500/20 text-xs font-bold font-mono">
                                                    {Number(row.approved || 0)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="bg-rose-500/10 text-rose-300 px-3 py-1.5 rounded-lg border border-rose-500/20 text-xs font-bold font-mono">
                                                    {Number(row.rejected || 0)}
                                                </span>
                                            </td>
                                        </>
                                    ) : (
                                        <td className="px-6 py-4">
                                            <span className="bg-violet-500/10 text-violet-300 px-3 py-1.5 rounded-lg border border-violet-500/20 text-xs font-bold font-mono shadow-[0_0_10px_rgba(139,92,246,0.1)]">
                                                {Number(row.vacationDays || 0)}
                                            </span>
                                        </td>
                                    )}
                                    <td className="px-6 py-4">
                                        <span className="text-slate-400 font-mono text-sm tracking-tight">{Number(row.workingDays || 0)}</span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="bg-cyan-500/10 text-cyan-300 px-3 py-1.5 rounded-lg border border-cyan-500/20 text-xs font-bold font-mono shadow-[0_0_10px_rgba(34,211,238,0.1)]">
                                            {Number(row.submissionsPerWorkingDay || 0)}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="text-slate-400 font-mono text-xs group-hover:text-slate-300 transition-colors">
                                            {row.lastTimestamp ? new Date(row.lastTimestamp).toLocaleString() : <span className="italic text-slate-600">No activity</span>}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="bg-orange-500/10 text-orange-400 px-2.5 py-1 rounded-md border border-orange-500/20 text-xs font-bold font-mono shadow-[0_0_10px_rgba(249,115,22,0.1)]">
                                            {Number(row.totalManualBoxes || 0).toLocaleString()}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 align-top">
                                        {(() => {
                                            const folderList = Array.from(
                                                (row.assignedFolders ?? new Set<string>()) as Set<string>
                                            ).sort((a, b) =>
                                                a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
                                            );
                                            const n = folderList.length;
                                            if (n === 0) {
                                                return (
                                                    <span className="text-[10px] text-slate-600 italic">No folders logged</span>
                                                );
                                            }
                                            return (
                                                <details className="group/fw max-w-[min(100%,320px)]">
                                                    <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-200 select-none [&::-webkit-details-marker]:hidden">
                                                        <svg
                                                            className="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform group-open/fw:rotate-90"
                                                            fill="none"
                                                            stroke="currentColor"
                                                            viewBox="0 0 24 24"
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                strokeWidth={2}
                                                                d="M9 5l7 7-7 7"
                                                            />
                                                        </svg>
                                                        <span>폴더 {n}개</span>
                                                    </summary>
                                                    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-white/5 pt-2">
                                                        {folderList.map((folderName: string) => (
                                                            <span
                                                                key={folderName}
                                                                className="text-[10px] bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded-md border border-slate-700/50"
                                                            >
                                                                {folderName}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </details>
                                            );
                                        })()}
                                    </td>
                                </tr>
                            ))}
                            {!isLoading && processedData.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={reportBasis === 'project' ? 10 : 9}
                                        className="px-6 py-16 text-center text-slate-500 italic font-medium"
                                    >
                                        해당 기간의 작업 기록이 없습니다.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

const UserManagementView: React.FC<{ token?: string }> = ({ token }) => {
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [error, setError] = useState('');
    const [newUser, setNewUser] = useState({ username: '', password: '', accountType: 'WORKER' });
    const [editingUser, setEditingUser] = useState<string | null>(null);
    const [editPassword, setEditPassword] = useState('');

    const fetchUsers = async () => {
        try {
            const res = await fetch(apiUrl('/api/users'), {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            if (res.ok) {
                const data = await res.json();
                setUsers(data);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchUsers();
    }, []);

    const handleAddUser = async () => {
        if (!newUser.username || !newUser.password) {
            setError('아이디와 비밀번호를 모두 입력해주세요.');
            return;
        }
        try {
            const res = await fetch(apiUrl('/api/users'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify(newUser)
            });
            if (res.ok) {
                setIsAdding(false);
                setNewUser({ username: '', password: '', accountType: 'WORKER' });
                fetchUsers();
                setError('');
            } else {
                const data = await res.json();
                setError(data.message || '사용자 추가 실패');
            }
        } catch (err) {
            setError('서버 연결 오류');
        }
    };

    const handleUpdatePassword = async (username: string) => {
        if (!editPassword) return;
        try {
            const res = await fetch(apiUrl('/api/users'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({ username, password: editPassword })
            });
            if (res.ok) {
                setEditingUser(null);
                setEditPassword('');
                fetchUsers();
            }
        } catch (err) {
            console.error(err);
        }
    };

    return (
        <div className="flex flex-col h-full bg-transparent">
            <div className="px-6 py-5 border-b border-white/[0.05] bg-slate-900/60 backdrop-blur-xl flex items-center justify-between shadow-sm relative z-10">
                <div className="flex items-center gap-3">
                    <h2 className="text-xl font-heading font-bold text-white tracking-tight">사용자 관리 <span className="text-slate-500 font-medium text-sm ml-1">(User Management)</span></h2>
                    <span className="text-[10px] bg-orange-500/10 text-orange-400 px-2 py-1 rounded-md border border-orange-500/20 shadow-inner font-bold uppercase tracking-wider">Admin Mode</span>
                </div>
                {!isAdding && (
                    <button
                        onClick={() => setIsAdding(true)}
                        className="px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 text-white rounded-xl text-sm font-bold transition-all shadow-[0_0_15px_rgba(14,165,233,0.3)] border border-white/10 hover:-translate-y-0.5"
                    >
                        + 새 사용자 추가
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-y-auto p-6" data-report-scroll="true">
                {isAdding && (
                    <div className="mb-6 bg-slate-900/40 backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 shadow-xl animate-in fade-in slide-in-from-top-4">
                        <h3 className="text-white font-bold mb-5 flex items-center gap-2">
                            <svg className="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" /></svg>
                            새 사용자 계정 생성
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-5">
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Username</label>
                                <input
                                    type="text"
                                    value={newUser.username}
                                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                                    className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-sky-500/50 focus:bg-slate-900 shadow-inner transition-colors"
                                    placeholder="아이디"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Password</label>
                                <input
                                    type="password"
                                    value={newUser.password}
                                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                                    className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-sky-500/50 focus:bg-slate-900 shadow-inner transition-colors"
                                    placeholder="비밀번호"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Account Type</label>
                                <select
                                    value={newUser.accountType}
                                    onChange={(e) => setNewUser({ ...newUser, accountType: e.target.value })}
                                    className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-sky-500/50 focus:bg-slate-900 shadow-inner transition-colors appearance-none"
                                    style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2364748b' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`, backgroundPosition: `right 0.5rem center`, backgroundRepeat: `no-repeat`, backgroundSize: `1.5em 1.5em` }}
                                >
                                    <option value="WORKER" className="bg-slate-900">WORKER (작업자)</option>
                                    <option value="REVIEWER" className="bg-slate-900">REVIEWER (검수자)</option>
                                    <option value="ADMIN" className="bg-slate-900">ADMIN (관리자)</option>
                                </select>
                            </div>
                        </div>
                        {error && <div className="text-red-400/90 bg-red-500/10 border border-red-500/20 px-4 py-2 rounded-lg text-xs font-semibold mb-5">{error}</div>}
                        <div className="flex justify-end gap-3 pt-2 border-t border-white/[0.05]">
                            <button
                                onClick={() => setIsAdding(false)}
                                className="px-5 py-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-xl text-sm font-bold transition-colors"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleAddUser}
                                className="px-6 py-2 bg-sky-600/80 hover:bg-sky-500/80 text-white rounded-xl text-sm font-bold transition-all shadow-[0_0_15px_rgba(14,165,233,0.3)] border border-white/10 hover:-translate-y-0.5"
                            >
                                사용자 생성
                            </button>
                        </div>
                    </div>
                )}

                <div className="bg-slate-900/40 border border-white/[0.05] rounded-2xl overflow-hidden shadow-xl backdrop-blur-md">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="bg-slate-900/80 text-slate-400 text-[11px] font-bold uppercase tracking-wider border-b border-white/[0.05]">
                                <th className="px-6 py-4">Username</th>
                                <th className="px-6 py-4">Account Type</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.02]">
                            {users.map(user => (
                                <tr key={user.username} className="hover:bg-slate-800/50 transition-colors group">
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center gap-3">
                                            <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 border border-white/5 shadow-inner group-hover:text-sky-400 group-hover:bg-sky-500/10 transition-colors">
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                                            </div>
                                            <span className="text-slate-200 font-bold group-hover:text-white transition-colors">{user.username}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`text-[10px] font-bold px-2.5 py-1 rounded-md border shadow-inner ${user.accountType === 'ADMIN'
                                            ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                            : user.accountType === 'REVIEWER'
                                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                                                : 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                                            }`}>
                                            {user.accountType}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="flex items-center gap-2 text-[11px] font-bold text-emerald-400/90 tracking-wide uppercase">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
                                            Active
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        {editingUser === user.username ? (
                                            <div className="flex items-center justify-end gap-2">
                                                <input
                                                    type="password"
                                                    value={editPassword}
                                                    onChange={(e) => setEditPassword(e.target.value)}
                                                    placeholder="새 비번"
                                                    className="bg-slate-950/50 border border-white/[0.05] rounded-lg px-2.5 py-1.5 text-[11px] font-mono text-slate-200 outline-none w-28 focus:border-sky-500/50 shadow-inner"
                                                />
                                                <button
                                                    onClick={() => handleUpdatePassword(user.username)}
                                                    className="text-[11px] bg-sky-600/80 hover:bg-sky-500/80 text-white px-3 py-1.5 rounded-lg font-bold transition-all shadow-md"
                                                >
                                                    저장
                                                </button>
                                                <button
                                                    onClick={() => setEditingUser(null)}
                                                    className="text-[11px] bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg font-bold transition-colors"
                                                >
                                                    취소
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={() => setEditingUser(user.username)}
                                                className="p-2 text-slate-500 hover:text-sky-400 hover:bg-sky-500/10 rounded-lg transition-colors"
                                                title="비밀번호 변경"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {loading && (
                        <div className="py-20 text-center">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-500 mx-auto"></div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const WeeklyReportView: React.FC<{ validWorkers: string[]; reportBasis: ReportBasis }> = ({
    validWorkers,
    reportBasis
}) => {
    return <UnifiedReportPanel mode="WEEKLY" validWorkers={validWorkers} reportBasis={reportBasis} />;
};

const WorkerReportView: React.FC<{ validWorkers: string[]; reportBasis: ReportBasis }> = ({
    validWorkers,
    reportBasis
}) => {
    return <UnifiedReportPanel mode="MONTHLY" validWorkers={validWorkers} reportBasis={reportBasis} />;
};

const DailyReportView: React.FC<{ validWorkers: string[]; reportBasis: ReportBasis }> = ({
    validWorkers,
    reportBasis
}) => {
    return <UnifiedReportPanel mode="DAILY" validWorkers={validWorkers} reportBasis={reportBasis} />;
};

const ISSUE_REASON_LABELS: Record<string, string> = {
    BLUR: '흐림',
    CORRUPT: '이미지불량',
    WRONG_CLASS: '확인불가',
    DUPLICATE: '가려짐',
    OTHER: '기타'
};
const ISSUE_STATUS_LABELS: Record<string, string> = {
    OPEN: 'OPEN',
    IN_REVIEW: 'IN_REVIEW',
    DELETE: 'DELETE',
    RESOLVED: 'RESOLVED',
    APPROVED: 'DELETE',
    REJECTED: 'RESOLVED'
};

type ReportTab = 'DAILY' | 'WEEKLY' | 'MONTHLY';

const UnifiedReportsView: React.FC<{ validWorkers: string[], onOpenSchedule?: () => void }> = ({ validWorkers, onOpenSchedule }) => {
    const [tab, setTab] = useState<ReportTab>('DAILY');
    const [reportBasis, setReportBasis] = useState<ReportBasis>('worker');

    return (
        <div className="flex flex-col h-full bg-transparent">
            <div className="px-6 py-5 border-b border-white/[0.05] bg-slate-900/60 backdrop-blur-xl flex items-center justify-between shadow-sm relative z-10">
                <div className="flex items-center gap-3">
                    <h2 className="text-xl font-heading font-bold text-white tracking-tight">리포트 조회 <span className="text-slate-500 font-medium text-sm ml-1">(Reports)</span></h2>
                    <span className="text-[10px] bg-sky-500/10 text-sky-400 px-2 py-1 rounded-md border border-sky-500/20 shadow-inner font-bold tracking-wider">통합 뷰</span>
                </div>
                <div className="flex items-center gap-4 flex-wrap justify-end">
                    <div className="flex bg-slate-950/50 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-inner">
                        <button
                            type="button"
                            onClick={() => setReportBasis('worker')}
                            className={`px-3 py-2 rounded-lg text-xs font-bold transition-all ${reportBasis === 'worker' ? 'bg-amber-500/20 text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.25)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            작업자
                        </button>
                        <button
                            type="button"
                            onClick={() => setReportBasis('project')}
                            className={`px-3 py-2 rounded-lg text-xs font-bold transition-all ${reportBasis === 'project' ? 'bg-teal-500/20 text-teal-300 shadow-[0_0_10px_rgba(20,184,166,0.25)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            프로젝트
                        </button>
                    </div>
                    <div className="flex bg-slate-950/50 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-inner">
                        <button
                            onClick={() => setTab('DAILY')}
                            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${tab === 'DAILY' ? 'bg-sky-500/20 text-sky-400 shadow-[0_0_10px_rgba(14,165,233,0.3)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            Daily
                        </button>
                        <button
                            onClick={() => setTab('WEEKLY')}
                            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${tab === 'WEEKLY' ? 'bg-emerald-500/20 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.3)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            Weekly
                        </button>
                        <button
                            onClick={() => setTab('MONTHLY')}
                            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${tab === 'MONTHLY' ? 'bg-violet-500/20 text-violet-400 shadow-[0_0_10px_rgba(139,92,246,0.3)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            Monthly
                        </button>
                    </div>
                    {onOpenSchedule && (
                        <button
                            onClick={onOpenSchedule}
                            className="px-4 py-2 rounded-xl text-xs font-bold transition-all bg-violet-600/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 hover:text-violet-200 shadow-[0_0_15px_rgba(139,92,246,0.15)] flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                            일정관리
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 min-h-0">
                {tab === 'DAILY' ? (
                    <DailyReportView validWorkers={validWorkers} reportBasis={reportBasis} />
                ) : tab === 'WEEKLY' ? (
                    <WeeklyReportView validWorkers={validWorkers} reportBasis={reportBasis} />
                ) : (
                    <WorkerReportView validWorkers={validWorkers} reportBasis={reportBasis} />
                )}
            </div>
        </div>
    );
};

const ScheduleManagementView: React.FC<{ validWorkers: string[] }> = ({ validWorkers }) => {
    const now = new Date();
    const [selectedMonth, setSelectedMonth] = useState(() => toMonthInputValue(now));
    const [vacations, setVacations] = useState<VacationRecord[]>([]);
    const [boardRaw, setBoardRaw] = useState<Record<string, Record<string, string[]>>>({});
    const [viewMode, setViewMode] = useState<'MANAGE' | 'BOARD'>('MANAGE');
    const [form, setForm] = useState({
        userId: '__ALL__',
        startDate: toDateInputValue(now),
        endDate: toDateInputValue(now),
        note: ''
    });

    const monthRange = useMemo(() => {
        const [year, month] = selectedMonth.split('-').map(Number);
        const start = toDateInputValue(new Date(year, month - 1, 1));
        const end = toDateInputValue(new Date(year, month, 0));
        return { start, end };
    }, [selectedMonth]);

    const fetchVacations = async () => {
        const rows = await Storage.getVacations(monthRange.start, monthRange.end);
        setVacations(rows);
    };

    useEffect(() => {
        fetchVacations();
    }, [monthRange.end, monthRange.start]);

    const fetchBoard = async () => {
        const data = await Storage.getScheduleBoard(monthRange.start, monthRange.end);
        setBoardRaw(data || {});
    };

    useEffect(() => {
        fetchBoard();
    }, [monthRange.end, monthRange.start]);

    const computedDays = useMemo(
        () => countWeekdaysInRange(form.startDate, form.endDate),
        [form.endDate, form.startDate]
    );

    const monthWeekdays = useMemo(() => {
        const [year, month] = selectedMonth.split('-').map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const results: Array<{ date: string; day: number; weekday: number }> = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const d = new Date(year, month - 1, day);
            const weekday = d.getDay();
            if (weekday === 0 || weekday === 6) continue;
            results.push({
                date: toDateInputValue(d),
                day,
                weekday
            });
        }
        return results;
    }, [selectedMonth]);

    const boardByWorker = useMemo(() => {
        const normalized: Record<string, Record<string, string[]>> = {};
        Object.entries(boardRaw || {}).forEach(([rawUser, dateMap]) => {
            const worker = sanitizeWorkerName(rawUser, validWorkers);
            if (!worker) return;
            if (!normalized[worker]) normalized[worker] = {};
            Object.entries(dateMap || {}).forEach(([date, folders]) => {
                const uniqueFolders = Array.from(new Set([...(normalized[worker][date] || []), ...(folders || [])]));
                normalized[worker][date] = uniqueFolders;
            });
        });

        // Dummy worker sync: in schedule board, make "심아영" follow "김승희".
        if (normalized['김승희']) {
            const clonedByDate: Record<string, string[]> = {};
            Object.entries(normalized['김승희']).forEach(([date, folders]) => {
                clonedByDate[date] = (folders || []).map((folder) => String(folder).replace(/김승희/g, '심아영'));
            });
            normalized['심아영'] = clonedByDate;
        }

        return normalized;
    }, [boardRaw, validWorkers]);

    const compactFolderLabel = (folder: string) => {
        const raw = String(folder || '').trim();
        if (!raw) return '';
        const base = raw.split('/').pop()?.trim() || raw;
        const parts = base.split('_').map(p => p.trim()).filter(Boolean);
        const last = parts.length > 0 ? parts[parts.length - 1] : base;
        if (last.length > 14) return `${last.slice(0, 14)}…`;
        return last;
    };

    const vacationCellMap = useMemo(() => {
        const map = new Map<string, string>();
        const dateSet = new Set(monthWeekdays.map(d => d.date));
        vacations.forEach((item) => {
            const start = item.startDate > monthRange.start ? item.startDate : monthRange.start;
            const end = item.endDate < monthRange.end ? item.endDate : monthRange.end;
            if (start > end) return;
            let cursor = new Date(`${start}T00:00:00`);
            const endDate = new Date(`${end}T00:00:00`);
            while (cursor <= endDate) {
                const date = toDateInputValue(cursor);
                if (dateSet.has(date)) {
                    const label = item.note?.trim() || '휴가';
                    if (item.userId === '__ALL__') {
                        validWorkers.forEach((worker) => map.set(`${worker}|${date}`, label));
                    } else {
                        const worker = sanitizeWorkerName(item.userId, validWorkers);
                        map.set(`${worker}|${date}`, label);
                    }
                }
                cursor.setDate(cursor.getDate() + 1);
            }
        });
        return map;
    }, [monthRange.end, monthRange.start, monthWeekdays, vacations, validWorkers]);

    const handleCreate = async () => {
        if (!form.userId || !form.startDate || !form.endDate) {
            alert('필수 값을 입력해주세요.');
            return;
        }
        if (form.startDate > form.endDate) {
            alert('종료일은 시작일보다 빠를 수 없습니다.');
            return;
        }
        if (computedDays <= 0) {
            alert('주말만 선택된 구간입니다. 평일이 포함되도록 지정해주세요.');
            return;
        }
        try {
            await Storage.createVacation({
                userId: form.userId,
                startDate: form.startDate,
                endDate: form.endDate,
                days: computedDays,
                note: form.note
            });
            setForm(prev => ({ ...prev, note: '' }));
            await fetchVacations();
        } catch (e) {
            console.error(e);
            alert('일정 등록에 실패했습니다.');
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('선택한 일정을 삭제할까요?')) return;
        try {
            await Storage.deleteVacation(id);
            await fetchVacations();
        } catch (e) {
            console.error(e);
            alert('일정 삭제에 실패했습니다.');
        }
    };

    return (
        <div className="flex flex-col h-full bg-transparent">
            <div className="px-6 py-5 border-b border-white/[0.05] bg-slate-900/60 backdrop-blur-xl flex items-center justify-between shadow-sm relative z-10">
                <div className="flex items-center gap-3">
                    <h2 className="text-xl font-heading font-bold text-white tracking-tight">일정관리<span className="text-slate-500 font-medium text-sm ml-1">(Schedule Management)</span></h2>
                    <span className="text-[10px] bg-violet-500/10 text-violet-400 px-2 py-1 rounded-md border border-violet-500/20 shadow-inner font-bold tracking-wider">휴가/공휴일</span>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex bg-slate-950/50 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-inner">
                        <button
                            onClick={() => setViewMode('MANAGE')}
                            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${viewMode === 'MANAGE' ? 'bg-violet-500/20 text-violet-400 shadow-[0_0_10px_rgba(139,92,246,0.3)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            관리
                        </button>
                        <button
                            onClick={() => setViewMode('BOARD')}
                            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${viewMode === 'BOARD' ? 'bg-violet-500/20 text-violet-400 shadow-[0_0_10px_rgba(139,92,246,0.3)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            일정확인
                        </button>
                    </div>
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-slate-950/80 border border-white/10 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-200 outline-none focus:border-violet-500/50 shadow-inner [color-scheme:dark]"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6" data-report-scroll="true">
                {viewMode === 'MANAGE' && (
                    <>
                        <div className="mb-6 bg-slate-900/40 backdrop-blur-md border border-white/[0.05] rounded-2xl p-6 shadow-xl">
                            <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                                <svg className="w-5 h-5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                일정 추가/관리
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">대상 선택</label>
                                    <select
                                        value={form.userId}
                                        onChange={(e) => setForm(prev => ({ ...prev, userId: e.target.value }))}
                                        className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors appearance-none"
                                        style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2364748b' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`, backgroundPosition: `right 0.5rem center`, backgroundRepeat: `no-repeat`, backgroundSize: `1.5em 1.5em` }}
                                    >
                                        <option value="__ALL__" className="bg-slate-900 text-violet-300 font-bold">전체(공휴일)</option>
                                        {validWorkers.map(worker => (
                                            <option key={worker} value={worker} className="bg-slate-900">{worker}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">시작일</label>
                                    <input
                                        type="date"
                                        value={form.startDate}
                                        onChange={(e) => setForm(prev => ({ ...prev, startDate: e.target.value }))}
                                        className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-mono text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors [color-scheme:dark]"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">종료일</label>
                                    <input
                                        type="date"
                                        value={form.endDate}
                                        onChange={(e) => setForm(prev => ({ ...prev, endDate: e.target.value }))}
                                        className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-mono text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors [color-scheme:dark]"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">차감일수</label>
                                    <div className="w-full bg-slate-950/30 border border-white/[0.02] rounded-xl px-4 py-2.5 text-sm text-violet-300 font-mono font-bold shadow-inner flex items-center justify-center">
                                        평일 기준 {computedDays}일
                                    </div>
                                </div>
                                <div className="flex items-end">
                                    <button
                                        onClick={handleCreate}
                                        className="w-full py-2.5 rounded-xl bg-violet-600/80 hover:bg-violet-500/80 text-white text-sm font-bold shadow-[0_0_15px_rgba(139,92,246,0.3)] border border-white/10 transition-all hover:-translate-y-0.5"
                                    >
                                        일정 저장
                                    </button>
                                </div>
                            </div>
                            <div className="mt-4">
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">메모 (선택)</label>
                                <input
                                    type="text"
                                    value={form.note}
                                    onChange={(e) => setForm(prev => ({ ...prev, note: e.target.value }))}
                                    className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors"
                                    placeholder="예: 여름휴가, 공휴일, 예비군 등"
                                />
                            </div>
                        </div>

                        <div className="bg-slate-900/40 border border-white/[0.05] rounded-2xl overflow-hidden shadow-xl backdrop-blur-md">
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="bg-slate-900/80 text-slate-400 text-[11px] font-bold uppercase tracking-wider border-b border-white/[0.05]">
                                        <th className="px-6 py-4">대상 (Target)</th>
                                        <th className="px-6 py-4">시작 (Start)</th>
                                        <th className="px-6 py-4">종료 (End)</th>
                                        <th className="px-6 py-4">차감일수 (Weekdays)</th>
                                        <th className="px-6 py-4">메모 (Note)</th>
                                        <th className="px-6 py-4 text-right">관리 (Action)</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.02]">
                                    {vacations.map((item) => (
                                        <tr key={item.id} className="hover:bg-slate-800/50 transition-colors group">
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className="text-slate-200 font-bold group-hover:text-white transition-colors">
                                                    {item.userId === '__ALL__' ? (
                                                        <span className="flex items-center gap-2 text-violet-400">
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                                                            전체 (공휴일)
                                                        </span>
                                                    ) : item.userId}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-slate-300 font-mono text-[11px]">{item.startDate}</td>
                                            <td className="px-6 py-4 text-slate-300 font-mono text-[11px]">{item.endDate}</td>
                                            <td className="px-6 py-4">
                                                <span className="bg-violet-500/10 text-violet-400 border border-violet-500/20 px-2 py-1 rounded-md text-[11px] font-mono font-bold shadow-inner">
                                                    {item.days}일
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-slate-400 text-[11px]">{item.note || '-'}</td>
                                            <td className="px-6 py-4 text-right">
                                                <button
                                                    onClick={() => handleDelete(item.id)}
                                                    className="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                                    title="일정 삭제"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {vacations.length === 0 && (
                                        <tr>
                                            <td colSpan={6} className="px-6 py-12 text-center text-slate-500 italic">
                                                선택한 월에 등록된 일정이 없습니다.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}

                {viewMode === 'BOARD' && (
                    <div className="bg-slate-900/40 border border-white/[0.05] rounded-2xl overflow-hidden shadow-xl backdrop-blur-md">
                        <div className="overflow-auto pb-4 custom-scrollbar">
                            <table className="w-full text-left min-w-[1200px]">
                                <thead>
                                    <tr className="bg-slate-900/80 text-slate-400 text-[10px] font-bold uppercase tracking-wider border-b border-white/[0.05]">
                                        <th className="px-4 py-3 sticky left-0 bg-slate-900/95 z-20 min-w-[140px] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.5)]">작업자</th>
                                        {monthWeekdays.map((day) => (
                                            <th key={day.date} className="px-2 py-3 text-center min-w-[64px] border-l border-white/[0.02]">{day.day}일</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.02]">
                                    {validWorkers.map((worker) => (
                                        <tr key={worker} className="hover:bg-slate-800/50 transition-colors group">
                                            <td className="px-4 py-3 text-slate-200 font-bold sticky left-0 bg-slate-900/95 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.5)] group-hover:bg-slate-800/95 transition-colors">{worker}</td>
                                            {monthWeekdays.map((day) => {
                                                const cellLabel = vacationCellMap.get(`${worker}|${day.date}`);
                                                const workFolders = boardByWorker[worker]?.[day.date] || [];
                                                const mainFolder = workFolders[0];
                                                const moreCount = workFolders.length > 1 ? workFolders.length - 1 : 0;
                                                return (
                                                    <td key={`${worker}-${day.date}`} className="px-2 py-2 text-center">
                                                        {cellLabel ? (
                                                            <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-yellow-300 text-slate-900">
                                                                {cellLabel}
                                                            </span>
                                                        ) : mainFolder ? (
                                                            <div className="inline-flex items-center gap-1" title={workFolders.join('\n')}>
                                                                <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-900/50 text-sky-200 border border-sky-700/50">
                                                                    {compactFolderLabel(mainFolder)}
                                                                </span>
                                                                {moreCount > 0 && (
                                                                    <span className="text-[9px] text-slate-500">+{moreCount}</span>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <span className="text-slate-700">-</span>
                                                        )}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

const IssueRequestView: React.FC<{ currentAdmin: string; onSelectTask: (taskId: string, options?: SelectTaskOptions) => void }> = ({ currentAdmin, onSelectTask }) => {
    const [issues, setIssues] = useState<TaskIssue[]>([]);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [selectedStatus, setSelectedStatus] = useState<TaskIssueStatus | 'ALL'>('OPEN');
    const [isLoading, setIsLoading] = useState(false);
    const [isResolving, setIsResolving] = useState(false);

    const fetchIssues = async () => {
        setIsLoading(true);
        try {
            const data = await Storage.getTaskIssues(selectedStatus === 'ALL' ? undefined : selectedStatus);
            setIssues(data);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchIssues();
    }, [selectedStatus]);

    const resolveIssue = async (issue: TaskIssue, status: TaskIssueStatus) => {
        const confirmed = window.confirm(`요청을 ${status} 상태로 처리할까요?`);
        if (!confirmed) return;
        const note = window.prompt('처리 메모를 입력하세요 (선택)', '') || '';

        setIsResolving(true);
        try {
            const data = await Storage.updateTaskIssueStatus(issue.id, status, currentAdmin, note);
            if (data.error) throw new Error(data.error);
            await fetchIssues();
        } catch (e: any) {
            alert(`요청 처리에 실패했습니다: ${e.message || '알 수 없는 오류'}`);
        } finally {
            setIsResolving(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-900">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">Issue Requests</h2>
                    <p className="text-slate-400 text-sm mt-1">작업자가 올린 확인/삭제 요청을 처리합니다.</p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={selectedStatus}
                        onChange={(e) => setSelectedStatus(e.target.value as TaskIssueStatus | 'ALL')}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200"
                    >
                        <option value="ALL">ALL</option>
                        <option value="OPEN">OPEN</option>
                        <option value="IN_REVIEW">IN_REVIEW</option>
                        <option value="DELETE">DELETE</option>
                        <option value="RESOLVED">RESOLVED</option>
                    </select>
                    <button
                        onClick={fetchIssues}
                        className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-bold"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-slate-900/80 text-slate-400 text-xs font-bold uppercase">
                            <tr>
                                <th className="px-4 py-3">Type</th>
                                <th className="px-4 py-3">Preview</th>
                                <th className="px-4 py-3">Reason</th>
                                <th className="px-4 py-3">Folder</th>
                                <th className="px-4 py-3">Created By</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/60">
                            {issues.map(issue => (
                                <tr key={issue.id} className="hover:bg-slate-700/20">
                                    <td className="px-4 py-3 text-slate-200 font-semibold">{issue.type}</td>
                                    <td className="px-4 py-3">
                                        <div
                                            className="w-12 h-12 rounded bg-black border border-slate-700 overflow-hidden cursor-zoom-in hover:border-sky-500 transition-colors"
                                            onClick={() => setPreviewImage(resolveDatasetPublicUrl(issue.imageUrl))}
                                        >
                                            <img src={resolveDatasetPublicUrl(issue.imageUrl)} className="w-full h-full object-cover" alt="preview" />
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-slate-300">{ISSUE_REASON_LABELS[issue.reasonCode] || issue.reasonCode}</td>
                                    <td className="px-4 py-3 text-slate-400 text-xs truncate max-w-[180px]" title={issue.folder}>{issue.folder}</td>
                                    <td className="px-4 py-3 text-slate-300">{issue.createdBy}</td>
                                    <td className="px-4 py-3 text-slate-200">{ISSUE_STATUS_LABELS[issue.status] || issue.status}</td>
                                    <td className="px-4 py-3">
                                        <div className="flex gap-1 items-center">
                                            <button
                                                onClick={() => onSelectTask(issue.taskId)}
                                                disabled={isResolving}
                                                className={`px-2 py-1 text-[11px] bg-sky-700/30 border border-sky-700 text-sky-300 rounded font-bold transition-colors mr-1 ${isResolving ? 'opacity-50 cursor-not-allowed' : 'hover:bg-sky-700/50'}`}
                                            >
                                                Go to Task
                                            </button>
                                            {(issue.status === 'OPEN' || issue.status === 'IN_REVIEW') ? (
                                                <>
                                                    <button
                                                        onClick={() => resolveIssue(issue, 'DELETE')}
                                                        disabled={isResolving}
                                                        className={`px-2 py-1 text-[11px] bg-red-700/30 border border-red-700 text-red-300 rounded transition-colors ${isResolving ? 'opacity-50 cursor-not-allowed' : 'hover:bg-red-700/50'}`}
                                                    >
                                                        Delete
                                                    </button>
                                                    <button
                                                        onClick={() => resolveIssue(issue, 'RESOLVED')}
                                                        disabled={isResolving}
                                                        className={`px-2 py-1 text-[11px] bg-slate-700 border border-slate-600 text-slate-200 rounded transition-colors ml-1 ${isResolving ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-600'}`}
                                                    >
                                                        Resolve
                                                    </button>
                                                </>
                                            ) : (
                                                <span className="text-xs text-slate-500 whitespace-nowrap">-</span>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {!isLoading && issues.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-4 py-12 text-center text-slate-500 italic">요청 내역이 없습니다.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Simple Image Modal Overlay */}
            {previewImage && (
                <div
                    className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-sm flex items-center justify-center p-8 cursor-zoom-out"
                    onClick={() => setPreviewImage(null)}
                >
                    <div className="relative max-w-full max-h-full">
                        <img src={previewImage} className="max-w-full max-h-[90vh] rounded-lg shadow-2xl border border-white/10" alt="large preview" />
                        <button
                            className="absolute top-4 right-4 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 p-2 rounded-full backdrop-blur-md transition-all"
                            onClick={(e) => { e.stopPropagation(); setPreviewImage(null); }}
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

const ProjectOverviewView: React.FC<{
    onSync: () => Promise<void>;
    onFullDiskSync?: () => Promise<void>;
    onSyncFolders?: (folders: string[]) => Promise<void>;
    onAdoptFolders?: (
        paths: string[],
        projectId: string,
        assignedWorker?: string | null
    ) => Promise<void>;
    isSyncing: boolean;
    onOpenProject: (projectId: string) => void;
    overviewRefreshKey?: number;
    workerNames?: string[];
}> = ({
    onSync,
    onFullDiskSync,
    onSyncFolders,
    onAdoptFolders,
    isSyncing,
    onOpenProject,
    overviewRefreshKey = 0,
    workerNames = []
}) => {
    const [loading, setLoading] = useState<boolean>(true);
    const [savingProject, setSavingProject] = useState<boolean>(false);
    const [mappingFolder, setMappingFolder] = useState<string>('');
    const [projectName, setProjectName] = useState<string>('');
    const [projectTarget, setProjectTarget] = useState<string>('');
    const [projectWorkflowSourceType, setProjectWorkflowSourceType] = useState<'native-yolo' | 'vlm-review' | 'image-classification'>('native-yolo');
    const [projectClassificationClasses, setProjectClassificationClasses] = useState<Array<{ id: number; name: string }>>([]);
    const [vlmSourceFileOptions, setVlmSourceFileOptions] = useState<Storage.VlmAssignSourceFileInfo[]>([]);
    const [selectedVlmSourceFiles, setSelectedVlmSourceFiles] = useState<string[]>([]);
    const [projectVisibleToWorkers, setProjectVisibleToWorkers] = useState<boolean>(true);
    const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'DISK_TREE' | 'MAPPING' | 'WORKER_MAPPING' | 'ARCHIVE'>('OVERVIEW');
    const [savingWorkerFolder, setSavingWorkerFolder] = useState<string>('');
    const [workerMapProgressText, setWorkerMapProgressText] = useState<string>('');
    const [workerMapSelected, setWorkerMapSelected] = useState<Set<string>>(new Set());
    const [workerMapExpanded, setWorkerMapExpanded] = useState<Set<string>>(new Set());
    const [bulkWorkerMapValue, setBulkWorkerMapValue] = useState<string>('__NONE__');
    const [searchKeyword, setSearchKeyword] = useState<string>('');
    /** 프로젝트 매핑 탭: 프로젝트 미지정(미분류) 폴더만 */
    const [mappingUnmappedOnly, setMappingUnmappedOnly] = useState<boolean>(true);
    /** 작업자 매핑 탭: DB+맵 기준 미배정만 */
    const [workerMapUnassignedOnly, setWorkerMapUnassignedOnly] = useState<boolean>(false);
    const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set());
    const [bulkTargetProject, setBulkTargetProject] = useState<string>('');
    const [editingProjectId, setEditingProjectId] = useState<string>('');
    const [editingName, setEditingName] = useState<string>('');
    const [editingTargetTotal, setEditingTargetTotal] = useState<string>('');
    const [editingWorkflowSourceType, setEditingWorkflowSourceType] = useState<'native-yolo' | 'vlm-review' | 'image-classification'>('native-yolo');
    const [editingClassificationClasses, setEditingClassificationClasses] = useState<Array<{ id: number; name: string }>>([]);
    const [editingVlmSourceFiles, setEditingVlmSourceFiles] = useState<string[]>([]);
    const [editingVisibleToWorkers, setEditingVisibleToWorkers] = useState<boolean>(true);
    const [restoringProjectId, setRestoringProjectId] = useState<string>('');
    const [overview, setOverview] = useState<Storage.ProjectOverviewPayload>({
        projects: [],
        projectMap: {},
        workerFolderMap: {},
        unassigned: { folderCount: 0, allocated: 0, completed: 0 },
        folders: []
    });

    const refreshOverview = useCallback(async (force: boolean = false) => {
        setLoading(true);
        try {
            if (force) Storage.invalidateProjectOverviewCache();
            const data = await Storage.getProjectOverview(force);
            setOverview(data);
            setSelectedForBulk(new Set());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refreshOverview(false);
    }, [refreshOverview]);

    useEffect(() => {
        if (overviewRefreshKey > 0) void refreshOverview(true);
    }, [overviewRefreshKey, refreshOverview]);

    useEffect(() => {
        const needVlmList =
            projectWorkflowSourceType === 'vlm-review' || editingWorkflowSourceType === 'vlm-review';
        if (!needVlmList) {
            setVlmSourceFileOptions([]);
            setSelectedVlmSourceFiles([]);
            if (projectWorkflowSourceType !== 'image-classification') setProjectClassificationClasses([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const list = await Storage.getVlmAssignSourceFiles('');
                if (!cancelled) setVlmSourceFileOptions(list);
            } catch (_) {
                if (!cancelled) setVlmSourceFileOptions([]);
            }
        })();
        return () => { cancelled = true; };
    }, [projectWorkflowSourceType, editingWorkflowSourceType]);

    useEffect(() => {
        if (projectWorkflowSourceType !== 'vlm-review') return;
        let sum = 0;
        for (const sf of selectedVlmSourceFiles) {
            const row = vlmSourceFileOptions.find((r) => r.sourceFile === sf);
            if (row) sum += Number(row.total || 0);
        }
        setProjectTarget(String(sum));
    }, [projectWorkflowSourceType, selectedVlmSourceFiles, vlmSourceFileOptions]);

    const activeProjects = useMemo(
        () => overview.projects.filter((p) => p.status !== 'ARCHIVED'),
        [overview.projects]
    );
    const archivedProjects = useMemo(
        () => overview.projects.filter((p) => p.status === 'ARCHIVED'),
        [overview.projects]
    );

    useEffect(() => {
        if (!activeProjects.length) {
            setEditingProjectId('');
            setEditingName('');
            setEditingTargetTotal('');
            setEditingWorkflowSourceType('native-yolo');
            setEditingVlmSourceFiles([]);
            return;
        }
        const selected = activeProjects.find((p) => p.id === editingProjectId) || activeProjects[0];
        setEditingProjectId(selected.id);
        setEditingName(selected.name || '');
        setEditingTargetTotal(String(selected.targetTotal ?? ''));
        setEditingWorkflowSourceType(selected.workflowSourceType === 'vlm-review' ? 'vlm-review' : selected.workflowSourceType === 'image-classification' ? 'image-classification' : 'native-yolo');
        setEditingClassificationClasses(Array.isArray((selected as any).classificationClasses) ? (selected as any).classificationClasses : []);
        setEditingVlmSourceFiles(projectVlmSourceFileNames(selected));
        setEditingVisibleToWorkers(selected.visibleToWorkers !== false);
    }, [activeProjects, editingProjectId]);

    const totals = useMemo(() => {
        const totalTarget = activeProjects.reduce((acc, p) => acc + Number(p.targetTotal || 0), 0);
        const totalAllocated = activeProjects.reduce((acc, p) => acc + Number(p.allocated || 0), 0);
        const totalCompleted = activeProjects.reduce((acc, p) => acc + Number(p.completed || 0), 0);
        const progress = totalTarget > 0 ? Number(((totalCompleted / totalTarget) * 100).toFixed(2)) : 0;
        return {
            projectCount: activeProjects.length,
            totalTarget,
            totalAllocated,
            totalCompleted,
            progress
        };
    }, [activeProjects]);

    const keyword = searchKeyword.trim().toLowerCase();
    const effectiveWorkerForOverviewRow = (
        folder: string,
        rowAssigned: string | null | undefined
    ): string => {
        const wm = overview.workerFolderMap || {};
        const resolved = resolveWorkerFolderMapEntryForFolder(folder, wm);
        if (resolved?.workerName) {
            const w = String(resolved.workerName).trim();
            if (w && w.toLowerCase() !== 'unassigned') return w;
        }
        const r = rowAssigned != null ? String(rowAssigned).trim() : '';
        if (!r || r.toLowerCase() === 'unassigned') return '';
        return r;
    };

    const mappingFilteredFolders = useMemo(() => {
        return overview.folders.filter((row) => {
            if (mappingUnmappedOnly && row.projectId) return false;
            if (!keyword) return true;
            return (
                row.folder.toLowerCase().includes(keyword) ||
                String(row.assignedWorker || '').toLowerCase().includes(keyword) ||
                effectiveWorkerForOverviewRow(row.folder, row.assignedWorker).toLowerCase().includes(keyword)
            );
        });
    }, [keyword, overview.folders, overview.workerFolderMap, mappingUnmappedOnly]);

    const workerMapFilteredFolders = useMemo(() => {
        return overview.folders.filter((row) => {
            if (workerMapUnassignedOnly) {
                const eff = effectiveWorkerForOverviewRow(row.folder, row.assignedWorker);
                if (eff) return false;
            }
            if (!keyword) return true;
            const eff = effectiveWorkerForOverviewRow(row.folder, row.assignedWorker);
            return (
                row.folder.toLowerCase().includes(keyword) ||
                String(row.assignedWorker || '').toLowerCase().includes(keyword) ||
                eff.toLowerCase().includes(keyword)
            );
        });
    }, [keyword, overview.folders, overview.workerFolderMap, workerMapUnassignedOnly]);

    const workerFolderTree = useMemo(() => buildWorkerFolderTree(workerMapFilteredFolders), [workerMapFilteredFolders]);

    useEffect(() => {
        if (activeTab !== 'WORKER_MAPPING') return;
        setWorkerMapExpanded((prev) => {
            if (prev.size > 0) return prev;
            return new Set(workerFolderTree.map((n) => n.fullPath));
        });
    }, [activeTab, workerFolderTree]);

    useEffect(() => {
        if (activeTab !== 'WORKER_MAPPING') setWorkerMapSelected(new Set());
    }, [activeTab]);

    const foldersByProject = useMemo(() => {
        const map: Record<string, typeof overview.folders> = {};
        map.__UNASSIGNED__ = [];
        overview.projects.forEach((project) => {
            map[project.id] = [];
        });
        mappingFilteredFolders.forEach((folderRow) => {
            const key = folderRow.projectId || '__UNASSIGNED__';
            if (!map[key]) map[key] = [];
            map[key].push(folderRow);
        });
        return map;
    }, [mappingFilteredFolders, overview.projects]);

    const getWorkflowMismatchMessage = (row: Storage.ProjectOverviewPayload['folders'][number], projectId: string): string => {
        if (!projectId) return '';
        const project = overview.projects.find((p) => p.id === projectId);
        if (!project) return '';
        const nativeCount = Number(row.nativeTaskCount || 0);
        const vlmCount = Number(row.vlmTaskCount || 0);
        const classificationCount = Number((row as any).classificationTaskCount || 0);
        if (project.workflowSourceType === 'native-yolo' && (vlmCount > 0 || classificationCount > 0)) {
            return `YOLO 프로젝트인데 다른 타입 작업이 포함되어 있습니다.`;
        }
        if (project.workflowSourceType === 'vlm-review' && (nativeCount > 0 || classificationCount > 0)) {
            return `VLM 프로젝트인데 다른 타입 작업이 포함되어 있습니다.`;
        }
        // 이미지 분류는 DB에 native-yolo로 쌓이는 경우가 많아, VLM 혼입만 경고
        if (project.workflowSourceType === 'image-classification' && vlmCount > 0) {
            return `이미지 분류 프로젝트인데 VLM 작업이 포함되어 있습니다.`;
        }
        return '';
    };

    const mismatchCount = useMemo(() => {
        return overview.folders.filter((row) => Boolean(getWorkflowMismatchMessage(row, row.projectId || ''))).length;
    }, [overview.folders, overview.projects]);

    const handleSaveProject = async () => {
        const name = projectName.trim();
        if (!name) {
            alert('프로젝트명을 입력해주세요.');
            return;
        }
        if (projectWorkflowSourceType === 'vlm-review' && selectedVlmSourceFiles.length === 0) {
            alert('VLM 프로젝트는 원본 JSON 파일을 하나 이상 선택해주세요.');
            return;
        }
        if (projectWorkflowSourceType === 'image-classification' && projectClassificationClasses.length === 0) {
            alert('이미지 분류 프로젝트는 최소 1개 이상의 클래스를 추가해주세요.');
            return;
        }
        const targetTotal = Math.max(0, Number(projectTarget || 0));
        setSavingProject(true);
        try {
            await Storage.saveProject({
                name,
                targetTotal,
                workflowSourceType: projectWorkflowSourceType,
                vlmSourceFiles:
                    projectWorkflowSourceType === 'vlm-review' ? [...selectedVlmSourceFiles] : undefined,
                classificationClasses: projectWorkflowSourceType === 'image-classification' ? projectClassificationClasses : undefined,
                visibleToWorkers: projectVisibleToWorkers
            });
            setProjectName('');
            setProjectTarget('');
            setProjectWorkflowSourceType('native-yolo');
            setProjectClassificationClasses([]);
            setSelectedVlmSourceFiles([]);
            setVlmSourceFileOptions([]);
            setProjectVisibleToWorkers(true);
            await refreshOverview(true);
        } catch (e) {
            alert('프로젝트 저장에 실패했습니다.');
        } finally {
            setSavingProject(false);
        }
    };

    const handleUpdateProjectWorkflow = async () => {
        if (!editingProjectId) return;
        const target = activeProjects.find((p) => p.id === editingProjectId);
        if (!target) return;
        if (editingWorkflowSourceType === 'image-classification' && editingClassificationClasses.length === 0) {
            alert('이미지 분류 프로젝트는 최소 1개 이상의 클래스를 추가해주세요.');
            return;
        }
        if (editingWorkflowSourceType === 'vlm-review' && editingVlmSourceFiles.length === 0) {
            alert('VLM 프로젝트는 원본 JSON 파일을 하나 이상 선택해주세요.');
            return;
        }
        const hasMixedFolder = overview.folders.some((row) => {
            const projectId = row.projectId;
            if (projectId !== editingProjectId) return false;
            return Boolean(getWorkflowMismatchMessage(row, projectId));
        });
        if (hasMixedFolder) {
            const confirmed = window.confirm('현재 매핑된 폴더 중 타입 불일치 항목이 있습니다. 워크플로우를 변경하면 일부 폴더에서 경고가 표시됩니다. 계속할까요?');
            if (!confirmed) return;
        }
        setSavingProject(true);
        try {
            await Storage.saveProject({
                id: target.id,
                name: editingName.trim() || target.name,
                targetTotal: Math.max(0, Number(editingTargetTotal || 0)),
                workflowSourceType: editingWorkflowSourceType,
                vlmSourceFiles:
                    editingWorkflowSourceType === 'vlm-review' ? [...editingVlmSourceFiles] : undefined,
                classificationClasses: editingWorkflowSourceType === 'image-classification' ? editingClassificationClasses : undefined,
                visibleToWorkers: editingVisibleToWorkers
            });
            await refreshOverview(true);
        } catch (_e) {
            alert('프로젝트 설정 변경에 실패했습니다.');
        } finally {
            setSavingProject(false);
        }
    };

    const handleRestoreProject = async (projectId: string) => {
        if (!projectId) return;
        const ok = window.confirm('이 프로젝트를 활성 상태로 복원할까요?');
        if (!ok) return;
        setRestoringProjectId(projectId);
        try {
            await Storage.restoreProject({ projectId });
            await refreshOverview(true);
            alert('프로젝트가 복원되었습니다.');
        } catch (_e) {
            alert('프로젝트 복원에 실패했습니다.');
        } finally {
            setRestoringProjectId('');
        }
    };

    const handleWorkerFolderMapSelect = async (folder: string, workerValue: string) => {
        setSavingWorkerFolder(folder);
        setWorkerMapProgressText('매핑 저장 중…');
        try {
            const result =
                workerValue === '__NONE__'
                    ? await Storage.mapFolderToWorker(folder, null)
                    : await Storage.mapFolderToWorker(folder, workerValue);
            await refreshOverview(true);
            const t = Number(result?.tasksUpdated ?? 0);
            const v = Number(result?.vlmUpdated ?? 0);
            setWorkerMapProgressText(`반영 완료 · YOLO ${t}건, VLM ${v}건`);
            window.setTimeout(() => setWorkerMapProgressText(''), 4000);
        } catch (e) {
            setWorkerMapProgressText('');
            const detail = e instanceof Error ? e.message : String(e);
            alert(`작업자 매핑 저장에 실패했습니다.\n${detail}`);
        } finally {
            setSavingWorkerFolder('');
        }
    };

    const toggleWorkerMapPrefixSelection = (prefix: string) => {
        const paths = collectFolderPathsUnderPrefix(prefix, workerMapFilteredFolders);
        if (paths.length === 0) return;
        setWorkerMapSelected((prev) => {
            const next = new Set(prev);
            const allOn = paths.every((p) => next.has(p));
            if (allOn) paths.forEach((p) => next.delete(p));
            else paths.forEach((p) => next.add(p));
            return next;
        });
    };

    const toggleWorkerMapSingleFolder = (folder: string) => {
        setWorkerMapSelected((prev) => {
            const next = new Set(prev);
            if (next.has(folder)) next.delete(folder);
            else next.add(folder);
            return next;
        });
    };

    const handleBulkWorkerMapApply = async () => {
        if (workerMapSelected.size === 0) return;
        const worker = bulkWorkerMapValue === '__NONE__' ? null : bulkWorkerMapValue;
        const folders = Array.from(workerMapSelected);
        setSavingWorkerFolder('__BULK__');
        try {
            for (let i = 0; i < folders.length; i++) {
                const folder = folders[i]!;
                const short = folder.length > 48 ? `${folder.slice(0, 45)}…` : folder;
                setWorkerMapProgressText(`일괄 매핑: ${i + 1} / ${folders.length} — ${short}`);
                await Storage.mapFolderToWorker(folder, worker);
            }
            await refreshOverview(true);
            setWorkerMapSelected(new Set());
            setWorkerMapProgressText(`일괄 완료: ${folders.length}개 폴더`);
            window.setTimeout(() => setWorkerMapProgressText(''), 5000);
        } catch (e) {
            setWorkerMapProgressText('');
            const detail = e instanceof Error ? e.message : String(e);
            alert(`일괄 작업자 매핑에 실패했습니다.\n${detail}`);
        } finally {
            setSavingWorkerFolder('');
        }
    };

    const renderWorkerMapTreeNodes = (nodes: WorkerMapTreeNode[], depth: number): React.ReactNode => {
        const wm = overview.workerFolderMap || {};
        return nodes.map((node) => {
            const hasKids = node.children.length > 0;
            const expanded = workerMapExpanded.has(node.fullPath);
            const pathsUnder = collectFolderPathsUnderPrefix(node.fullPath, workerMapFilteredFolders);
            const selectedCount = pathsUnder.filter((p) => workerMapSelected.has(p)).length;
            const allSelected = pathsUnder.length > 0 && selectedCount === pathsUnder.length;
            const someSelected = selectedCount > 0 && !allSelected;

            const row = node.row;
            const explicit = row ? wm[row.folder]?.workerName : undefined;
            const resolved = row ? resolveWorkerFolderMapEntryForFolder(row.folder, wm) : null;
            const selectValue = explicit ? explicit : '__NONE__';

            return (
                <div key={node.fullPath} className="border-b border-slate-800/80 last:border-b-0">
                    <div
                        className="flex flex-wrap items-start gap-2 py-2 pr-2"
                        style={{ paddingLeft: Math.min(48, 8 + depth * 14) }}
                    >
                        <div className="flex items-center gap-1 shrink-0 pt-0.5">
                            {hasKids ? (
                                <button
                                    type="button"
                                    aria-label={expanded ? '접기' : '펼치기'}
                                    onClick={() =>
                                        setWorkerMapExpanded((prev) => {
                                            const n = new Set(prev);
                                            if (n.has(node.fullPath)) n.delete(node.fullPath);
                                            else n.add(node.fullPath);
                                            return n;
                                        })
                                    }
                                    className="w-7 h-7 flex items-center justify-center rounded border border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-800 text-[10px]"
                                >
                                    {expanded ? '▼' : '▶'}
                                </button>
                            ) : (
                                <span className="w-7 inline-block" />
                            )}
                            <input
                                type="checkbox"
                                title="이 노드 아래 모든 폴더 경로 선택"
                                ref={(el) => {
                                    if (el) el.indeterminate = someSelected;
                                }}
                                checked={allSelected}
                                onChange={() => toggleWorkerMapPrefixSelection(node.fullPath)}
                                className="mt-0.5 rounded border-slate-600 bg-slate-800 text-emerald-500"
                            />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-bold text-slate-100">
                                <span className="text-emerald-400/90 font-mono">{node.segment}</span>
                                {hasKids && (
                                    <span className="text-[10px] font-normal text-slate-500 ml-2">
                                        ({pathsUnder.length}폴더)
                                    </span>
                                )}
                            </div>
                            {row && (
                                <>
                                    <div className="text-xs text-slate-400 mt-0.5 break-all font-mono opacity-90">{row.folder}</div>
                                    <div className="text-xs text-slate-400 mt-1">
                                        태스크 {row.taskCount} · DB 작업자{' '}
                                        <span className="text-slate-200">{row.assignedWorker || '—'}</span>
                                    </div>
                                    {resolved ? (
                                        <div className="text-[11px] text-emerald-300 mt-1">
                                            매핑 적용: <span className="font-semibold">{resolved.workerName}</span>
                                            {' '}(키: <span className="font-mono opacity-90">{resolved.mappedKey}</span>)
                                        </div>
                                    ) : (
                                        <div className="text-[11px] text-slate-500 mt-1">적용 중인 작업자 매핑 없음</div>
                                    )}
                                </>
                            )}
                        </div>
                        {row && (
                            <div className="shrink-0 flex items-center gap-2 w-full sm:w-auto sm:min-w-[220px]">
                                <select
                                    value={selectValue}
                                    onChange={(e) => void handleWorkerFolderMapSelect(row.folder, e.target.value)}
                                    disabled={savingWorkerFolder === row.folder || workerNames.length === 0}
                                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-500 disabled:opacity-50"
                                >
                                    <option value="__NONE__">이 경로에 전용 키 없음</option>
                                    {workerNames
                                        .filter((w) => w && String(w).trim() !== '' && String(w).toLowerCase() !== 'unassigned')
                                        .map((w) => (
                                            <option key={w} value={w}>
                                                {w}
                                            </option>
                                        ))}
                                </select>
                                <input
                                    type="checkbox"
                                    title="이 폴더만 선택"
                                    checked={workerMapSelected.has(row.folder)}
                                    onChange={() => toggleWorkerMapSingleFolder(row.folder)}
                                    className="rounded border-slate-600 bg-slate-800 text-cyan-500 shrink-0"
                                />
                                {savingWorkerFolder === row.folder && (
                                    <span className="text-[11px] text-emerald-400 whitespace-nowrap">저장 중…</span>
                                )}
                            </div>
                        )}
                    </div>
                    {hasKids && expanded && (
                        <div className="border-l border-emerald-900/40 ml-[calc(8px+14px*depth+12px)]">
                            {renderWorkerMapTreeNodes(node.children, depth + 1)}
                        </div>
                    )}
                </div>
            );
        });
    };

    const handleMapFolder = async (folder: string, projectId: string) => {
        const row = overview.folders.find((item) => item.folder === folder);
        if (row && projectId) {
            const warning = getWorkflowMismatchMessage(row, projectId);
            if (warning) {
                const confirmed = window.confirm(`${warning}\n그래도 매핑할까요?`);
                if (!confirmed) return;
            }
        }
        setMappingFolder(folder);
        try {
            await Storage.mapFolderToProject(folder, projectId || null);
            await refreshOverview(true);
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            alert(`프로젝트 매핑 저장에 실패했습니다.\n${detail}`);
        } finally {
            setMappingFolder('');
        }
    };

    const handleToggleBulk = (folderName: string) => {
        setSelectedForBulk((prev) => {
            const next = new Set(prev);
            if (next.has(folderName)) next.delete(folderName);
            else next.add(folderName);
            return next;
        });
    };

    const handleToggleColumnBulk = (rows: Storage.ProjectOverviewPayload['folders']) => {
        const folderNames = rows.map((row) => row.folder);
        if (folderNames.length === 0) return;
        setSelectedForBulk((prev) => {
            const next = new Set(prev);
            const allSelected = folderNames.every((name) => next.has(name));
            if (allSelected) {
                folderNames.forEach((name) => next.delete(name));
            } else {
                folderNames.forEach((name) => next.add(name));
            }
            return next;
        });
    };

    const handleBulkMove = async () => {
        if (selectedForBulk.size === 0) return;
        if (bulkTargetProject) {
            const warnings = Array.from(selectedForBulk)
                .map((folderName) => {
                    const row = overview.folders.find((item) => item.folder === folderName);
                    if (!row) return '';
                    return getWorkflowMismatchMessage(row, bulkTargetProject);
                })
                .filter(Boolean);
            if (warnings.length > 0) {
                const confirmed = window.confirm(`선택 항목 중 ${warnings.length}개 폴더가 프로젝트 작업 방식과 불일치합니다. 그래도 이동할까요?`);
                if (!confirmed) return;
            }
        }
        setMappingFolder('__BULK__');
        try {
            const target = bulkTargetProject || null;
            for (const folderName of Array.from(selectedForBulk)) {
                await Storage.mapFolderToProject(folderName, target);
            }
            await refreshOverview(true);
            setSelectedForBulk(new Set());
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            alert(`일괄 매핑에 실패했습니다.\n${detail}`);
        } finally {
            setMappingFolder('');
        }
    };

    const handleBulkDeleteDbTasks = async () => {
        if (selectedForBulk.size === 0) return;
        const folders = Array.from(selectedForBulk);
        setMappingFolder('__BULK_DELETE__');
        try {
            const preview = await Storage.pruneDatasetsScope({
                kind: 'delete_tasks_under_folders',
                folders,
                dryRun: true
            });
            const errHint =
                preview.errors && preview.errors.length > 0 ? `\n\n경고: ${preview.errors.slice(0, 5).join('; ')}` : '';
            const ok = window.confirm(
                `선택한 ${folders.length}개 폴더 경로(접두)에 해당하는 DB 작업을 삭제합니다.\n\n` +
                    `대상 건수(시뮬): 네이티브 ${preview.deletedNative}건, VLM ${preview.deletedVlm}건${errHint}\n\n` +
                    `복구할 수 없습니다. datasets에 같은 이미지가 남아 있으면 이후 「DB 새로고침」·동기화 시 다시 등록될 수 있습니다.\n` +
                    `프로젝트/작업자 맵은 그대로입니다. 필요하면 별도로 배정 해제하세요.\n\n실제로 삭제할까요?`
            );
            if (!ok) return;
            const done = await Storage.pruneDatasetsScope({
                kind: 'delete_tasks_under_folders',
                folders,
                dryRun: false
            });
            alert(
                `삭제 완료: 네이티브 ${done.deletedNative}건, VLM ${done.deletedVlm}건` +
                    (done.errors?.length ? `\n참고: ${done.errors.slice(0, 5).join('; ')}` : '')
            );
            setSelectedForBulk(new Set());
            await refreshOverview(true);
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            alert(`DB 작업 삭제에 실패했습니다.\n${detail}`);
        } finally {
            setMappingFolder('');
        }
    };

    const renderFolderCard = (row: Storage.ProjectOverviewPayload['folders'][number]) => {
        const progress = row.taskCount > 0 ? Math.round((Number(row.completedCount || 0) / Number(row.taskCount || 1)) * 100) : 0;
        const isChecked = selectedForBulk.has(row.folder);
        const workflowWarning = getWorkflowMismatchMessage(row, row.projectId || '');
        return (
            <label key={row.folder} className={`block rounded-lg border p-3 cursor-pointer transition-colors ${workflowWarning ? 'bg-rose-900/10 border-rose-700/50' : isChecked ? 'bg-sky-900/20 border-sky-600/50' : 'bg-slate-900/40 border-slate-700 hover:border-slate-500'}`}>
                <div className="flex items-start gap-2">
                    <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleToggleBulk(row.folder)}
                        className="mt-0.5 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500/40"
                    />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-slate-100 truncate">{row.folder}</div>
                        <div className="text-xs text-slate-300 mt-1">작업자: <span className="font-medium text-slate-100">{effectiveWorkerForOverviewRow(row.folder, row.assignedWorker) || 'Unassigned'}</span></div>
                        <div className="text-[11px] text-slate-400">
                            YOLO {Number(row.nativeTaskCount || 0)} / VLM {Number(row.vlmTaskCount || 0)} / 분류{' '}
                            {Number((row as { classificationTaskCount?: number }).classificationTaskCount || 0)}
                        </div>
                        <div className="text-xs text-slate-300">완료 <span className="font-medium text-slate-100">{row.completedCount}</span> / <span className="font-medium text-slate-100">{row.taskCount}</span></div>
                        {workflowWarning && (
                            <div className="mt-1 text-[11px] text-rose-300">{workflowWarning}</div>
                        )}
                        <div className="mt-2 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, progress)}%` }} />
                        </div>
                    </div>
                </div>
            </label>
        );
    };

    return (
        <div className="flex flex-col h-full">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-sky-400">프로젝트 개요</h2>
                    <span className="text-xs bg-purple-900/40 text-purple-300 px-2 py-0.5 rounded border border-purple-800/50">관리자용</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="bg-slate-900 border border-slate-700 rounded-lg p-1 flex items-center">
                        <button
                            onClick={() => setActiveTab('OVERVIEW')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'OVERVIEW' ? 'bg-cyan-900/40 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            개요
                        </button>
                        <button
                            onClick={() => setActiveTab('DISK_TREE')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'DISK_TREE' ? 'bg-teal-900/40 text-teal-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            디스크 트리
                        </button>
                        <button
                            onClick={() => setActiveTab('MAPPING')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'MAPPING' ? 'bg-cyan-900/40 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            프로젝트 매핑
                        </button>
                        <button
                            onClick={() => setActiveTab('WORKER_MAPPING')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'WORKER_MAPPING' ? 'bg-emerald-900/40 text-emerald-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            작업자 매핑
                        </button>
                        <button
                            onClick={() => setActiveTab('ARCHIVE')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'ARCHIVE' ? 'bg-amber-900/40 text-amber-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            아카이브
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={() => void refreshOverview(true)}
                        disabled={loading}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                    >
                        새로고침
                    </button>
                    <button
                        type="button"
                        onClick={() => void onSync()}
                        disabled={isSyncing}
                        className="bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-700/50 px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                        title="디스크 스캔 없이 DB 기준으로 목록·통계만 새로고침"
                    >
                        {isSyncing ? '새로고침…' : 'DB 새로고침'}
                    </button>
                    {onFullDiskSync && (
                        <button
                            type="button"
                            onClick={() => void onFullDiskSync()}
                            disabled={isSyncing}
                            className="bg-slate-900 hover:bg-slate-800 text-amber-200/90 border border-amber-800/60 px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                            title="datasets 전체 디스크 스캔 — 매우 느릴 수 있음"
                        >
                            전체 디스크 스캔
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6 space-y-6">
                {loading && (
                    <div className="text-sm text-sky-300 bg-sky-900/20 border border-sky-700/40 rounded-lg px-4 py-3">
                        프로젝트 통계 로딩 중...
                    </div>
                )}

                {activeTab === 'OVERVIEW' ? (
                    <>
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-5 mb-8">
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-white/10 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-slate-500/10 rounded-full blur-2xl group-hover:bg-slate-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-slate-400"></div> 프로젝트 수
                                </div>
                                <div className="text-3xl font-heading font-black text-white relative z-10 tracking-tight">{totals.projectCount}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-cyan-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl group-hover:bg-cyan-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"></div> 전체 목표량
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-cyan-300 to-sky-500 relative z-10 tracking-tight">{totals.totalTarget.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-sky-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-sky-500/10 rounded-full blur-2xl group-hover:bg-sky-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]"></div> 배분량
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-sky-300 to-blue-500 relative z-10 tracking-tight">{totals.totalAllocated.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-lime-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-lime-500/10 rounded-full blur-2xl group-hover:bg-lime-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-lime-400 shadow-[0_0_8px_rgba(163,230,53,0.8)]"></div> 완료량
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-lime-300 to-green-500 relative z-10 tracking-tight">{totals.totalCompleted.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-violet-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-violet-500/10 rounded-full blur-2xl group-hover:bg-violet-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.8)]"></div> 전체 진행률
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-violet-300 to-purple-500 relative z-10 tracking-tight">{totals.progress}%</div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                            <div className="xl:col-span-2 bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
                                <h3 className="text-sm font-bold text-slate-200 mb-5 flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20">
                                        <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                                    </div>
                                    진행 중인 프로젝트
                                </h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {activeProjects.map((project) => (
                                        <button
                                            key={project.id}
                                            onClick={() => onOpenProject(project.id)}
                                            className={`text-left rounded-2xl p-4 transition-all border ${project.status === 'ARCHIVED'
                                                ? 'bg-slate-900/40 border-amber-700/20 hover:border-amber-500/40'
                                                : 'bg-slate-900/40 border-cyan-700/20 hover:border-cyan-400/40 hover:shadow-[0_0_20px_rgba(34,211,238,0.15)] hover:-translate-y-0.5'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="text-lg font-black text-white tracking-tight">{project.name}</div>
                                                <div className="flex items-center gap-1.5">
                                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border shadow-inner ${project.workflowSourceType === 'vlm-review' ? 'bg-violet-500/10 text-violet-300 border-violet-500/20' : project.workflowSourceType === 'image-classification' ? 'bg-amber-500/10 text-amber-300 border-amber-500/20' : 'bg-sky-500/10 text-sky-300 border-sky-500/20'}`}>
                                                        {WORKFLOW_LABELS[(project.workflowSourceType || 'native-yolo') as PluginSourceType]}
                                                    </span>
                                                    {project.status === 'ARCHIVED' && (
                                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border bg-amber-500/10 text-amber-300 border-amber-500/20 shadow-inner">
                                                            Archived
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="mt-4 text-sm text-slate-300 space-y-2">
                                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">목표량</span><span className="text-white font-bold">{Number(project.targetTotal || 0).toLocaleString()}</span></div>
                                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">배분량</span><span className="text-white font-bold">{Number(project.allocated || 0).toLocaleString()}</span></div>
                                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">완료량</span><span className="text-emerald-400 font-bold">{Number(project.completed || 0).toLocaleString()}</span></div>
                                            </div>
                                            <div className="mt-4 pt-4 border-t border-white/[0.05]">
                                                <div className="flex justify-between text-[11px] font-bold text-slate-400 mb-1.5">
                                                    <span>진행률</span>
                                                    <span className="text-cyan-400">{Number(project.progress || 0)}%</span>
                                                </div>
                                                <div className="h-2 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                                    <div className="h-full bg-gradient-to-r from-sky-500 to-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]" style={{ width: `${Math.min(100, Number(project.progress || 0))}%` }} />
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                    <div className="rounded-2xl p-4 border border-dashed border-violet-500/30 bg-violet-500/5">
                                        <div className="text-lg font-black text-violet-200 tracking-tight">미분류</div>
                                        <div className="mt-4 text-sm text-slate-300 space-y-2">
                                            <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">폴더 수</span><span className="text-white font-bold">{overview.unassigned.folderCount}</span></div>
                                            <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">배분량</span><span className="text-white font-bold">{Number(overview.unassigned.allocated || 0).toLocaleString()}</span></div>
                                            <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">완료량</span><span className="text-emerald-400 font-bold">{Number(overview.unassigned.completed || 0).toLocaleString()}</span></div>
                                        </div>
                                    </div>
                                </div>

                                {archivedProjects.length > 0 && (
                                    <>
                                        <h3 className="text-sm font-bold text-slate-200 mt-8 mb-5 flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center border border-amber-500/20">
                                                <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                                            </div>
                                            완료된 프로젝트
                                        </h3>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {archivedProjects.map((project) => (
                                                <button
                                                    key={project.id}
                                                    onClick={() => onOpenProject(project.id)}
                                                    className="text-left rounded-2xl p-4 transition-all border bg-slate-900/40 border-amber-700/20 hover:border-amber-500/40 hover:shadow-[0_0_20px_rgba(245,158,11,0.1)] hover:-translate-y-0.5"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="text-lg font-black text-white/70 tracking-tight">{project.name}</div>
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border bg-amber-500/10 text-amber-300 border-amber-500/20 shadow-inner">
                                                                Archived
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <div className="mt-4 text-sm text-slate-400 space-y-2">
                                                        <div className="flex justify-between items-center"><span className="font-medium">목표량</span><span className="font-bold">{Number(project.targetTotal || 0).toLocaleString()}</span></div>
                                                        <div className="flex justify-between items-center"><span className="font-medium">배분량</span><span className="font-bold">{Number(project.allocated || 0).toLocaleString()}</span></div>
                                                        <div className="flex justify-between items-center"><span className="font-medium">완료량</span><span className="text-emerald-500/70 font-bold">{Number(project.completed || 0).toLocaleString()}</span></div>
                                                    </div>
                                                    <div className="mt-4 pt-4 border-t border-white/[0.05]">
                                                        <div className="flex justify-between text-[11px] font-bold text-slate-500 mb-1.5">
                                                            <span>진행률</span>
                                                            <span className="text-amber-400/70">{Number(project.progress || 0)}%</span>
                                                        </div>
                                                        <div className="h-2 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                                            <div className="h-full bg-gradient-to-r from-amber-600 to-amber-400 opacity-60" style={{ width: `${Math.min(100, Number(project.progress || 0))}%` }} />
                                                        </div>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>

                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-[0_8px_30px_rgb(0,0,0,0.4)] flex flex-col gap-6">
                                <div>
                                    <h3 className="text-sm font-bold text-slate-200 mb-5 flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                                            <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                        </div>
                                        프로젝트 생성
                                    </h3>
                                    <div className="space-y-4">
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">프로젝트명</label>
                                            <input
                                                value={projectName}
                                                onChange={(e) => setProjectName(e.target.value)}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-emerald-500/50 focus:bg-slate-900 shadow-inner transition-colors"
                                                placeholder="예: YOLO-Phase-1"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">작업 방식</label>
                                            <select
                                                value={projectWorkflowSourceType}
                                                onChange={(e) => {
                                                    const v = e.target.value;
                                                    const next = v === 'vlm-review' ? 'vlm-review' : v === 'image-classification' ? 'image-classification' : 'native-yolo';
                                                    setProjectWorkflowSourceType(next);
                                                    if (next !== 'vlm-review') {
                                                        setProjectTarget('');
                                                        setSelectedVlmSourceFiles([]);
                                                    }
                                                    if (next !== 'image-classification') setProjectClassificationClasses([]);
                                                }}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-bold text-slate-200 outline-none focus:border-emerald-500/50 focus:bg-slate-900 shadow-inner transition-colors appearance-none"
                                            >
                                                <option value="native-yolo">YOLO (바운딩박스/클래스)</option>
                                                <option value="vlm-review">VLM (수용/거절 검수)</option>
                                                <option value="image-classification">이미지 분류</option>
                                            </select>
                                        </div>
                                        {projectWorkflowSourceType === 'image-classification' && (
                                            <div>
                                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">분류 클래스 (이름)</label>
                                                <div className="space-y-2">
                                                    {projectClassificationClasses.map((c, idx) => (
                                                        <div key={c.id} className="flex gap-2 items-center">
                                                            <input
                                                                type="text"
                                                                value={c.name}
                                                                onChange={(e) => {
                                                                    const next = [...projectClassificationClasses];
                                                                    next[idx] = { ...next[idx], name: e.target.value };
                                                                    setProjectClassificationClasses(next);
                                                                }}
                                                                className="flex-1 bg-slate-950/50 border border-white/[0.05] rounded-lg px-3 py-2 text-sm text-slate-200"
                                                                placeholder="클래스 이름"
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => setProjectClassificationClasses((prev) => prev.filter((_, i) => i !== idx))}
                                                                className="px-2 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-800/50 text-xs"
                                                            >
                                                                삭제
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button
                                                        type="button"
                                                        onClick={() => setProjectClassificationClasses((prev) => [...prev, { id: prev.length > 0 ? Math.max(...prev.map((x) => x.id)) + 1 : 0, name: '' }])}
                                                        className="text-sm text-emerald-400 hover:text-emerald-300"
                                                    >
                                                        + 클래스 추가
                                                    </button>
                                                </div>
                                                <p className="text-[10px] text-slate-500 mt-1">이미지당 선택할 클래스 목록입니다. 생성 후 프로젝트 설정에서도 수정할 수 있습니다.</p>
                                            </div>
                                        )}
                                        {projectWorkflowSourceType === 'vlm-review' && (
                                            <div>
                                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">원본 JSON 파일 (복수 선택)</label>
                                                <div className="max-h-44 overflow-y-auto rounded-xl border border-white/[0.06] bg-slate-950/50 px-3 py-2 space-y-2">
                                                    {vlmSourceFileOptions.length === 0 ? (
                                                        <p className="text-xs text-slate-500 py-2">이관된 JSON 목록을 불러오는 중이거나 항목이 없습니다.</p>
                                                    ) : (
                                                        vlmSourceFileOptions.map((row) => (
                                                            <label
                                                                key={row.sourceFile}
                                                                className="flex items-start gap-2.5 text-sm text-slate-200 cursor-pointer hover:bg-slate-900/60 rounded-lg px-1 py-1"
                                                            >
                                                                <input
                                                                    type="checkbox"
                                                                    className="mt-0.5 h-4 w-4 accent-emerald-400 shrink-0"
                                                                    checked={selectedVlmSourceFiles.includes(row.sourceFile)}
                                                                    onChange={(e) => {
                                                                        setSelectedVlmSourceFiles((prev) => {
                                                                            if (e.target.checked) {
                                                                                if (prev.includes(row.sourceFile)) return prev;
                                                                                return [...prev, row.sourceFile];
                                                                            }
                                                                            return prev.filter((f) => f !== row.sourceFile);
                                                                        });
                                                                    }}
                                                                />
                                                                <span className="leading-snug">
                                                                    <span className="font-mono text-xs text-slate-300">{row.sourceFile}</span>
                                                                    <span className="text-slate-500 text-[11px]">
                                                                        {' '}
                                                                        · 전체 {row.total}건 · 미배정 {row.unassigned}건
                                                                    </span>
                                                                </span>
                                                            </label>
                                                        ))
                                                    )}
                                                </div>
                                                <p className="text-[10px] text-slate-500 mt-1">
                                                    DB에 이관된 JSON을 여러 개 선택할 수 있습니다. 목표량은 선택한 파일의 행 수 합계로 맞춰집니다.
                                                </p>
                                            </div>
                                        )}
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">목표량</label>
                                            <input
                                                type="number"
                                                min={0}
                                                value={projectTarget}
                                                onChange={(e) => setProjectTarget(e.target.value)}
                                                readOnly={projectWorkflowSourceType === 'vlm-review' && selectedVlmSourceFiles.length > 0}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-mono text-slate-200 outline-none focus:border-emerald-500/50 focus:bg-slate-900 shadow-inner transition-colors disabled:opacity-80"
                                                placeholder="예: 50000"
                                            />
                                        </div>
                                        <label className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-slate-950/40 px-4 py-2.5">
                                            <span className="text-sm font-semibold text-slate-200">작업자에게 공개</span>
                                            <input
                                                type="checkbox"
                                                checked={projectVisibleToWorkers}
                                                onChange={(e) => setProjectVisibleToWorkers(e.target.checked)}
                                                className="h-4 w-4 accent-emerald-400"
                                            />
                                        </label>
                                        <button
                                            onClick={handleSaveProject}
                                            disabled={savingProject}
                                            className="w-full bg-emerald-600/80 hover:bg-emerald-500/80 border border-emerald-500/30 text-white rounded-xl py-2.5 text-sm font-bold shadow-[0_0_15px_rgba(16,185,129,0.2)] transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
                                        >
                                            {savingProject ? '저장 중...' : '프로젝트 저장'}
                                        </button>
                                    </div>
                                </div>
                                <div className="border-t border-white/[0.05]" />
                                <div>
                                    <h3 className="text-sm font-bold text-slate-200 mb-5 flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
                                            <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                        </div>
                                        프로젝트 설정 변경
                                    </h3>
                                    <div className="space-y-4">
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">대상 프로젝트</label>
                                            <select
                                                value={editingProjectId}
                                                onChange={(e) => {
                                                    const nextId = e.target.value;
                                                    setEditingProjectId(nextId);
                                                    const target = overview.projects.find((p) => p.id === nextId);
                                                    if (target) {
                                                        setEditingName(target.name || '');
                                                        setEditingTargetTotal(String(target.targetTotal ?? ''));
                                                        setEditingWorkflowSourceType(
                                                            target.workflowSourceType === 'vlm-review'
                                                                ? 'vlm-review'
                                                                : target.workflowSourceType === 'image-classification'
                                                                  ? 'image-classification'
                                                                  : 'native-yolo'
                                                        );
                                                        setEditingClassificationClasses(
                                                            Array.isArray((target as any).classificationClasses)
                                                                ? (target as any).classificationClasses
                                                                : []
                                                        );
                                                        setEditingVlmSourceFiles(projectVlmSourceFileNames(target));
                                                        setEditingVisibleToWorkers(target.visibleToWorkers !== false);
                                                    }
                                                }}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-bold text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors appearance-none"
                                            >
                                                {activeProjects.map((project) => (
                                                    <option key={project.id} value={project.id}>
                                                        {project.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">프로젝트 일괄 이름 변경</label>
                                            <input
                                                type="text"
                                                value={editingName}
                                                onChange={(e) => setEditingName(e.target.value)}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-bold text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">목표량</label>
                                            <input
                                                type="number"
                                                min={0}
                                                value={editingTargetTotal}
                                                onChange={(e) => setEditingTargetTotal(e.target.value)}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-mono text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors"
                                                placeholder="예: 50000"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">변경할 방식</label>
                                            <select
                                                value={editingWorkflowSourceType}
                                                onChange={(e) => {
                                                    const v = e.target.value;
                                                    const next =
                                                        v === 'vlm-review'
                                                            ? 'vlm-review'
                                                            : v === 'image-classification'
                                                              ? 'image-classification'
                                                              : 'native-yolo';
                                                    setEditingWorkflowSourceType(next);
                                                    if (next !== 'image-classification') setEditingClassificationClasses([]);
                                                    if (next !== 'vlm-review') setEditingVlmSourceFiles([]);
                                                }}
                                                className="w-full bg-slate-950/50 border border-white/[0.05] rounded-xl px-4 py-2.5 text-sm font-bold text-slate-200 outline-none focus:border-violet-500/50 focus:bg-slate-900 shadow-inner transition-colors appearance-none"
                                            >
                                                <option value="native-yolo">YOLO (바운딩박스/클래스)</option>
                                                <option value="vlm-review">VLM (수용/거절 검수)</option>
                                                <option value="image-classification">이미지 분류</option>
                                            </select>
                                        </div>
                                        {editingWorkflowSourceType === 'vlm-review' && (
                                            <div>
                                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                                                    원본 JSON 파일 (복수 선택)
                                                </label>
                                                <div className="max-h-44 overflow-y-auto rounded-xl border border-white/[0.06] bg-slate-950/50 px-3 py-2 space-y-2">
                                                    {vlmSourceFileOptions.length === 0 ? (
                                                        <p className="text-xs text-slate-500 py-2">이관된 JSON 목록을 불러오는 중이거나 항목이 없습니다.</p>
                                                    ) : (
                                                        vlmSourceFileOptions.map((row) => (
                                                            <label
                                                                key={row.sourceFile}
                                                                className="flex items-start gap-2.5 text-sm text-slate-200 cursor-pointer hover:bg-slate-900/60 rounded-lg px-1 py-1"
                                                            >
                                                                <input
                                                                    type="checkbox"
                                                                    className="mt-0.5 h-4 w-4 accent-violet-400 shrink-0"
                                                                    checked={editingVlmSourceFiles.includes(row.sourceFile)}
                                                                    onChange={(e) => {
                                                                        setEditingVlmSourceFiles((prev) => {
                                                                            if (e.target.checked) {
                                                                                if (prev.includes(row.sourceFile)) return prev;
                                                                                return [...prev, row.sourceFile];
                                                                            }
                                                                            return prev.filter((f) => f !== row.sourceFile);
                                                                        });
                                                                    }}
                                                                />
                                                                <span className="leading-snug">
                                                                    <span className="font-mono text-xs text-slate-300">{row.sourceFile}</span>
                                                                    <span className="text-slate-500 text-[11px]">
                                                                        {' '}
                                                                        · 전체 {row.total}건 · 미배정 {row.unassigned}건
                                                                    </span>
                                                                </span>
                                                            </label>
                                                        ))
                                                    )}
                                                </div>
                                                <p className="text-[10px] text-slate-500 mt-1">
                                                    프로젝트에 포함할 이관 JSON을 고릅니다. 저장 후 개요·배정 범위에 반영됩니다.
                                                </p>
                                            </div>
                                        )}
                                        {editingWorkflowSourceType === 'image-classification' && (
                                            <div>
                                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">분류 클래스 편집</label>
                                                <div className="space-y-2">
                                                    {editingClassificationClasses.map((c, idx) => (
                                                        <div key={c.id} className="flex gap-2 items-center">
                                                            <input
                                                                type="text"
                                                                value={c.name}
                                                                onChange={(e) => {
                                                                    const next = [...editingClassificationClasses];
                                                                    next[idx] = { ...next[idx], name: e.target.value };
                                                                    setEditingClassificationClasses(next);
                                                                }}
                                                                className="flex-1 bg-slate-950/50 border border-white/[0.05] rounded-lg px-3 py-2 text-sm text-slate-200"
                                                                placeholder="클래스 이름"
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => setEditingClassificationClasses((prev) => prev.filter((_, i) => i !== idx))}
                                                                className="px-2 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-800/50 text-xs"
                                                            >
                                                                삭제
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button
                                                        type="button"
                                                        onClick={() => setEditingClassificationClasses((prev) => [...prev, { id: prev.length > 0 ? Math.max(...prev.map((x) => x.id)) + 1 : 0, name: '' }])}
                                                        className="text-sm text-violet-400 hover:text-violet-300"
                                                    >
                                                        + 클래스 추가
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                        <label className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-slate-950/40 px-4 py-2.5">
                                            <span className="text-sm font-semibold text-slate-200">작업자에게 공개</span>
                                            <input
                                                type="checkbox"
                                                checked={editingVisibleToWorkers}
                                                onChange={(e) => setEditingVisibleToWorkers(e.target.checked)}
                                                className="h-4 w-4 accent-violet-400"
                                            />
                                        </label>
                                        <button
                                            onClick={handleUpdateProjectWorkflow}
                                            disabled={savingProject || !editingProjectId}
                                            className="w-full bg-violet-600/80 hover:bg-violet-500/80 border border-violet-500/30 text-white rounded-xl py-2.5 text-sm font-bold shadow-[0_0_15px_rgba(139,92,246,0.2)] transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
                                        >
                                            {savingProject ? '변경 중...' : '프로젝트 설정 변경'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </>
                ) : activeTab === 'DISK_TREE' ? (
                    <>
                        {onSyncFolders ? (
                            <DatasetsFolderTree
                                disabled={isSyncing}
                                onSyncFolders={onSyncFolders}
                                onAdoptFolders={onAdoptFolders}
                                workerNames={workerNames}
                                treeRefreshKey={overviewRefreshKey}
                            />
                        ) : (
                            <div className="text-sm text-slate-400 bg-slate-900/40 border border-slate-700 rounded-xl px-4 py-6 text-center">
                                폴더 단위 디스크 스캔(onSyncFolders)이 연결되어 있지 않습니다.
                            </div>
                        )}
                    </>
                ) : activeTab === 'MAPPING' ? (
                    <>
                        <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                            <div className="flex flex-wrap items-center gap-3">
                                <input
                                    value={searchKeyword}
                                    onChange={(e) => setSearchKeyword(e.target.value)}
                                    placeholder="폴더명/작업자 검색"
                                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500 min-w-[260px]"
                                />
                                <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                                    <input
                                        type="checkbox"
                                        checked={mappingUnmappedOnly}
                                        onChange={(e) => setMappingUnmappedOnly(e.target.checked)}
                                        className="rounded border-slate-600 bg-slate-900 text-sky-500"
                                    />
                                    미분류(프로젝트)만 보기
                                </label>
                            </div>
                        </div>

                        {mismatchCount > 0 && (
                            <div className="text-xs text-rose-200 bg-rose-900/20 border border-rose-700/40 rounded-lg px-3 py-2">
                                현재 매핑에서 작업 방식 불일치 폴더가 {mismatchCount}개 있습니다. 카드의 경고 문구를 확인해주세요.
                            </div>
                        )}
                        <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
                            <div className="bg-slate-800/20 border border-slate-700 rounded-xl p-3">
                                <div className="flex items-center justify-between mb-2 gap-2">
                                    <div className="text-xs font-bold text-amber-300">미분류 ({foldersByProject.__UNASSIGNED__?.length || 0})</div>
                                    <button
                                        type="button"
                                        onClick={() => handleToggleColumnBulk(foldersByProject.__UNASSIGNED__ || [])}
                                        className="text-[10px] px-2 py-1 rounded border border-amber-700/40 text-amber-200 hover:bg-amber-900/20"
                                        title="이 열 카드의 체크박스만 전부 선택하거나 전부 해제합니다"
                                    >
                                        {(foldersByProject.__UNASSIGNED__ || []).length > 0 && (foldersByProject.__UNASSIGNED__ || []).every((row) => selectedForBulk.has(row.folder)) ? '선택 해제' : '전체 선택'}
                                    </button>
                                </div>
                                <p className="text-[10px] text-slate-500 mb-2 leading-relaxed">
                                    프로젝트에만 안 묶인 상태입니다. DB에 잘못 들어간 작업은 아래 「DB 작업 삭제」로 지울 수 있습니다(맵은 유지).
                                </p>
                                <div className="space-y-2 max-h-[60vh] overflow-auto pr-1">
                                    {(foldersByProject.__UNASSIGNED__ || []).map(renderFolderCard)}
                                </div>
                            </div>

                            {activeProjects.map((project) => (
                                <div key={project.id} className="bg-slate-800/20 border border-slate-700 rounded-xl p-3">
                                    <div className="flex items-center justify-between mb-2 gap-2">
                                        <div className="text-xs font-bold text-cyan-300">{project.name} ({foldersByProject[project.id]?.length || 0})</div>
                                        <button
                                            type="button"
                                            onClick={() => handleToggleColumnBulk(foldersByProject[project.id] || [])}
                                            className="text-[10px] px-2 py-1 rounded border border-cyan-700/40 text-cyan-200 hover:bg-cyan-900/20"
                                            title="이 열 카드의 체크박스만 전부 선택하거나 전부 해제합니다"
                                        >
                                            {(foldersByProject[project.id] || []).length > 0 && (foldersByProject[project.id] || []).every((row) => selectedForBulk.has(row.folder)) ? '선택 해제' : '전체 선택'}
                                        </button>
                                    </div>
                                    <div className="space-y-2 max-h-[60vh] overflow-auto pr-1">
                                        {(foldersByProject[project.id] || []).map(renderFolderCard)}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {selectedForBulk.size > 0 && (
                            <div className="sticky bottom-0 bg-slate-900/95 border border-slate-700 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                                <div className="text-sm text-slate-200">
                                    선택됨: <span className="font-bold text-cyan-300">{selectedForBulk.size}</span>개 폴더
                                </div>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={bulkTargetProject}
                                        onChange={(e) => setBulkTargetProject(e.target.value)}
                                        className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-200 outline-none focus:border-sky-500 min-w-[180px]"
                                    >
                                        <option value="">미분류로 이동</option>
                                        {activeProjects.map((project) => (
                                            <option key={project.id} value={project.id}>{project.name}</option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={handleBulkMove}
                                        disabled={mappingFolder === '__BULK__' || mappingFolder === '__BULK_DELETE__'}
                                        className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-50"
                                    >
                                        {mappingFolder === '__BULK__' ? '이동 중...' : '선택 항목 이동'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleBulkDeleteDbTasks()}
                                        disabled={mappingFolder === '__BULK__' || mappingFolder === '__BULK_DELETE__'}
                                        className="px-3 py-2 rounded-lg bg-rose-900/80 hover:bg-rose-800 border border-rose-700/50 text-rose-100 text-xs font-bold disabled:opacity-50"
                                        title="선택한 폴더 문자열을 접두로 하는 imageUrl 작업을 DB에서 삭제합니다"
                                    >
                                        {mappingFolder === '__BULK_DELETE__' ? '삭제 중...' : 'DB 작업 삭제'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedForBulk(new Set())}
                                        className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-bold"
                                    >
                                        선택 해제
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                ) : activeTab === 'WORKER_MAPPING' ? (
                    <>
                        {workerMapProgressText ? (
                            <div className="text-xs text-cyan-100 bg-cyan-950/50 border border-cyan-800/60 rounded-lg px-3 py-2 font-mono leading-relaxed">
                                {workerMapProgressText}
                            </div>
                        ) : null}
                        <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4 space-y-2">
                            <p className="text-sm text-slate-300">
                                폴더 경로(접두)에 작업자를 지정하면 <span className="text-emerald-300 font-semibold">해당 폴더와 하위 경로의 모든 태스크</span>에 배정됩니다.
                                디스크의 작업자 상위 폴더보다 <span className="text-emerald-300">우선</span>합니다(동기화 시 신규 파일에도 적용). &quot;이 경로에 전용 키 없음&quot;은 이 폴더 문자열에 대한 매핑만 제거합니다.
                            </p>
                            <p className="text-xs text-slate-500">
                                <span className="text-emerald-400/80">트리</span>: 경로가 슬래시(<span className="font-mono">/</span>) 기준으로 묶입니다.{' '}
                                <span className="text-cyan-400/80">왼쪽 체크</span>는 그 아래 포함된 모든 폴더를 한 번에 선택하고, 행 오른쪽 체크는 해당 폴더만 선택합니다.
                            </p>
                        </div>
                        <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4 space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <input
                                    value={searchKeyword}
                                    onChange={(e) => setSearchKeyword(e.target.value)}
                                    placeholder="폴더명/작업자 검색"
                                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500 min-w-[260px]"
                                />
                                <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                                    <input
                                        type="checkbox"
                                        checked={workerMapUnassignedOnly}
                                        onChange={(e) => setWorkerMapUnassignedOnly(e.target.checked)}
                                        className="rounded border-slate-600 bg-slate-900 text-emerald-500"
                                    />
                                    미배정(Unassigned)만 보기
                                </label>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => setWorkerMapExpanded(new Set(collectAllExpandablePaths(workerFolderTree)))}
                                    className="text-[11px] px-2 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-200 hover:bg-emerald-900/20"
                                >
                                    트리 전체 펼치기
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setWorkerMapExpanded(new Set(workerFolderTree.map((n) => n.fullPath)))}
                                    className="text-[11px] px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800"
                                >
                                    1단계만 펼치기
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setWorkerMapExpanded(new Set())}
                                    className="text-[11px] px-2 py-1.5 rounded-lg border border-slate-600 text-slate-400 hover:bg-slate-800"
                                >
                                    모두 접기
                                </button>
                            </div>
                        </div>
                        <div className="border border-slate-700 rounded-xl overflow-hidden bg-slate-950/30">
                            <div className="max-h-[65vh] overflow-auto">
                                {workerFolderTree.length > 0 ? (
                                    renderWorkerMapTreeNodes(workerFolderTree, 0)
                                ) : (
                                    <div className="px-4 py-12 text-center text-slate-500 text-sm">표시할 폴더가 없습니다.</div>
                                )}
                            </div>
                        </div>
                        {workerMapSelected.size > 0 && (
                            <div className="sticky bottom-0 bg-slate-900/95 border border-emerald-800/50 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-lg">
                                <div className="text-sm text-slate-200">
                                    선택된 폴더 <span className="font-bold text-emerald-300">{workerMapSelected.size}</span>개
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <select
                                        value={bulkWorkerMapValue}
                                        onChange={(e) => setBulkWorkerMapValue(e.target.value)}
                                        className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-2 text-xs text-slate-200 outline-none focus:border-emerald-500 min-w-[200px]"
                                    >
                                        <option value="__NONE__">일괄: 매핑 제거</option>
                                        {workerNames
                                            .filter((w) => w && String(w).trim() !== '' && String(w).toLowerCase() !== 'unassigned')
                                            .map((w) => (
                                                <option key={w} value={w}>
                                                    일괄: {w}
                                                </option>
                                            ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => void handleBulkWorkerMapApply()}
                                        disabled={
                                            savingWorkerFolder === '__BULK__' ||
                                            (bulkWorkerMapValue !== '__NONE__' && workerNames.length === 0)
                                        }
                                        className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50"
                                    >
                                        {savingWorkerFolder === '__BULK__' ? '적용 중…' : '선택에 일괄 적용'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setWorkerMapSelected(new Set())}
                                        className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 text-xs font-bold"
                                    >
                                        선택 해제
                                    </button>
                                </div>
                            </div>
                        )}
                        {workerNames.length === 0 && (
                            <div className="text-xs text-amber-200 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">
                                등록된 작업자(WORKER) 계정이 없습니다. 사용자 관리에서 작업자를 추가한 뒤 다시 시도해주세요.
                            </div>
                        )}
                    </>
                ) : (
                    <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-bold text-slate-200">아카이브 프로젝트</h3>
                            <span className="text-xs text-slate-400">{archivedProjects.length}개</span>
                        </div>
                        <div className="space-y-2">
                            {archivedProjects.map((project) => (
                                <div key={project.id} className="rounded-lg border border-amber-700/40 bg-amber-900/10 p-3 flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-bold text-amber-100 truncate">{project.name}</div>
                                        <div className="text-[11px] text-slate-300 mt-1">
                                            목표 {Number(project.targetTotal || 0).toLocaleString()} / 완료 {Number(project.completed || 0).toLocaleString()} / 진행률 {Number(project.progress || 0)}%
                                        </div>
                                        <div className="text-[10px] text-slate-400 mt-1">
                                            아카이브 시각: {project.archivedAt ? new Date(project.archivedAt).toLocaleString() : '-'}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button
                                            onClick={() => onOpenProject(project.id)}
                                            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold"
                                        >
                                            상세 보기
                                        </button>
                                        <button
                                            onClick={() => handleRestoreProject(project.id)}
                                            disabled={restoringProjectId === project.id}
                                            className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
                                        >
                                            {restoringProjectId === project.id ? '복원 중...' : '복원'}
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {archivedProjects.length === 0 && (
                                <div className="text-sm text-slate-500 italic py-8 text-center">아카이브된 프로젝트가 없습니다.</div>
                            )}
                        </div>
                    </div>
                )}

                {mappingFolder && mappingFolder !== '__BULK__' && (
                    <div className="text-xs text-slate-500">매핑 저장 중: {mappingFolder}</div>
                )}
            </div>
        </div>
    );
};

const DashboardHomeView: React.FC = () => {
    const [loading, setLoading] = useState<boolean>(true);
    const [overview, setOverview] = useState<Storage.ProjectOverviewPayload>({
        projects: [],
        projectMap: {},
        unassigned: { folderCount: 0, allocated: 0, completed: 0 },
        folders: []
    });

    useEffect(() => {
        const fetchOverview = async () => {
            setLoading(true);
            try {
                const payload = await Storage.getProjectOverview();
                setOverview(payload || {
                    projects: [],
                    projectMap: {},
                    unassigned: { folderCount: 0, allocated: 0, completed: 0 },
                    folders: []
                });
            } finally {
                setLoading(false);
            }
        };
        fetchOverview();
    }, []);

    const workerVisibleProjects = useMemo(() => {
        return overview.projects.filter((project) => project.status !== 'ARCHIVED' && project.visibleToWorkers !== false);
    }, [overview.projects]);

    return (
        <div className="h-full overflow-auto p-6 space-y-6">
            {loading && (
                <div className="text-sm text-sky-300 bg-sky-900/20 border border-sky-700/40 rounded-lg px-4 py-3">
                    프로젝트 대시보드 로딩 중...
                </div>
            )}

            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
                <h3 className="text-sm font-bold text-slate-200 mb-5 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20">
                        <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                    </div>
                    프로젝트 카드
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {workerVisibleProjects.map((project) => (
                        <div key={project.id} className={`rounded-2xl border p-4 transition-all ${project.status === 'ARCHIVED' ? 'border-amber-700/20 bg-slate-900/40' : 'border-cyan-700/20 bg-slate-900/40 hover:border-cyan-400/40 hover:shadow-[0_0_20px_rgba(34,211,238,0.15)] hover:-translate-y-0.5'}`}>
                            <div className="flex items-center justify-between gap-2">
                                <div className="text-lg font-black text-white tracking-tight">{project.name}</div>
                                <div className="flex items-center gap-1.5">
                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border shadow-inner ${project.workflowSourceType === 'vlm-review' ? 'bg-violet-500/10 text-violet-300 border-violet-500/20' : project.workflowSourceType === 'image-classification' ? 'bg-amber-500/10 text-amber-300 border-amber-500/20' : 'bg-sky-500/10 text-sky-300 border-sky-500/20'}`}>
                                        {WORKFLOW_LABELS[(project.workflowSourceType || 'native-yolo') as PluginSourceType]}
                                    </span>
                                    {project.visibleToWorkers === false && (
                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border bg-slate-700/40 text-slate-200 border-slate-600/60 shadow-inner">
                                            Hidden
                                        </span>
                                    )}
                                    {project.status === 'ARCHIVED' && (
                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border bg-amber-500/10 text-amber-300 border-amber-500/20 shadow-inner">
                                            Archived
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="mt-4 text-sm text-slate-300 space-y-2">
                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">목표량</span><span className="text-white font-bold">{Number(project.targetTotal || 0).toLocaleString()}</span></div>
                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">배분량</span><span className="text-white font-bold">{Number(project.allocated || 0).toLocaleString()}</span></div>
                                <div className="flex justify-between items-center"><span className="text-slate-400 font-medium">완료량</span><span className="text-emerald-400 font-bold">{Number(project.completed || 0).toLocaleString()}</span></div>
                            </div>
                            <div className="mt-4 pt-4 border-t border-white/[0.05]">
                                <div className="flex justify-between text-[11px] font-bold text-slate-400 mb-1.5">
                                    <span>진행률</span>
                                    <span className="text-cyan-400">{Number(project.progress || 0)}%</span>
                                </div>
                                <div className="h-2 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                    <div className="h-full bg-gradient-to-r from-sky-500 to-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]" style={{ width: `${Math.min(100, Number(project.progress || 0))}%` }} />
                                </div>
                            </div>
                        </div>
                    ))}
                    {workerVisibleProjects.length === 0 && (
                        <div className="col-span-full text-sm text-slate-500 italic flex justify-center py-8">프로젝트 데이터가 없습니다.</div>
                    )}
                </div>
            </div>
        </div>
    );
};

const DataImportExportView: React.FC<{ onRefreshTasks: () => void; workers: string[]; onRefreshOverview?: () => void }> = ({ onRefreshTasks, workers, onRefreshOverview }) => {
    const [loadingCommit, setLoadingCommit] = useState<boolean>(false);
    const [importFiles, setImportFiles] = useState<Storage.VlmImportJsonFileInfo[]>([]);
    const [loadingImportFiles, setLoadingImportFiles] = useState<boolean>(false);
    const [selectedImportFiles, setSelectedImportFiles] = useState<Set<string>>(new Set());
    const [importDryRunResult, setImportDryRunResult] = useState<Storage.VlmJsonImportResult | null>(null);
    const [importCommitResult, setImportCommitResult] = useState<Storage.VlmJsonImportResult | null>(null);
    const [exportFiles, setExportFiles] = useState<Storage.VlmExportJsonFileInfo[]>([]);
    const [selectedExportFiles, setSelectedExportFiles] = useState<Set<string>>(new Set());
    const [loadingExportFiles, setLoadingExportFiles] = useState<boolean>(false);
    const [exportOnlySubmitted, setExportOnlySubmitted] = useState<boolean>(true);
    const [exportIncludeResult, setExportIncludeResult] = useState<boolean>(true);
    const [exportResult, setExportResult] = useState<Storage.VlmExportJsonResult | null>(null);
    const [exportProgress, setExportProgress] = useState<{
        inProgress: boolean;
        done: number;
        total: number;
        percent: number;
        currentFile: string;
    }>({ inProgress: false, done: 0, total: 0, percent: 0, currentFile: '' });

    const [projects, setProjects] = useState<Storage.ProjectDefinition[]>([]);
    const [loadingProjects, setLoadingProjects] = useState<boolean>(true);
    const [selectedProjectId, setSelectedProjectId] = useState<string>('');
    const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('json');
    const [exporting, setExporting] = useState<boolean>(false);

    const importPlanSummary = useMemo(() => {
        const selectedFiles = importFiles.filter((file) => selectedImportFiles.has(file.fileName));
        const total = selectedFiles.reduce((acc, file) => acc + Math.max(0, Number(file.totalRows || 0)), 0);
        const assigned = selectedFiles.reduce((acc, file) => acc + Math.max(0, Number(file.alreadyImportedCount ?? 0)), 0);
        const unassigned = total - assigned;
        return {
            total,
            assigned,
            unassigned,
            parseErrorCount: selectedFiles.filter((file) => Boolean(file.parseError)).length
        };
    }, [importFiles, selectedImportFiles]);

    const refreshImportFiles = async () => {
        setLoadingImportFiles(true);
        try {
            const files = await Storage.listVlmImportJsonFiles();
            setImportFiles(files);
            setSelectedImportFiles((prev) => {
                const next = new Set<string>();
                files.forEach((file) => { if (prev.has(file.fileName)) next.add(file.fileName); });
                return next;
            });
        } finally {
            setLoadingImportFiles(false);
        }
    };

    const refreshExportFiles = async () => {
        setLoadingExportFiles(true);
        try {
            const files = await Storage.listVlmExportJsonFiles();
            setExportFiles(files);
            setSelectedExportFiles((prev) => {
                const next = new Set<string>();
                files.forEach((file) => { if (prev.has(file.sourceFile)) next.add(file.sourceFile); });
                return next;
            });
        } finally {
            setLoadingExportFiles(false);
        }
    };

    useEffect(() => { refreshImportFiles(); }, []);
    useEffect(() => { refreshExportFiles(); }, []);

    const runJsonImport = async (commit: boolean) => {
        const sourceFiles = Array.from(selectedImportFiles);
        if (sourceFiles.length === 0) {
            alert('import할 json 파일을 선택해주세요.');
            return;
        }
        setLoadingCommit(true);
        try {
            const result = await Storage.importVlmJsonData({ sourceFiles, commit });
            if (commit) {
                setImportCommitResult(result);
                onRefreshTasks();
                await refreshImportFiles();
                onRefreshOverview?.();
                alert('VLM JSON import가 완료되었습니다.');
            } else {
                setImportDryRunResult(result);
            }
        } catch (e: any) {
            const msg = e?.message || (commit ? 'VLM JSON import에 실패했습니다.' : 'VLM JSON dry-run에 실패했습니다.');
            alert(commit ? `VLM JSON import 실패: ${msg}` : `VLM JSON dry-run 실패: ${msg}`);
        } finally {
            setLoadingCommit(false);
        }
    };

    const runJsonDelete = async () => {
        const sourceFiles = Array.from(selectedImportFiles);
        if (sourceFiles.length === 0) {
            alert('삭제할 json 파일을 선택해주세요.');
            return;
        }
        const ok = window.confirm(`선택한 ${sourceFiles.length}개의 json 파일로 가져온 데이터를 DB에서 완전히 삭제하시겠습니까? (복구 불가)`);
        if (!ok) return;
        setLoadingCommit(true);
        try {
            const result = await Storage.deleteVlmJsonData({ sourceFiles });
            setImportCommitResult(null);
            setImportDryRunResult(null);
            onRefreshTasks();
            await refreshImportFiles();
            onRefreshOverview?.();
            alert(`삭제 완료 (총 ${result.deletedCount || 0}건 삭제됨)`);
        } catch (e: any) {
            alert(`삭제 실패: ${e?.message || '알 수 없는 오류'}`);
        } finally {
            setLoadingCommit(false);
        }
    };

    const runJsonExport = async () => {
        const sourceFiles = Array.from(selectedExportFiles);
        if (sourceFiles.length === 0) {
            alert('export할 source file을 선택해주세요.');
            return;
        }
        setLoadingCommit(true);
        setExportProgress({ inProgress: true, done: 0, total: sourceFiles.length, percent: 0, currentFile: sourceFiles[0] || '' });
        try {
            const mergedSavedFiles: Array<{ sourceFile: string; outputPath: string; count: number }> = [];
            for (let i = 0; i < sourceFiles.length; i += 1) {
                const sourceFile = sourceFiles[i];
                setExportProgress({ inProgress: true, done: i, total: sourceFiles.length, percent: Math.round((i / Math.max(sourceFiles.length, 1)) * 100), currentFile: sourceFile });
                const partial = await Storage.exportVlmJsonData({ sourceFiles: [sourceFile], onlySubmitted: exportOnlySubmitted, includeResult: exportIncludeResult });
                if (Array.isArray(partial?.savedFiles)) mergedSavedFiles.push(...partial.savedFiles);
                setExportProgress({ inProgress: true, done: i + 1, total: sourceFiles.length, percent: Math.round(((i + 1) / Math.max(sourceFiles.length, 1)) * 100), currentFile: sourceFile });
            }
            setExportResult({ success: true, onlySubmitted: exportOnlySubmitted, savedFiles: mergedSavedFiles });
            const totalRows = mergedSavedFiles.reduce((a, f) => a + (f.count ?? 0), 0);
            if (totalRows === 0 && exportOnlySubmitted) {
                alert(
                    'VLM JSON export는 완료되었으나, 보낸 행이 0건입니다. "제출된 작업만"을 끄면 TODO·작업중 상태도 포함됩니다. 서버의 datasets/vlm_export 또는 아래 다운로드 링크를 확인하세요.'
                );
            } else {
                alert(
                    `VLM JSON export 완료: 총 ${totalRows}건, 파일 ${mergedSavedFiles.length}개. 원격 API면 파일은 API 서버 디스크에 저장됩니다. 화면의 다운로드 링크로 받을 수 있습니다.`
                );
            }
            await refreshExportFiles();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`VLM JSON export 실패: ${msg}`);
        } finally {
            setExportProgress((prev) => ({ ...prev, inProgress: false }));
            setLoadingCommit(false);
        }
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoadingProjects(true);
            try {
                const list = await Storage.getProjects();
                if (!cancelled) {
                    setProjects(list);
                    if (list.length > 0 && !selectedProjectId) {
                        const firstClassification = list.find((p: any) => p.workflowSourceType === 'image-classification');
                        if (firstClassification) setSelectedProjectId(firstClassification.id);
                    }
                }
            } finally {
                if (!cancelled) setLoadingProjects(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const classificationProjects = useMemo(
        () => projects.filter((p: any) => p.workflowSourceType === 'image-classification'),
        [projects]
    );

    const handleExportClassification = async () => {
        if (!selectedProjectId) {
            alert('프로젝트를 선택해주세요.');
            return;
        }
        setExporting(true);
        try {
            const url = apiUrl(`/api/plugins/classification/export?projectId=${encodeURIComponent(selectedProjectId)}&format=${exportFormat}`);
            const res = await fetch(url);
            const text = await res.text();
            if (!res.ok) {
                let errMsg = 'Export failed';
                try {
                    const err = JSON.parse(text);
                    if (err && typeof err.error === 'string') errMsg = err.error;
                } catch (_) {
                    if (text.startsWith('<')) errMsg = '서버가 HTML을 반환했습니다. 개발 서버(npm run dev)에서 실행 중인지, 또는 배포 환경에 이 API가 등록되어 있는지 확인하세요.';
                    else if (text.trim()) errMsg = text.slice(0, 200);
                }
                throw new Error(errMsg);
            }
            if (text.startsWith('<')) {
                throw new Error('서버가 JSON 대신 HTML을 반환했습니다. 개발 서버(npm run dev)에서 실행 중인지 확인하세요.');
            }
            let data: { success?: boolean; path?: string; error?: string };
            try {
                data = JSON.parse(text);
            } catch (_) {
                throw new Error('서버 응답이 올바른 JSON이 아닙니다.');
            }
            if (data.success && data.path) {
                alert(`저장 완료: ${data.path}`);
            } else {
                throw new Error((data as any)?.error || '내보내기에 실패했습니다.');
            }
        } catch (e: any) {
            alert(e?.message || '내보내기에 실패했습니다.');
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="h-full overflow-auto p-6 space-y-6">
            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-6 shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
                <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20">
                        <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    </div>
                    Data Import/Export
                </h2>
                <p className="text-sm text-slate-400 ml-11 mb-6">VLM JSON Import/Export 및 분류 결과 내보내기</p>

                {/* VLM JSON Import */}
                <div className="ml-11 bg-slate-900/60 border border-slate-700 rounded-2xl p-6 space-y-4 mb-6">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-sm font-bold text-slate-200">VLM JSON Import</h3>
                            <p className="text-xs text-slate-400 mt-1">datasets 또는 datasets/vlm_import의 json을 가져옵니다.</p>
                        </div>
                        <button
                            onClick={refreshImportFiles}
                            disabled={loadingImportFiles || loadingCommit}
                            className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-semibold disabled:opacity-50"
                        >
                            {loadingImportFiles ? '목록 갱신 중...' : '파일 목록 갱신'}
                        </button>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        <div className="bg-slate-950/60 border border-slate-700 rounded-lg p-3">
                            <div className="text-xs font-bold text-slate-300 mb-2">JSON 파일 선택</div>
                            <div className="max-h-56 overflow-auto space-y-1">
                                {importFiles.map((file) => (
                                    <label key={file.fileName} className="flex items-center gap-2 text-xs text-slate-200">
                                        <input
                                            type="checkbox"
                                            checked={selectedImportFiles.has(file.fileName)}
                                            onChange={(e) => {
                                                setSelectedImportFiles((prev) => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(file.fileName);
                                                    else next.delete(file.fileName);
                                                    return next;
                                                });
                                            }}
                                            className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                                        />
                                        <span className="truncate">{file.fileName}</span>
                                        <span className="ml-auto text-[10px] text-slate-400">{Number(file.totalRows || 0)} rows</span>
                                        {file.parseError && <span className="text-[10px] text-rose-300">오류</span>}
                                    </label>
                                ))}
                                {importFiles.length === 0 && <div className="text-xs text-slate-500 italic">json 파일이 없습니다.</div>}
                            </div>
                        </div>
                        <div className="bg-slate-950/60 border border-slate-700 rounded-lg p-3 space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                                    <div className="text-[10px] text-slate-500 uppercase">Total</div>
                                    <div className="text-sm font-bold text-slate-200">{importPlanSummary.total}</div>
                                </div>
                                <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                                    <div className="text-[10px] text-slate-500 uppercase">이미 Import</div>
                                    <div className="text-sm font-bold text-slate-200">{importPlanSummary.assigned}</div>
                                </div>
                                <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                                    <div className="text-[10px] text-slate-500 uppercase">미 Import</div>
                                    <div className="text-sm font-bold text-slate-200">{importPlanSummary.unassigned}</div>
                                </div>
                                <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                                    <div className="text-[10px] text-slate-500 uppercase">파싱 오류</div>
                                    <div className="text-sm font-bold text-rose-400">{importPlanSummary.parseErrorCount}</div>
                                </div>
                            </div>
                            <div className="flex gap-2 flex-wrap">
                                <button
                                    onClick={() => runJsonImport(false)}
                                    disabled={loadingCommit}
                                    className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-semibold disabled:opacity-50"
                                >
                                    Dry-run
                                </button>
                                <button
                                    onClick={() => runJsonImport(true)}
                                    disabled={loadingCommit}
                                    className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50"
                                >
                                    {loadingCommit ? '처리 중...' : 'Import 실행'}
                                </button>
                                <button
                                    onClick={runJsonDelete}
                                    disabled={loadingCommit}
                                    className="px-3 py-2 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-xs font-semibold disabled:opacity-50"
                                >
                                    선택 파일 데이터 삭제
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* VLM JSON Export */}
                <div className="ml-11 bg-slate-900/60 border border-slate-700 rounded-2xl p-6 space-y-4 mb-6">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-sm font-bold text-slate-200">VLM JSON Export</h3>
                            <p className="text-xs text-slate-400 mt-1">VLM source file별로 JSON으로 내보냅니다.</p>
                        </div>
                        <button
                            onClick={refreshExportFiles}
                            disabled={loadingExportFiles || loadingCommit}
                            className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-semibold disabled:opacity-50"
                        >
                            {loadingExportFiles ? '목록 갱신 중...' : '목록 갱신'}
                        </button>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        <div className="bg-slate-950/60 border border-slate-700 rounded-lg p-3">
                            <div className="text-xs font-bold text-slate-300 mb-2">Source file 선택</div>
                            <div className="max-h-56 overflow-auto space-y-1">
                                {exportFiles.map((file) => (
                                    <label key={file.sourceFile} className="flex items-center gap-2 text-xs text-slate-200">
                                        <input
                                            type="checkbox"
                                            checked={selectedExportFiles.has(file.sourceFile)}
                                            onChange={(e) => {
                                                setSelectedExportFiles((prev) => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(file.sourceFile);
                                                    else next.delete(file.sourceFile);
                                                    return next;
                                                });
                                            }}
                                            className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                                        />
                                        <span className="truncate">{file.sourceFile}</span>
                                        <span className="ml-auto text-[10px] text-slate-400">{file.totalTasks ?? 0} tasks</span>
                                    </label>
                                ))}
                                {exportFiles.length === 0 && <div className="text-xs text-slate-500 italic">source file이 없습니다.</div>}
                            </div>
                        </div>
                        <div className="bg-slate-950/60 border border-slate-700 rounded-lg p-3 space-y-3">
                            <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                                <input
                                    type="checkbox"
                                    checked={exportOnlySubmitted}
                                    onChange={(e) => setExportOnlySubmitted(e.target.checked)}
                                    className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                                />
                                제출된 작업만
                            </label>
                            <label className="inline-flex items-center gap-2 text-xs text-slate-300 ml-4">
                                <input
                                    type="checkbox"
                                    checked={exportIncludeResult}
                                    onChange={(e) => setExportIncludeResult(e.target.checked)}
                                    className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                                />
                                검수 결과 포함
                            </label>
                            <div className="flex gap-2">
                                <button
                                    onClick={runJsonExport}
                                    disabled={loadingCommit || exportProgress.inProgress}
                                    className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50"
                                >
                                    {exportProgress.inProgress ? `Export 중 ${exportProgress.percent}%...` : 'Export 실행'}
                                </button>
                            </div>
                            {exportResult && (
                                <div className="text-xs text-slate-400 space-y-2">
                                    <div>
                                        완료: {exportResult.savedFiles?.length ?? 0}개 파일 · 총{' '}
                                        {(exportResult.savedFiles ?? []).reduce((a, f) => a + (f.count ?? 0), 0)}건
                                    </div>
                                    <ul className="space-y-1 max-h-40 overflow-y-auto">
                                        {(exportResult.savedFiles ?? []).map((f) => (
                                            <li key={f.outputPath} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="text-slate-500">
                                                    {f.sourceFile}
                                                    <span className="text-slate-600"> ({f.count ?? 0}건)</span>
                                                </span>
                                                <a
                                                    href={resolveDatasetPublicUrl(f.outputPath)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="text-cyan-400 hover:underline shrink-0"
                                                >
                                                    다운로드
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {(importDryRunResult || importCommitResult) && (
                    <div className="ml-11 bg-slate-900/60 border border-slate-700 rounded-2xl p-4 mb-6">
                        <h4 className="text-xs font-bold text-slate-300 mb-2">VLM JSON Import 결과</h4>
                        <pre className="text-xs text-slate-400 whitespace-pre-wrap">{JSON.stringify(importCommitResult ?? importDryRunResult, null, 2)}</pre>
                    </div>
                )}

                {/* 분류 결과 내보내기 */}
                <div className="ml-11 bg-slate-900/60 border border-slate-700 rounded-2xl p-6 space-y-4">
                    <h3 className="text-sm font-bold text-slate-200">분류 결과 내보내기 (Classification Export)</h3>
                    <p className="text-xs text-slate-400">이미지 분류 프로젝트를 선택한 뒤 CSV 또는 JSON으로 내보냅니다. 파일은 datasets/classification_export 폴더에 저장됩니다.</p>
                    <div className="flex flex-wrap items-end gap-4">
                        <div className="min-w-[200px]">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">프로젝트</label>
                            <select
                                value={selectedProjectId}
                                onChange={(e) => setSelectedProjectId(e.target.value)}
                                disabled={loadingProjects}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-500 disabled:opacity-50"
                            >
                                <option value="">선택</option>
                                {classificationProjects.map((p: any) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                                {!loadingProjects && classificationProjects.length === 0 && (
                                    <option value="" disabled>이미지 분류 프로젝트 없음</option>
                                )}
                            </select>
                        </div>
                        <div className="min-w-[120px]">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">형식</label>
                            <select
                                value={exportFormat}
                                onChange={(e) => setExportFormat(e.target.value as 'csv' | 'json')}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-500"
                            >
                                <option value="json">JSON</option>
                                <option value="csv">CSV</option>
                            </select>
                        </div>
                        <button
                            onClick={handleExportClassification}
                            disabled={exporting || !selectedProjectId || loadingProjects}
                            className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 border border-amber-500/30 text-white text-sm font-bold disabled:opacity-50 disabled:hover:bg-amber-600 transition-all"
                        >
                            {exporting ? '내보내는 중...' : '내보내기'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

function sortTasksInReviewFolder(folderTasks: Task[]): Task[] {
    const isVlm = folderTasks.some((t) => t.sourceType === 'vlm-review');
    return [...folderTasks].sort((a, b) =>
        isVlm ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true })
    );
}

/** 프로젝트에 속한 폴더 경로(서버에서 불러올 범위) — 검수 큐 */
function getFolderPathsForProjectLoad(projectId: string, overview: Storage.ProjectOverviewPayload): string[] {
    const map = overview.projectMap ?? {};
    if (projectId === '__unmapped__') {
        const set = new Set<string>();
        overview.folders?.forEach((row) => {
            const pid = row.projectId ? String(row.projectId) : '';
            if (!pid) set.add(row.folder);
        });
        return [...set].sort((a, b) => a.localeCompare(b));
    }
    return Object.entries(map)
        .filter(([, v]) => String(v.projectId) === projectId)
        .map(([k]) => k)
        .sort((a, b) => a.localeCompare(b));
}

/** 관리자 검수자: 프로젝트·작업자 선택 후 해당 프로젝트 폴더만 서버에서 불러와 폴더별 요약 — 열면 검수 내비가 큐(전역) 모드 */
const ReviewQueuePanel: React.FC<{
    workers: string[];
    tasks: Task[];
    onSelectTask: (id: string, options?: SelectTaskOptions) => void;
    onRefresh: () => void;
}> = ({ workers, tasks, onSelectTask, onRefresh }) => {
    const [worker, setWorker] = useState('');
    const [selectedProjectId, setSelectedProjectId] = useState('');
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState<'pending' | 'all'>('pending');
    const [projectOverview, setProjectOverview] = useState<Storage.ProjectOverviewPayload | null>(null);
    const [loadScope, setLoadScope] = useState<{ projectId: string; worker: string } | null>(null);

    useEffect(() => {
        let cancelled = false;
        void Storage.getProjectOverview().then((o) => {
            if (!cancelled) setProjectOverview(o);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        setLoadScope(null);
    }, [selectedProjectId, worker]);

    const loadScopeOk = useMemo(() => {
        const w = String(worker || '').trim();
        if (!w || !selectedProjectId || !loadScope) return false;
        return loadScope.worker === w && loadScope.projectId === selectedProjectId;
    }, [worker, selectedProjectId, loadScope]);

    const handleLoadFromServer = useCallback(async () => {
        const w = String(worker || '').trim();
        const pid = String(selectedProjectId || '').trim();
        if (!w || !pid || !projectOverview) return;
        const folders = getFolderPathsForProjectLoad(pid, projectOverview);
        if (folders.length === 0) {
            alert(
                '이 프로젝트에 매핑된 폴더가 없습니다. 프로젝트 개요·폴더 매핑을 확인하거나, 미매핑 폴더가 없으면 다른 프로젝트를 선택해 주세요.'
            );
            return;
        }
        setLoading(true);
        try {
            await Storage.fetchAndMergeWorkerTasksForProjectFolders(w, folders);
            onRefresh();
            setLoadScope({ projectId: pid, worker: w });
        } catch {
            alert('선택한 범위의 작업을 서버에서 불러오지 못했습니다.');
        } finally {
            setLoading(false);
        }
    }, [worker, selectedProjectId, projectOverview, onRefresh]);

    const baseRows = useMemo(() => {
        if (!projectOverview || !loadScopeOk) return [];
        const w = String(worker || '').trim();
        if (!w) return [];
        const projectMap = projectOverview.projectMap ?? {};
        const scopePid = selectedProjectId;
        let list = tasks.filter((t) => String(t.assignedWorker || '').trim() === w);
        list = list.filter((t) => {
            const resolved = resolveProjectMapEntryForFolder(t.folder, projectMap);
            const pid = resolved?.projectId ?? '__unmapped__';
            return pid === scopePid;
        });
        if (filter === 'pending') {
            list = list.filter((t) => t.status === TaskStatus.SUBMITTED);
        }
        const isVlm = list.some((t) => t.sourceType === 'vlm-review');
        return [...list].sort((a, b) => {
            const fc = String(a.folder).localeCompare(String(b.folder));
            if (fc !== 0) return fc;
            return isVlm ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true });
        });
    }, [tasks, worker, filter, projectOverview, loadScopeOk, selectedProjectId]);

    const rows = baseRows;

    const projectGroups = useMemo(() => {
        const projectMap = projectOverview?.projectMap ?? {};
        const nameById = new Map<string, string>();
        projectOverview?.projects?.forEach((p) => nameById.set(String(p.id), p.name));

        const folderToTasks = new Map<string, Task[]>();
        for (const t of rows) {
            const f = t.folder;
            if (!folderToTasks.has(f)) folderToTasks.set(f, []);
            folderToTasks.get(f)!.push(t);
        }

        const byProject = new Map<string, Array<{ folder: string; tasks: Task[] }>>();
        for (const [folder, folderTasks] of folderToTasks) {
            const resolved = resolveProjectMapEntryForFolder(folder, projectMap);
            const pid = resolved?.projectId ?? '__unmapped__';
            if (!byProject.has(pid)) byProject.set(pid, []);
            byProject.get(pid)!.push({ folder, tasks: folderTasks });
        }

        const out: Array<{
            projectId: string;
            displayName: string;
            totalTasks: number;
            folders: Array<{ folder: string; tasks: Task[]; pendingInFolder: number; firstTaskId: string }>;
        }> = [];

        for (const [projectId, folderList] of byProject) {
            const displayName =
                projectId === '__unmapped__'
                    ? '프로젝트 미매핑'
                    : nameById.get(projectId) ?? `프로젝트 (${projectId})`;
            const folders = folderList
                .map(({ folder, tasks: ft }) => {
                    const sorted = sortTasksInReviewFolder(ft);
                    const first = sorted[0];
                    return {
                        folder,
                        tasks: ft,
                        pendingInFolder: ft.filter((t) => t.status === TaskStatus.SUBMITTED).length,
                        firstTaskId: first?.id ?? ''
                    };
                })
                .filter((f) => f.firstTaskId)
                .sort((a, b) => a.folder.localeCompare(b.folder, 'ko'));
            const totalTasks = folders.reduce((s, f) => s + f.tasks.length, 0);
            out.push({ projectId, displayName, folders, totalTasks });
        }

        out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
        return out;
    }, [rows, projectOverview]);

    const workerOpts = [...workers].filter(Boolean).sort((a, b) => a.localeCompare(b));

    const projectSelectOpts = useMemo(() => {
        const list = projectOverview?.projects ? [...projectOverview.projects] : [];
        list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        return list;
    }, [projectOverview]);

    const folderCountHint = useMemo(() => {
        if (!selectedProjectId || !projectOverview) return 0;
        return getFolderPathsForProjectLoad(selectedProjectId, projectOverview).length;
    }, [selectedProjectId, projectOverview]);

    return (
        <div className="h-full overflow-auto p-6 space-y-5">
            <div>
                <h2 className="text-xl font-bold text-white tracking-tight">작업자 검수 큐</h2>
                <p className="text-sm text-slate-400 mt-2 max-w-3xl leading-relaxed">
                    프로젝트와 작업자를 고른 뒤 <span className="text-purple-300">선택 범위 불러오기</span>로 해당 프로젝트에 매핑된 폴더만 서버에서 가져옵니다.
                    표시(검수 대기/전체)는 불러온 뒤 캐시에서 필터합니다. 폴더에서 <span className="text-purple-300">검수</span>를 누르면 해당 폴더의 첫 항목부터 열리고, 캔버스 이전/다음은 작업자 전체 큐 순서를 따릅니다.
                </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[16rem]">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">프로젝트</label>
                    <select
                        value={selectedProjectId}
                        onChange={(e) => setSelectedProjectId(e.target.value)}
                        disabled={!projectOverview}
                        className="w-full bg-slate-950 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-purple-500 disabled:opacity-40"
                    >
                        <option value="">프로젝트 선택…</option>
                        {projectSelectOpts.map((p) => (
                            <option key={p.id} value={String(p.id)}>
                                {p.name}
                            </option>
                        ))}
                        <option value="__unmapped__">프로젝트 미매핑</option>
                    </select>
                </div>
                <div className="min-w-[14rem]">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">작업자</label>
                    <select
                        value={worker}
                        onChange={(e) => setWorker(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-purple-500"
                    >
                        <option value="">선택…</option>
                        {workerOpts.map((w) => (
                            <option key={w} value={w}>
                                {w}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="min-w-[12rem]">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">표시</label>
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as 'pending' | 'all')}
                        className="w-full bg-slate-950 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-purple-500"
                    >
                        <option value="pending">검수 대기 (제출됨)</option>
                        <option value="all">전체 배정 건</option>
                    </select>
                </div>
                <button
                    type="button"
                    disabled={!worker || !selectedProjectId || !projectOverview || loading}
                    onClick={() => void handleLoadFromServer()}
                    className="px-4 py-2.5 rounded-lg text-sm font-bold bg-purple-900/50 hover:bg-purple-800/50 text-purple-100 border border-purple-600/50 disabled:opacity-40"
                >
                    {loading ? '불러오는 중…' : '선택 범위 불러오기'}
                </button>
            </div>
            {selectedProjectId && projectOverview ? (
                <p className="text-[11px] text-slate-500">
                    서버에서 가져올 폴더 수: <span className="font-mono text-slate-400">{folderCountHint.toLocaleString()}</span>개
                    {folderCountHint === 0 ? ' (매핑 없음 — 불러오기 시 안내)' : ''}
                </p>
            ) : null}
            {!projectOverview ? (
                <p className="text-slate-500 text-sm">프로젝트 목록을 불러오는 중…</p>
            ) : !selectedProjectId || !worker ? (
                <p className="text-slate-500 text-sm italic">프로젝트와 작업자를 선택한 뒤 「선택 범위 불러오기」를 누르세요.</p>
            ) : !loadScopeOk ? (
                <p className="text-slate-500 text-sm">
                    프로젝트·작업자를 맞춘 뒤 「선택 범위 불러오기」를 누르면 여기에 표시됩니다. 항목을 바꾼 경우에도 다시 불러오기를 눌러 주세요.
                </p>
            ) : rows.length === 0 ? (
                <p className="text-slate-500 text-sm">
                    {filter === 'pending'
                        ? '검수 대기(SUBMITTED) 태스크가 없습니다. 표시를 「전체 배정 건」으로 바꿔 보거나, 다른 프로젝트/작업자를 불러오세요.'
                        : '이 범위에 캐시된 배정 태스크가 없습니다. 폴더·배정 상태를 확인하거나 다시 불러오기를 눌러 주세요.'}
                </p>
            ) : (
                <div className="space-y-3">
                    {projectGroups.map((pg) => (
                        <details key={pg.projectId} open className="border border-slate-700 rounded-xl bg-slate-900/40 overflow-hidden group">
                            <summary className="cursor-pointer list-none px-4 py-3 bg-slate-900/80 border-b border-white/5 flex flex-wrap items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                                <span className="font-bold text-slate-100 text-sm flex items-center gap-2">
                                    <span className="text-slate-500 group-open:rotate-90 transition-transform inline-block">▸</span>
                                    {pg.displayName}
                                </span>
                                <span className="text-xs text-slate-500 font-mono">
                                    {pg.totalTasks.toLocaleString()}건 / {pg.folders.length}폴더
                                </span>
                            </summary>
                            <ul className="divide-y divide-white/5">
                                {pg.folders.map((fg) => (
                                    <li
                                        key={fg.folder}
                                        className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-800/40"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="font-mono text-xs text-slate-300 truncate" title={fg.folder}>
                                                {fg.folder}
                                            </p>
                                            <p className="text-[11px] text-slate-500 mt-1">
                                                {fg.tasks.length.toLocaleString()}건
                                                {filter === 'all' && fg.pendingInFolder > 0 ? (
                                                    <span className="text-amber-200/80"> · 검수 대기 {fg.pendingInFolder.toLocaleString()}건</span>
                                                ) : null}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onSelectTask(fg.firstTaskId, {
                                                    reviewerScopeWorker: String(worker).trim(),
                                                    reviewerNavMode: 'queue',
                                                    reviewerQueueFilter: filter,
                                                    reviewerQueueProjectId: selectedProjectId
                                                })
                                            }
                                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-900/40 text-purple-200 border border-purple-600/40 hover:bg-purple-800/50"
                                        >
                                            검수
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ))}
                    <div className="px-1 text-[11px] text-slate-500">
                        합계 {rows.length.toLocaleString()}건 (캐시 기준) · 폴더의 검수는 해당 폴더에서 정렬된 첫 태스크부터 열립니다.
                    </div>
                </div>
            )}
        </div>
    );
};

const FOLDER_TABLE_COLS_STORAGE_KEY = 'yolo_projectDetail_folderTableCols';
const DEFAULT_FOLDER_COL_WIDTHS_NATIVE = [280, 144, 104, 136, 176, 112];
const DEFAULT_FOLDER_COL_WIDTHS_VLM = [280, 160, 104, 136, 176, 112];

function loadFolderTableColWidths(): { native: number[]; vlm: number[] } {
    const clamp = (arr: unknown, def: number[]) =>
        Array.isArray(arr) && arr.length === 6 && arr.every((x) => typeof x === 'number' && Number(x) >= 48)
            ? (arr as number[]).map((n) => Math.round(Number(n)))
            : [...def];
    try {
        const raw = localStorage.getItem(FOLDER_TABLE_COLS_STORAGE_KEY);
        if (raw) {
            const j = JSON.parse(raw) as { native?: unknown; vlm?: unknown };
            return {
                native: clamp(j?.native, DEFAULT_FOLDER_COL_WIDTHS_NATIVE),
                vlm: clamp(j?.vlm, DEFAULT_FOLDER_COL_WIDTHS_VLM)
            };
        }
    } catch {
        /* ignore */
    }
    return {
        native: [...DEFAULT_FOLDER_COL_WIDTHS_NATIVE],
        vlm: [...DEFAULT_FOLDER_COL_WIDTHS_VLM]
    };
}

function formatProjectDetailStatsFetchedAt(ts: number): string {
    return new Date(ts).toLocaleString('ko-KR', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

const ProjectDetailView: React.FC<{ projectId: string; role: string; onBack: () => void; onOpenFolder: (folderName: string, workflowSourceType?: 'native-yolo' | 'vlm-review' | 'image-classification') => void; onArchived?: () => void; onRefresh?: () => void; onRefreshTasksFromServer?: () => Promise<void>; onSyncProject?: (projectId: string) => Promise<void>; workerNames?: string[]; tasks: Task[]; onSelectTask: (id: string, options?: SelectTaskOptions) => void }> = ({ projectId, role, onBack, onOpenFolder, onArchived, onRefresh, onRefreshTasksFromServer, onSyncProject, workerNames = [], tasks, onSelectTask }) => {
    const [days, setDays] = useState<number>(30);
    const [loading, setLoading] = useState<boolean>(true);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const [archiving, setArchiving] = useState<boolean>(false);
    const [folderWorkerFilter, setFolderWorkerFilter] = useState<string>('ALL');
    const [detail, setDetail] = useState<Storage.ProjectDetailPayload | null>(null);
    const [showVlmModal, setShowVlmModal] = useState<boolean>(false);
    const [vlmAssignCount, setVlmAssignCount] = useState<string>('10');
    const [vlmAssignWorker, setVlmAssignWorker] = useState<string>('');
    const [vlmUnassignCount, setVlmUnassignCount] = useState<string>('10');
    const [vlmUnassignWorker, setVlmUnassignWorker] = useState<string>('');
    const [vlmAssigning, setVlmAssigning] = useState<boolean>(false);
    const [vlmUnassigning, setVlmUnassigning] = useState<boolean>(false);
    const [vlmModalSourceRows, setVlmModalSourceRows] = useState<Storage.VlmAssignSourceFileInfo[]>([]);
    const [vlmModalSelectedSourceFiles, setVlmModalSelectedSourceFiles] = useState<string[]>([]);
    const [showNativeAssignModal, setShowNativeAssignModal] = useState<boolean>(false);
    const [nativeAssignCount, setNativeAssignCount] = useState<string>('10');
    const [nativeAssignWorker, setNativeAssignWorker] = useState<string>('');
    const [nativeUnassignCount, setNativeUnassignCount] = useState<string>('10');
    const [nativeUnassignWorker, setNativeUnassignWorker] = useState<string>('');
    const [nativeAssigning, setNativeAssigning] = useState<boolean>(false);
    const [nativeUnassigning, setNativeUnassigning] = useState<boolean>(false);
    const [unassigningFolder, setUnassigningFolder] = useState<string | null>(null);
    const [folderTableCols, setFolderTableCols] = useState(loadFolderTableColWidths);
    const [detailStatsFetchedAt, setDetailStatsFetchedAt] = useState<number | null>(null);
    const [detailStatsFetchPending, setDetailStatsFetchPending] = useState(false);

    const fetchDetail = useCallback(async (force: boolean = false) => {
        const cacheKey = `${projectId}::${days}`;
        const cached = projectDetailCache.get(cacheKey);
        if (!force && cached) {
            setDetail(cached.payload || null);
            setDetailStatsFetchedAt(cached.fetchedAt);
            setLoading(false);
            return;
        }
        if (!force) setLoading(true);
        setDetailStatsFetchPending(true);
        try {
            const payload = await Storage.getProjectDetail(projectId, days);
            const now = Date.now();
            setDetail(payload);
            projectDetailCache.set(cacheKey, { fetchedAt: now, payload: payload || null });
            setDetailStatsFetchedAt(now);
        } finally {
            setDetailStatsFetchPending(false);
            setLoading(false);
        }
    }, [projectId, days]);

    /**
     * 지표 새로고침·자동 갱신 공통: 델타로 로컬 tasks 맞춘 뒤 상세 API 재조회.
     * (작업자 표의 검수 수 등은 네이티브일 때 tasks 캐시를 쓰므로 fetchDetail 만으로는 부족함)
     */
    const runProjectDetailMetricsRefresh = useCallback(
        async (options?: { showUiRefreshing?: boolean }) => {
            const showUi = options?.showUiRefreshing === true;
            if (showUi) setRefreshing(true);
            try {
                await Storage.syncTasksDelta();
                onRefresh?.();
                await fetchDetail(true);
            } finally {
                if (showUi) setRefreshing(false);
            }
        },
        [fetchDetail, onRefresh]
    );

    useEffect(() => {
        void fetchDetail(false);
    }, [fetchDetail]);

    /** 배정·맵 변경 등으로 overview 캐시가 무효화될 때 상세 통계도 같은 시점에 맞춤 (/api/projects/detail 재조회) */
    useEffect(() => {
        const ev = Storage.PROJECT_OVERVIEW_INVALIDATE_EVENT;
        const onOverviewInvalidate = () => {
            for (const k of [...projectDetailCache.keys()]) {
                if (k.startsWith(`${projectId}::`)) projectDetailCache.delete(k);
            }
            void runProjectDetailMetricsRefresh({ showUiRefreshing: false });
        };
        window.addEventListener(ev, onOverviewInvalidate);
        return () => window.removeEventListener(ev, onOverviewInvalidate);
    }, [projectId, runProjectDetailMetricsRefresh]);

    /** 주기적 갱신 = 지표 새로고침과 동일(델타 + tasks 반영 + detail). 백그라운드 탭은 생략 */
    useEffect(() => {
        const tick = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void runProjectDetailMetricsRefresh({ showUiRefreshing: false });
        };
        const id = window.setInterval(tick, PROJECT_DETAIL_POLL_MS);
        return () => window.clearInterval(id);
    }, [projectId, days, runProjectDetailMetricsRefresh]);

    const handleRefreshDetail = async () => {
        await runProjectDetailMetricsRefresh({ showUiRefreshing: true });
    };

    const handleUnassignFolderRow = async (folder: string) => {
        if (!folder.trim() || isArchived) return;
        const ok = window.confirm(
            `"${folder}" 폴더의 프로젝트 연결과 작업자 배정을 모두 해제할까요?\n프로젝트 맵·작업자 맵이 지워지고, DB의 project_id·assignedWorker도 해당 트리에서 비워집니다.`
        );
        if (!ok) return;
        setUnassigningFolder(folder);
        try {
            await Storage.mapFolderToProject(folder, null);
            await Storage.mapFolderToWorker(folder, null);
            Array.from(projectDetailCache.keys()).forEach((key) => {
                if (key.startsWith(`${projectId}::`)) projectDetailCache.delete(key);
            });
            Storage.invalidateProjectOverviewCache();
            alert(
                '배정 해제를 서버에 반영했습니다.\n\n' +
                    '화면·작업 목록·디스크와의 일치는 자동으로 맞추지 않습니다. 필요할 때 아래를 직접 실행해 주세요.\n' +
                    '· 이 화면 통계: 「지표 새로고침」\n' +
                    '· 작업 목록 캐시: 상단 「DB 새로고침」\n' +
                    '· datasets 스캔 반영: 「이 프로젝트만 동기화」'
            );
        } catch (e) {
            alert(e instanceof Error ? e.message : String(e));
        } finally {
            setUnassigningFolder(null);
        }
    };

    const project = detail?.project;
    const trends = detail?.trends || [];
    const workers = detail?.workers || [];
    const folders = useMemo(
        () => (Array.isArray(detail?.folders) ? detail!.folders : []),
        [detail?.folders]
    );
    const isVlmProjectDetail = project?.workflowSourceType === 'vlm-review';
    const folderWorkerOptions = useMemo(() => {
        const names = Array.from(new Set(folders.map((row) => String(row.assignedWorker || 'Unassigned').trim() || 'Unassigned')));
        return names.sort((a, b) => a.localeCompare(b));
    }, [folders]);
    const filteredFolders = useMemo(() => {
        if (!isVlmProjectDetail) return folders;
        if (folderWorkerFilter === 'ALL') return folders;
        return folders.filter((row) => (String(row.assignedWorker || 'Unassigned').trim() || 'Unassigned') === folderWorkerFilter);
    }, [folders, folderWorkerFilter, isVlmProjectDetail]);
    const isArchived = Boolean(detail?.isArchived || project?.status === 'ARCHIVED');

    const folderTableWidths = isVlmProjectDetail ? folderTableCols.vlm : folderTableCols.native;

    const onFolderTableColResizeStart = useCallback(
        (colIndex: number, e: React.PointerEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const grip = e.currentTarget;
            grip.setPointerCapture(e.pointerId);
            const mode = isVlmProjectDetail ? ('vlm' as const) : ('native' as const);
            const startX = e.clientX;
            const startWidths = [...folderTableCols[mode]];
            const minW = 56;

            const onMove = (ev: PointerEvent) => {
                const delta = ev.clientX - startX;
                const nw = Math.max(minW, startWidths[colIndex] + delta);
                setFolderTableCols((prev) => ({
                    ...prev,
                    [mode]: prev[mode].map((w, i) => (i === colIndex ? nw : w))
                }));
            };
            const onUp = (ev: PointerEvent) => {
                window.removeEventListener('pointermove', onMove);
                grip.releasePointerCapture(ev.pointerId);
                setFolderTableCols((prev) => {
                    try {
                        localStorage.setItem(FOLDER_TABLE_COLS_STORAGE_KEY, JSON.stringify(prev));
                    } catch {
                        /* ignore */
                    }
                    return prev;
                });
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        },
        [isVlmProjectDetail, folderTableCols]
    );

    useEffect(() => {
        if (folderWorkerFilter === 'ALL') return;
        if (!folderWorkerOptions.includes(folderWorkerFilter)) {
            setFolderWorkerFilter('ALL');
        }
    }, [folderWorkerFilter, folderWorkerOptions]);

    useEffect(() => {
        if (!showVlmModal) return;
        let cancelled = false;
        (async () => {
            try {
                const list = await Storage.getVlmAssignSourceFiles(projectId);
                if (cancelled) return;

                if (project?.workflowSourceType !== 'vlm-review') {
                    setVlmModalSourceRows(list);
                    setVlmModalSelectedSourceFiles(list.map((r) => r.sourceFile));
                    return;
                }

                const pid = String(projectId || '').trim();
                let allowed = projectVlmSourceFileNamesFromUnknown(project ?? undefined);

                if (allowed.length === 0) {
                    try {
                        const all = await Storage.getProjects();
                        const fromList = all.find((p) => String(p.id || '').trim() === pid);
                        allowed = projectVlmSourceFileNamesFromUnknown(fromList);
                    } catch {
                        /* ignore */
                    }
                }

                if (allowed.length === 0) {
                    try {
                        const ov = await Storage.getProjectOverview(false);
                        const fromOv = ov.projects.find((p) => String(p.id || '').trim() === pid);
                        allowed = projectVlmSourceFileNamesFromUnknown(fromOv);
                    } catch {
                        /* ignore */
                    }
                }

                if (allowed.length === 0) {
                    allowed = inferVlmJsonNamesFromFolders(folders);
                }

                if (allowed.length === 0) {
                    setVlmModalSourceRows([]);
                    setVlmModalSelectedSourceFiles([]);
                    return;
                }

                const lookup = buildVlmAssignStatsLookup(list);
                const rows = allowed.map((sf) => {
                    const hit = lookupVlmAssignStats(lookup, sf);
                    const canonical = hit?.sourceFile ?? sf;
                    return (
                        hit ?? {
                            sourceFile: canonical,
                            total: 0,
                            unassigned: 0
                        }
                    );
                });
                setVlmModalSourceRows(rows);
                setVlmModalSelectedSourceFiles(rows.map((r) => r.sourceFile));
            } catch {
                if (!cancelled) {
                    setVlmModalSourceRows([]);
                    setVlmModalSelectedSourceFiles([]);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [showVlmModal, projectId, project?.workflowSourceType, project?.vlmSourceFiles, project?.vlmSourceFile, folders]);

    const handleArchiveProject = async () => {
        if (!project?.id || !detail) return;
        if (isArchived) {
            alert('이미 아카이브된 프로젝트입니다.');
            return;
        }
        const ok = window.confirm('이 프로젝트를 아카이브할까요?\n데이터셋 파일은 건드리지 않고, 현재 기록/통계 스냅샷만 저장합니다.');
        if (!ok) return;
        setArchiving(true);
        try {
            await Storage.archiveProject({ projectId: project.id, snapshot: detail });
            Array.from(projectDetailCache.keys()).forEach((key) => {
                if (key.startsWith(`${project.id}::`)) {
                    projectDetailCache.delete(key);
                }
            });
            Storage.invalidateProjectOverviewCache();
            alert('프로젝트 아카이브가 완료되었습니다.');
            onArchived?.();
            onBack();
        } catch (_e) {
            alert('프로젝트 아카이브에 실패했습니다.');
        } finally {
            setArchiving(false);
        }
    };

    const handleDeleteProject = async () => {
        if (!project?.id) return;
        const ok = window.confirm('프로젝트를 정말 삭제하시겠습니까?\n이 프로젝트에 연결된 폴더 매핑도 모두 즉시 해제되며 복구할 수 없습니다.');
        if (!ok) return;
        setArchiving(true); // 재사용
        try {
            await Storage.deleteProject(project.id);
            Array.from(projectDetailCache.keys()).forEach((key) => {
                if (key.startsWith(`${project.id}::`)) {
                    projectDetailCache.delete(key);
                }
            });
            Storage.invalidateProjectOverviewCache();
            await onRefreshTasksFromServer?.();
            alert('프로젝트가 영구적으로 삭제되었습니다.');
            onArchived?.();
            onBack();
        } catch (_e) {
            alert('프로젝트 삭제에 실패했습니다.');
        } finally {
            setArchiving(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-900">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onBack}
                        className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 text-xs font-bold"
                    >
                        ← 프로젝트 목록
                    </button>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-xl font-bold text-white">{project?.name || '프로젝트 상세'}</h2>
                            {project?.workflowSourceType && (
                                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${project.workflowSourceType === 'vlm-review' ? 'bg-violet-900/30 text-violet-200 border-violet-700/50' : project.workflowSourceType === 'image-classification' ? 'bg-amber-900/30 text-amber-200 border-amber-700/50' : 'bg-sky-900/30 text-sky-200 border-sky-700/50'}`}>
                                    {project.workflowSourceType === 'vlm-review' ? 'VLM Workflow' : project.workflowSourceType === 'image-classification' ? '이미지 분류' : 'YOLO Workflow'}
                                </span>
                            )}
                            {isArchived && (
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-amber-900/30 text-amber-200 border-amber-700/50">
                                    Archived
                                </span>
                            )}
                        </div>
                        <p className="text-slate-400 text-sm mt-1">프로젝트 단위 작업/배분/추이 현황</p>
                        <div
                            className="text-xs mt-1.5 flex flex-wrap items-center gap-2 text-slate-500"
                            role="status"
                            aria-live="polite"
                        >
                            <span
                                className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                                    detailStatsFetchPending ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500/90'
                                }`}
                                aria-hidden
                            />
                            {detailStatsFetchedAt != null ? (
                                <>
                                    <span className={detailStatsFetchPending ? 'text-slate-500' : 'text-slate-400'}>
                                        {formatProjectDetailStatsFetchedAt(detailStatsFetchedAt)}
                                    </span>
                                    {!detailStatsFetchPending && <span>에 불러온 데이터입니다</span>}
                                    {detailStatsFetchPending && (
                                        <span className="text-amber-200/85">· 갱신 중…</span>
                                    )}
                                </>
                            ) : detailStatsFetchPending ? (
                                <span className="text-slate-400">통계를 불러오는 중…</span>
                            ) : null}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={String(days)}
                        onChange={(e) => setDays(Number(e.target.value))}
                        disabled={isArchived}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-sky-500 disabled:opacity-60"
                    >
                        <option value="7">최근 7일</option>
                        <option value="30">최근 30일</option>
                        <option value="90">최근 90일</option>
                    </select>
                    <button
                        onClick={handleRefreshDetail}
                        disabled={loading || refreshing || archiving}
                        className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
                        title="캐시를 무시하고 최신 통계를 다시 불러옵니다."
                    >
                        {refreshing ? '새로고침 중...' : '지표 새로고침'}
                    </button>
                    {onSyncProject && (
                        <button
                            onClick={() => {
                                void (async () => {
                                    const ok = window.confirm('이 프로젝트에 매핑된 폴더만 디스크와 동기화합니다. 계속할까요?');
                                    if (!ok) return;
                                    await onSyncProject(projectId);
                                    await handleRefreshDetail();
                                })();
                            }}
                            disabled={loading || archiving}
                            className="px-3 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-bold disabled:opacity-50"
                            title="이 프로젝트에 연결된 폴더만 스캔하여 DB에 반영합니다."
                        >
                            이 프로젝트만 동기화
                        </button>
                    )}
                    <button
                        onClick={handleDeleteProject}
                        disabled={archiving || loading || refreshing}
                        className="px-3 py-2 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold disabled:opacity-50"
                    >
                        삭제
                    </button>
                    <button
                        onClick={handleArchiveProject}
                        disabled={archiving || isArchived || loading || refreshing}
                        className="px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs font-bold disabled:opacity-50"
                    >
                        {isArchived ? '아카이브 완료' : (archiving ? '처리 중...' : '아카이브')}
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6 space-y-6">
                {loading && !detail && (
                    <div className="text-sm text-sky-300 bg-sky-900/20 border border-sky-700/40 rounded-lg px-4 py-3">
                        프로젝트 상세 로딩 중...
                    </div>
                )}

                {!loading && project && (
                    <>
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-5 mb-8">
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-cyan-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl group-hover:bg-cyan-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"></div> 목표량
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-cyan-300 to-sky-500 relative z-10 tracking-tight">{Number(project.targetTotal || 0).toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-sky-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-sky-500/10 rounded-full blur-2xl group-hover:bg-sky-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]"></div> 배분량
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-sky-300 to-blue-500 relative z-10 tracking-tight">{Number(project.allocated || 0).toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-lime-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-lime-500/10 rounded-full blur-2xl group-hover:bg-lime-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-lime-400 shadow-[0_0_8px_rgba(163,230,53,0.8)]"></div> 완료량
                                </div>
                                <div className="text-3xl font-heading font-black text-transparent bg-clip-text bg-gradient-to-br from-lime-300 to-green-500 relative z-10 tracking-tight">{Number(project.completed || 0).toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-violet-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-violet-500/10 rounded-full blur-2xl group-hover:bg-violet-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.8)]"></div> 진행률
                                </div>
                                <div className="text-3xl font-heading font-black text-white relative z-10 tracking-tight">{Number(project.progress || 0)}%</div>
                            </div>
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-5 shadow-[0_8px_30px_rgb(0,0,0,0.4)] relative flex flex-col justify-center overflow-hidden group hover:border-amber-500/30 transition-colors">
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl group-hover:bg-amber-500/20 transition-colors" />
                                <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-2 relative z-10 flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.8)]"></div> 폴더 수
                                </div>
                                <div className="text-3xl font-heading font-black text-amber-300 relative z-10 tracking-tight">{Number(project.folderCount || 0)}</div>
                            </div>
                        </div>

                        <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                            <h3 className="text-sm font-bold text-slate-200 mb-3">기간별 추이 (Submissions / Work Time)</h3>
                            <div className="h-[300px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={trends} margin={{ top: 8, right: 20, left: 0, bottom: 8 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                        <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                                        <YAxis yAxisId="left" stroke="#34d399" tick={{ fontSize: 11 }} allowDecimals={false} />
                                        <YAxis yAxisId="right" orientation="right" stroke="#38bdf8" tick={{ fontSize: 11 }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                                            formatter={(value: any, name: string) => {
                                                if (name === 'submissions' || name === 'submitted') return [`${value}`, 'Submissions'];
                                                return [`${value}h`, 'Work Time'];
                                            }}
                                        />
                                        <Legend wrapperStyle={{ fontSize: 12 }} />
                                        <Bar yAxisId="left" dataKey="submissions" name="submissions" fill="#10b981" radius={[4, 4, 0, 0]} />
                                        <Line yAxisId="right" type="monotone" dataKey="workTimeHours" name="workTime" stroke="#0ea5e9" strokeWidth={2.5} dot={{ r: 2 }} />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {project.workflowSourceType === 'vlm-review' && !isArchived && (
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setShowVlmModal(true)}
                                    className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold transition-colors"
                                >
                                    VLM 배분
                                </button>
                            </div>
                        )}

                        {project.workflowSourceType !== 'vlm-review' && !isArchived && (
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setShowNativeAssignModal(true)}
                                    className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold transition-colors"
                                >
                                    {project.workflowSourceType === 'image-classification' ? '분류 작업 배분' : 'YOLO 작업 배분'}
                                </button>
                            </div>
                        )}

                        {showVlmModal && project.workflowSourceType === 'vlm-review' && (
                            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setShowVlmModal(false)}>
                                <div className="bg-slate-900 border border-violet-700/50 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
                                    <div className="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
                                        <h3 className="text-base font-bold text-violet-200">VLM 배분 (수량 단위 배정·배정 해제)</h3>
                                        <button type="button" onClick={() => setShowVlmModal(false)} className="text-slate-400 hover:text-white p-1 rounded">✕</button>
                                    </div>
                                    <div className="p-6 overflow-auto space-y-5">
                                        <p className="text-xs text-slate-400">
                                            배정할 원본 JSON을 선택한 뒤, 해당 범위의 미배정 풀에서 N건을 배정하거나 작업자에게 배정된 N건을 해제할 수 있습니다.
                                        </p>

                                        <div className="rounded-lg border border-slate-600/60 bg-slate-800/40 px-3 py-2.5 space-y-2">
                                            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">배정·해제 대상 JSON</div>
                                            {vlmModalSourceRows.length === 0 ? (
                                                <p className="text-xs text-slate-500">
                                                    이 프로젝트에 쓸 원본 JSON을 찾지 못했습니다. 프로젝트 설정에 VLM JSON이 있는지,
                                                    상세/개요 API에 <span className="font-mono text-slate-400">vlmSourceFiles</span>가
                                                    포함되는지 확인하세요. (폴더명이 <span className="font-mono text-slate-400">VLM_*</span> 형태면
                                                    그 이름으로 자동 추론합니다.)
                                                </p>
                                            ) : (
                                                <div className="max-h-36 overflow-y-auto space-y-1.5">
                                                    {vlmModalSourceRows.map((row) => (
                                                        <label
                                                            key={row.sourceFile}
                                                            className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer"
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                className="mt-0.5 h-3.5 w-3.5 accent-violet-400 shrink-0"
                                                                checked={vlmModalSelectedSourceFiles.includes(row.sourceFile)}
                                                                onChange={(e) => {
                                                                    setVlmModalSelectedSourceFiles((prev) => {
                                                                        if (e.target.checked) {
                                                                            if (prev.includes(row.sourceFile)) return prev;
                                                                            return [...prev, row.sourceFile];
                                                                        }
                                                                        return prev.filter((f) => f !== row.sourceFile);
                                                                    });
                                                                }}
                                                            />
                                                            <span>
                                                                <span className="font-mono text-[11px]">{row.sourceFile}</span>
                                                                <span className="text-slate-500">
                                                                    {' '}
                                                                    · 미배정 {row.unassigned} / 전체 {row.total}
                                                                </span>
                                                            </span>
                                                        </label>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap items-end gap-4">
                                            <div className="flex items-center gap-2">
                                                <label className="text-xs text-slate-400">배정 수량</label>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    value={vlmAssignCount}
                                                    onChange={(e) => setVlmAssignCount(e.target.value)}
                                                    className="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 font-mono"
                                                />
                                                <label className="text-xs text-slate-400">작업자</label>
                                                <select
                                                    value={vlmAssignWorker}
                                                    onChange={(e) => setVlmAssignWorker(e.target.value)}
                                                    className="bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-200"
                                                >
                                                    <option value="">선택</option>
                                                    {workerNames.filter((w) => w && String(w).trim() !== 'Unassigned').map((name) => (
                                                        <option key={name} value={name}>{name}</option>
                                                    ))}
                                                </select>
                                                <button
                                                    disabled={
                                                        vlmAssigning ||
                                                        !vlmAssignWorker ||
                                                        Number(vlmAssignCount) < 1 ||
                                                        vlmModalSelectedSourceFiles.length === 0
                                                    }
                                                    onClick={async () => {
                                                        const count = Math.max(1, Math.floor(Number(vlmAssignCount) || 0));
                                                        const w = String(vlmAssignWorker || '').trim();
                                                        const ok = window.confirm(
                                                            `「${w}」에게 선택한 JSON 범위에서 미배정 풀 최대 ${count.toLocaleString()}건을 배정합니다.\n계속할까요?`
                                                        );
                                                        if (!ok) return;
                                                        setVlmAssigning(true);
                                                        try {
                                                            const result = await Storage.assignVlmTasks({
                                                                workerName: vlmAssignWorker,
                                                                count,
                                                                projectId,
                                                                sourceFiles: [...vlmModalSelectedSourceFiles]
                                                            });
                                                            alert(`${result.assigned}건 배정되었습니다.`);
                                                            await handleRefreshDetail();
                                                            onRefresh?.();
                                                        } catch (e: any) {
                                                            alert(e?.message || '배정 실패');
                                                        } finally {
                                                            setVlmAssigning(false);
                                                        }
                                                    }}
                                                    className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50"
                                                >
                                                    {vlmAssigning ? '처리 중...' : 'N건 배정'}
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <div className="text-xs font-bold text-slate-300 mb-2">배정 해제 (작업자 기준)</div>
                                            <div className="flex flex-wrap items-end gap-4">
                                                <label className="text-xs text-slate-400">해제 수량</label>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    value={vlmUnassignCount}
                                                    onChange={(e) => setVlmUnassignCount(e.target.value)}
                                                    className="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 font-mono"
                                                />
                                                <label className="text-xs text-slate-400">작업자</label>
                                                <select
                                                    value={vlmUnassignWorker}
                                                    onChange={(e) => setVlmUnassignWorker(e.target.value)}
                                                    className="bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-200"
                                                >
                                                    <option value="">선택</option>
                                                    {workers.filter((w) => w.userId && String(w.userId).trim() !== 'Unassigned' && Number(w.allocated || 0) > 0).map((w) => (
                                                        <option key={w.userId} value={w.userId}>{w.userId} ({Number(w.allocated || 0)}건)</option>
                                                    ))}
                                                </select>
                                                <button
                                                    disabled={
                                                        vlmUnassigning ||
                                                        !vlmUnassignWorker ||
                                                        Number(vlmUnassignCount) < 1 ||
                                                        vlmModalSelectedSourceFiles.length === 0
                                                    }
                                                    onClick={async () => {
                                                        const count = Math.max(1, Math.floor(Number(vlmUnassignCount) || 0));
                                                        const w = String(vlmUnassignWorker || '').trim();
                                                        const ok = window.confirm(
                                                            `「${w}」에게서 선택한 JSON 범위에서 최대 ${count.toLocaleString()}건의 배정을 해제합니다.\n계속할까요?`
                                                        );
                                                        if (!ok) return;
                                                        setVlmUnassigning(true);
                                                        try {
                                                            const result = await Storage.unassignVlmTasks({
                                                                workerName: vlmUnassignWorker,
                                                                count,
                                                                projectId,
                                                                sourceFiles: [...vlmModalSelectedSourceFiles]
                                                            });
                                                            alert(`${result.unassigned}건 배정 해제되었습니다.`);
                                                            await handleRefreshDetail();
                                                            onRefresh?.();
                                                        } catch (e: any) {
                                                            alert(e?.message || '배정 해제 실패');
                                                        } finally {
                                                            setVlmUnassigning(false);
                                                        }
                                                    }}
                                                    className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50"
                                                >
                                                    {vlmUnassigning ? '처리 중...' : 'N건 배정 해제'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {showNativeAssignModal && project.workflowSourceType !== 'vlm-review' && (
                            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setShowNativeAssignModal(false)}>
                                <div className="bg-slate-900 border border-sky-700/50 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
                                    <div className="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
                                        <h3 className="text-base font-bold text-sky-200">
                                            {project.workflowSourceType === 'image-classification'
                                                ? '이미지 분류 배분 (수량 단위 배정·배정 해제)'
                                                : 'YOLO 배분 (수량 단위 배정·배정 해제)'}
                                        </h3>
                                        <button type="button" onClick={() => setShowNativeAssignModal(false)} className="text-slate-400 hover:text-white p-1 rounded">✕</button>
                                    </div>
                                    <div className="p-6 overflow-auto space-y-5">
                                        {project?.nativeAssignPool && (
                                            <div className="text-xs text-slate-200 bg-slate-800/60 border border-slate-600 rounded-lg px-3 py-2.5 font-mono space-y-1">
                                                <div>
                                                    <span className="text-slate-500">전체 태스크</span>{' '}
                                                    <span className="text-white font-bold">{Number(project.nativeAssignPool.total).toLocaleString()}</span>
                                                    <span className="text-slate-500">건</span>
                                                </div>
                                                <div>
                                                    <span className="text-slate-500">이미 배정</span>{' '}
                                                    <span className="text-sky-300 font-bold">{Number(project.nativeAssignPool.assigned).toLocaleString()}</span>
                                                    <span className="text-slate-500">건 · </span>
                                                    <span className="text-slate-500">배정 가능(미배정)</span>{' '}
                                                    <span className="text-amber-200 font-bold">{Number(project.nativeAssignPool.unassigned).toLocaleString()}</span>
                                                    <span className="text-slate-500">건</span>
                                                </div>
                                            </div>
                                        )}
                                        <p className="text-xs text-slate-400">
                                            이 프로젝트에 매핑된 폴더의 <span className="text-sky-300 font-semibold">tasks</span> 행 기준으로, 미배정 풀에서 N건을 배정합니다.
                                            배정 해제는 <span className="text-amber-200/90">제출·승인 완료(SUBMITTED/APPROVED) 건은 제외</span>하고 작업자에게서 뺍니다 (상태는 TODO로 되돌림).
                                        </p>

                                        <div className="flex flex-wrap items-end gap-4">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <label className="text-xs text-slate-400">배정 수량</label>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    value={nativeAssignCount}
                                                    onChange={(e) => setNativeAssignCount(e.target.value)}
                                                    className="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 font-mono"
                                                />
                                                <label className="text-xs text-slate-400">작업자</label>
                                                <select
                                                    value={nativeAssignWorker}
                                                    onChange={(e) => setNativeAssignWorker(e.target.value)}
                                                    className="bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-200"
                                                >
                                                    <option value="">선택</option>
                                                    {workerNames.filter((w) => w && String(w).trim() !== 'Unassigned').map((name) => (
                                                        <option key={name} value={name}>{name}</option>
                                                    ))}
                                                </select>
                                                <button
                                                    disabled={nativeAssigning || !nativeAssignWorker || Number(nativeAssignCount) < 1}
                                                    onClick={async () => {
                                                        const count = Math.max(1, Math.floor(Number(nativeAssignCount) || 0));
                                                        const w = String(nativeAssignWorker || '').trim();
                                                        const ok = window.confirm(
                                                            `「${w}」에게 미배정 풀에서 최대 ${count.toLocaleString()}건을 배정합니다.\n계속할까요?`
                                                        );
                                                        if (!ok) return;
                                                        setNativeAssigning(true);
                                                        try {
                                                            const result = await Storage.assignNativeTasks({
                                                                workerName: nativeAssignWorker,
                                                                count,
                                                                projectId
                                                            });
                                                            const hint = typeof result.hint === 'string' ? result.hint : '';
                                                            const dbg = result.assignDebug;
                                                            if (Number(result.assigned) > 0) {
                                                                alert(`${result.assigned}건 배정되었습니다.`);
                                                            } else {
                                                                const lines = ['배정된 건이 없습니다.'];
                                                                if (hint) lines.push('', hint);
                                                                if (dbg && typeof dbg === 'object') {
                                                                    lines.push('', '[진단 정보 — API·DB 확인용]', JSON.stringify(dbg, null, 2));
                                                                } else {
                                                                    lines.push(
                                                                        '',
                                                                        '(진단 정보 없음: 이 UI가 붙은 서버가 최신 vite API가 아니면 assignDebug 가 오지 않습니다. VITE_API_BASE_URL / dev 서버 재시작을 확인하세요.)'
                                                                    );
                                                                }
                                                                alert(lines.join('\n'));
                                                            }
                                                            await handleRefreshDetail();
                                                            onRefresh?.();
                                                        } catch (e: unknown) {
                                                            alert(e instanceof Error ? e.message : '배정 실패');
                                                        } finally {
                                                            setNativeAssigning(false);
                                                        }
                                                    }}
                                                    className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold disabled:opacity-50"
                                                >
                                                    {nativeAssigning ? '처리 중...' : 'N건 배정'}
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <div className="text-xs font-bold text-slate-300 mb-2">배정 해제 (작업자 기준)</div>
                                            <div className="flex flex-wrap items-end gap-4">
                                                <label className="text-xs text-slate-400">해제 수량</label>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    value={nativeUnassignCount}
                                                    onChange={(e) => setNativeUnassignCount(e.target.value)}
                                                    className="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 font-mono"
                                                />
                                                <label className="text-xs text-slate-400">작업자</label>
                                                <select
                                                    value={nativeUnassignWorker}
                                                    onChange={(e) => setNativeUnassignWorker(e.target.value)}
                                                    className="bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-200"
                                                >
                                                    <option value="">선택</option>
                                                    {workers.filter((w) => w.userId && String(w.userId).trim() !== 'Unassigned' && Number(w.allocated || 0) > 0).map((w) => (
                                                        <option key={w.userId} value={w.userId}>{w.userId} ({Number(w.allocated || 0)}건)</option>
                                                    ))}
                                                </select>
                                                <button
                                                    disabled={nativeUnassigning || !nativeUnassignWorker || Number(nativeUnassignCount) < 1}
                                                    onClick={async () => {
                                                        const count = Math.max(1, Math.floor(Number(nativeUnassignCount) || 0));
                                                        const w = String(nativeUnassignWorker || '').trim();
                                                        const ok = window.confirm(
                                                            `「${w}」에게서 최대 ${count.toLocaleString()}건의 배정을 해제합니다.\n제출·승인 완료 건은 해제 대상에서 제외될 수 있습니다.\n계속할까요?`
                                                        );
                                                        if (!ok) return;
                                                        setNativeUnassigning(true);
                                                        try {
                                                            const result = await Storage.unassignNativeTasks({ workerName: nativeUnassignWorker, count, projectId });
                                                            alert(`${result.unassigned}건 배정 해제되었습니다.`);
                                                            await handleRefreshDetail();
                                                            onRefresh?.();
                                                        } catch (e: unknown) {
                                                            alert(e instanceof Error ? e.message : '배정 해제 실패');
                                                        } finally {
                                                            setNativeUnassigning(false);
                                                        }
                                                    }}
                                                    className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50"
                                                >
                                                    {nativeUnassigning ? '처리 중...' : 'N건 배정 해제'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,3.5fr)_minmax(0,6.5fr)]">
                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
                                <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 text-sm font-bold text-slate-200">
                                    {project.workflowSourceType === 'vlm-review' ? '작업자별 진행 현황' : '작업자 배분 현황'}
                                </div>
                                <div className="overflow-auto">
                                    <table className="w-full text-left">
                                        <thead className="bg-slate-900/80 text-slate-400 text-[11px] font-bold uppercase tracking-wider border-b border-white/5">
                                            <tr>
                                                <th className="px-6 py-4">작업자</th>
                                                <th className="px-6 py-4">배분량</th>
                                                <th className="px-6 py-4">완료량</th>
                                                <th className="px-6 py-4 text-right">진행률</th>
                                                {role === UserRole.REVIEWER && <th className="px-6 py-4">검수</th>}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/5">
                                            {workers.filter(row => !['unassigned', 'admin'].includes(String(row.userId).toLowerCase())).map((row) => {
                                                /** 검수자: 표의 작업자 행과 동일한 ID로 범위 고정 — 폴더 단위 클릭과 무관하게 해당 작업자 배정 태스크만 */
                                                const reviewScopeOpts =
                                                    role === UserRole.REVIEWER
                                                        ? { reviewerScopeWorker: String(row.userId || '').trim() || null }
                                                        : undefined;
                                                const isVlmProject = project.workflowSourceType === 'vlm-review';
                                                /** API(project detail)에서 온 작업자별 검수·샘플 ID — VLM 파일 프로젝트 또는 폴더 매핑 enrich */
                                                const useServerReviewMeta = isVlmProject || Boolean(row.sampleTaskId);
                                                const vlmSfList = projectVlmSourceFileNames(project);
                                                const projectFolderNamesForRow =
                                                    isVlmProject && vlmSfList.length > 0
                                                        ? folders.length > 0
                                                            ? folders.map((f) => f.folder)
                                                            : vlmSfList.flatMap((sf) => [sf, `VLM_${sf.replace(/\.json$/i, '')}`])
                                                        : folders.map((f) => f.folder);
                                                const vlmSfSet = new Set(vlmSfList);
                                                const isTaskForWorker = (t: Task) =>
                                                    t.assignedWorker === row.userId &&
                                                    (projectFolderNamesForRow.includes(t.folder) ||
                                                        (t.sourceType === 'vlm-review' && vlmSfSet.has(String(t.sourceFile || ''))));
                                                const targetTasksForRow = useServerReviewMeta ? [] : tasks.filter(isTaskForWorker);
                                                const orderedForRow = useServerReviewMeta ? ([] as Task[]) : [...targetTasksForRow];
                                                if (!useServerReviewMeta && orderedForRow.length > 0) {
                                                    orderedForRow.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                                                }
                                                const submittedCountForRow = useServerReviewMeta
                                                    ? Number(row.reviewPendingCount ?? 0)
                                                    : targetTasksForRow.filter(t => t.status === TaskStatus.SUBMITTED).length;
                                                const firstSubmittedForRow = useServerReviewMeta
                                                    ? undefined
                                                    : orderedForRow.find(t => t.status === TaskStatus.SUBMITTED);
                                                return (
                                                <tr key={row.userId} className="hover:bg-slate-800/40 transition-colors group">
                                                    <td className="px-6 py-4">
                                                        <button
                                                            onClick={() => {
                                                                if (useServerReviewMeta) {
                                                                    const isReviewer = role === UserRole.REVIEWER;
                                                                    const tid = isReviewer
                                                                        ? (row.firstSubmittedTaskId || row.firstApprovedTaskId || row.sampleTaskId)
                                                                        : (row.firstOpenTaskId || row.sampleTaskId);
                                                                    if (tid) {
                                                                        onSelectTask(tid, reviewScopeOpts);
                                                                        return;
                                                                    }
                                                                    if (Number(row.allocated || 0) > 0) {
                                                                        alert(`해당 작업자(${row.userId})에게 할당된 작업을 찾을 수 없습니다.`);
                                                                    }
                                                                    return;
                                                                }
                                                                if (targetTasksForRow.length > 0) {
                                                                    const isReviewer = role === UserRole.REVIEWER;
                                                                    const incompleteTask = isReviewer
                                                                        ? (orderedForRow.find(t => t.status === TaskStatus.SUBMITTED) || orderedForRow.find(t => t.status === TaskStatus.APPROVED) || orderedForRow[0])
                                                                        : (orderedForRow.find(t => t.status !== TaskStatus.APPROVED && t.status !== TaskStatus.SUBMITTED) || orderedForRow[0]);
                                                                    onSelectTask(incompleteTask.id, isReviewer ? reviewScopeOpts : undefined);
                                                                }
                                                            }}
                                                            className={`flex items-center gap-3 w-full text-left group-hover:bg-slate-800/60 p-1 -m-1 rounded-lg transition-all ${useServerReviewMeta ? 'cursor-pointer hover:ring-1 hover:ring-sky-500/50' : 'cursor-default'}`}
                                                            title={useServerReviewMeta ? `${row.userId}의 작업으로 이동` : undefined}
                                                        >
                                                            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-400 border border-white/5 group-hover:bg-sky-600/20 group-hover:text-sky-300 group-hover:border-sky-500/50 transition-all shadow-inner">
                                                                {row.userId?.substring(0, 1)?.toUpperCase() || '?'}
                                                            </div>
                                                            <span className="font-semibold text-slate-200 group-hover:text-white transition-colors capitalize">{row.userId}</span>
                                                        </button>
                                                    </td>
                                                    <td className="px-6 py-4 text-slate-300 font-mono text-sm">{Number(row.allocated || 0).toLocaleString()}</td>
                                                    <td className="px-6 py-4 text-slate-300 font-mono text-sm">{Number(row.completed || 0).toLocaleString()}</td>
                                                    <td className="px-6 py-4 text-right">
                                                        <span className="bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded-lg border border-emerald-500/20 text-xs font-bold font-mono">
                                                            {Number(row.progress || 0)}%
                                                        </span>
                                                    </td>
                                                    {role === UserRole.REVIEWER && (
                                                        <td className="px-6 py-4">
                                                            <button
                                                                type="button"
                                                                onClick={async () => {
                                                                    if (useServerReviewMeta) {
                                                                        if (row.firstSubmittedTaskId) {
                                                                            onSelectTask(row.firstSubmittedTaskId, reviewScopeOpts);
                                                                            return;
                                                                        }
                                                                        const fallback = row.firstApprovedTaskId || row.sampleTaskId;
                                                                        if (submittedCountForRow === 0 && fallback) {
                                                                            onSelectTask(fallback, reviewScopeOpts);
                                                                            return;
                                                                        }
                                                                        if (submittedCountForRow === 0 && Number(row.completed || 0) > 0) {
                                                                            try {
                                                                                await Storage.fetchAndMergeWorkerTasks(row.userId);
                                                                                onRefresh?.();
                                                                                const tasksNow = Storage.getTasks();
                                                                                const names = projectFolderNamesForRow;
                                                                                const inProject = (t: Task) =>
                                                                                    t.assignedWorker === row.userId &&
                                                                                    (names.includes(t.folder) ||
                                                                                        (t.sourceType === 'vlm-review' && vlmSfSet.has(String(t.sourceFile || ''))));
                                                                                const inProjectList = tasksNow.filter(inProject).sort((a, b) =>
                                                                                    isVlmProject ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true })
                                                                                );
                                                                                const first = inProjectList.find(t => t.status === TaskStatus.SUBMITTED)
                                                                                    || inProjectList.find(t => t.status === TaskStatus.APPROVED)
                                                                                    || inProjectList[0];
                                                                                if (first) onSelectTask(first.id, reviewScopeOpts);
                                                                                else alert('검수 대기 건이 없습니다.');
                                                                            } catch (_e) {
                                                                                alert('해당 작업자 작업을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.');
                                                                            }
                                                                            return;
                                                                        }
                                                                        alert('검수 대기 건이 없습니다. 새로고침 후 다시 시도해 주세요.');
                                                                        return;
                                                                    }
                                                                    if (firstSubmittedForRow) {
                                                                        onSelectTask(firstSubmittedForRow.id, reviewScopeOpts);
                                                                        return;
                                                                    }
                                                                    if (submittedCountForRow === 0 && targetTasksForRow.length > 0) {
                                                                        const next = orderedForRow.find(t => t.status === TaskStatus.APPROVED) || orderedForRow[0];
                                                                        if (next) onSelectTask(next.id, reviewScopeOpts);
                                                                        return;
                                                                    }
                                                                    if (submittedCountForRow === 0 && Number(row.completed || 0) > 0) {
                                                                        try {
                                                                            await Storage.fetchAndMergeWorkerTasks(row.userId);
                                                                            onRefresh?.();
                                                                            const tasksNow = Storage.getTasks();
                                                                            const names = folders.map(f => f.folder);
                                                                            const inProject = (t: Task) =>
                                                                                t.assignedWorker === row.userId && names.includes(t.folder);
                                                                            const inProjectList = tasksNow.filter(inProject).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                                                                            const first = inProjectList.find(t => t.status === TaskStatus.SUBMITTED)
                                                                                || inProjectList.find(t => t.status === TaskStatus.APPROVED)
                                                                                || inProjectList[0];
                                                                            if (first) onSelectTask(first.id, reviewScopeOpts);
                                                                            else alert('검수 대기 건이 없습니다.');
                                                                        } catch (_e) {
                                                                            alert('해당 작업자 작업을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.');
                                                                        }
                                                                        return;
                                                                    }
                                                                    if (submittedCountForRow === 0) {
                                                                        alert('검수 대기 건이 없습니다. 새로고침 후 다시 시도해 주세요.');
                                                                    } else {
                                                                        const fs = firstSubmittedForRow || orderedForRow.find(t => t.status === TaskStatus.SUBMITTED);
                                                                        if (fs) onSelectTask(fs.id, reviewScopeOpts);
                                                                        else alert('검수 대기 건이 표시되었으나 태스크를 찾지 못했습니다. 새로고침 후 다시 시도해 주세요.');
                                                                    }
                                                                }}
                                                                className="px-3 py-1.5 rounded-lg text-xs font-bold border transition-all bg-amber-900/30 text-amber-300 border-amber-700/50 hover:bg-amber-800/50 hover:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                                                title="제출된 작업 검수하기"
                                                            >
                                                                검수 {submittedCountForRow > 0 ? `(${submittedCountForRow})` : ''}
                                                            </button>
                                                        </td>
                                                    )}
                                                </tr>
                                            );})}
                                            {workers.filter(row => !['unassigned', 'admin'].includes(String(row.userId).toLowerCase())).length === 0 && (
                                                <tr>
                                                    <td colSpan={role === UserRole.REVIEWER ? 5 : 4} className="px-4 py-10 text-center">
                                                        <p className="text-slate-500 italic">작업자 데이터가 없습니다.</p>
                                                        {project?.workflowSourceType !== 'vlm-review' && folders.length === 0 && (
                                                            <p className="text-xs text-slate-400 mt-2 max-w-sm mx-auto">먼저 폴더를 이 프로젝트에 매핑하면, 폴더별로 작업자를 배정할 수 있습니다.</p>
                                                        )}
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-3xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
                                <div className="px-6 py-4 border-b border-white/5 bg-slate-900/60 flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <span className="text-sm font-bold text-slate-200">
                                            {isVlmProjectDetail ? '폴더 진행 현황' : '매핑 폴더 · 배정 현황'}
                                        </span>
                                        {!isVlmProjectDetail && (
                                            <p className="text-[11px] text-slate-500 mt-1 max-w-xl">
                                                한 폴더에 여러 작업자가 나뉘어 있을 수 있어, 폴더당 <span className="text-slate-400">미배정/배정</span>은 DB 행 기준입니다. (작업자별 합계는 왼쪽 표를 보세요.)
                                            </p>
                                        )}
                                    </div>
                                    {isVlmProjectDetail && (
                                        <label className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
                                            <span className="whitespace-nowrap font-semibold">작업자 필터</span>
                                            <select
                                                value={folderWorkerFilter}
                                                onChange={(e) => setFolderWorkerFilter(e.target.value)}
                                                className="bg-slate-950 border border-slate-600 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500 min-w-[10.5rem]"
                                                title="표시할 폴더를 작업자로 한정합니다"
                                            >
                                                <option value="ALL">전체</option>
                                                {folderWorkerOptions.map((name) => (
                                                    <option key={name} value={name}>{name}</option>
                                                ))}
                                            </select>
                                        </label>
                                    )}
                                </div>
                                <div className="overflow-auto">
                                    <table className="w-full text-left table-fixed">
                                        <colgroup>
                                            {folderTableWidths.map((w, i) => (
                                                <col key={i} style={{ width: w, minWidth: 48 }} />
                                            ))}
                                        </colgroup>
                                        <thead className="bg-slate-900/80 text-slate-400 text-[11px] font-bold uppercase tracking-wider border-b border-white/5">
                                            <tr>
                                                {(isVlmProjectDetail
                                                    ? (['폴더', '작업자', '완료 / 전체', '진행률', '검수 진행', '배정 해제'] as const)
                                                    : (['폴더', '미배정 / 배정됨', '완료 / 전체', '진행률', '검수 진행', '배정 해제'] as const)
                                                ).map((label, i) => (
                                                    <th
                                                        key={`${label}-${i}`}
                                                        className={`relative py-4 align-bottom whitespace-nowrap ${i === 0 ? 'pl-6 pr-2 min-w-0' : 'px-4'} ${i === 1 && isVlmProjectDetail ? 'text-left' : ''}`}
                                                        style={{ width: folderTableWidths[i] }}
                                                    >
                                                        <span className={i === 0 ? 'block truncate pr-1' : undefined}>{label}</span>
                                                        <button
                                                            type="button"
                                                            aria-label={`${label} 열 너비 조절`}
                                                            title="드래그하여 너비 조절"
                                                            onPointerDown={(e) => onFolderTableColResizeStart(i, e)}
                                                            className="absolute right-0 top-0 z-20 h-full w-2 max-w-[8px] cursor-col-resize border-0 bg-transparent p-0 hover:bg-cyan-500/35 active:bg-cyan-500/55"
                                                        />
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/5">
                                            {(() => {
                                                const groups = groupByTopLevel(filteredFolders, (r) => r.folder);
                                                const colSpan = 6;
                                                if (filteredFolders.length === 0) {
                                                    return (
                                                        <tr>
                                                            <td colSpan={colSpan} className="px-6 py-10 text-center">
                                                                {folders.length > 0 ? (
                                                                    <span className="text-slate-500 italic">선택한 작업자에 해당하는 폴더가 없습니다.</span>
                                                                ) : (
                                                                    <div className="text-slate-500 space-y-2">
                                                                        <p className="italic">폴더 데이터가 없습니다.</p>
                                                                        {project?.workflowSourceType !== 'vlm-review' && (
                                                                            <p className="text-xs text-slate-400 max-w-md mx-auto">
                                                                                프로젝트 목록에서 [폴더 매핑]으로 이 프로젝트에 폴더를 연결해 주세요. 매핑한 폴더에 이미지가 있고 동기화가 되어 있어야 작업이 표시됩니다. 지표 새로고침을 눌러 보세요.
                                                                            </p>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                }
                                                return groups.flatMap(({ groupName, items }) => [
                                                    <tr key={`group-${groupName}`} className="bg-slate-700/70 border-t border-b border-cyan-500/30">
                                                        <td colSpan={colSpan} className="px-6 py-3 text-base font-bold text-cyan-200 border-l-4 border-cyan-500 bg-slate-800/90">
                                                            {groupName}
                                                        </td>
                                                    </tr>,
                                                    ...items.map((row) => {
                                                        const progress = Number(row.taskCount || 0) > 0
                                                            ? Math.round((Number(row.completedCount || 0) / Number(row.taskCount || 1)) * 100)
                                                            : 0;
                                                        const submittedCount = Number(row.submittedCount || 0);
                                                        const approvedCount = Number(row.approvedCount || 0);
                                                        const rejectedCount = Number(row.rejectedCount || 0);
                                                        const reviewTarget = submittedCount + approvedCount + rejectedCount;
                                                        const reviewDone = approvedCount + rejectedCount;
                                                        const reviewProgress = reviewTarget > 0
                                                            ? Math.round((reviewDone / reviewTarget) * 100)
                                                            : 0;
                                                        const un = Number(row.unassignedTaskCount ?? row.taskCount ?? 0);
                                                        const as = Number(row.assignedTaskCount ?? Math.max(0, Number(row.taskCount || 0) - un));
                                                        const reviewCell = (
                                                            <>
                                                                {reviewTarget > 0 ? (
                                                                    <div className="flex flex-col gap-1.5 min-w-0 max-w-full">
                                                                        <div className="flex justify-between items-center text-[10px] font-bold">
                                                                            <span className="text-slate-400">Review</span>
                                                                            <span className="text-violet-400">{reviewProgress}%</span>
                                                                        </div>
                                                                        <div className="h-1.5 bg-slate-950 rounded-full overflow-hidden shadow-inner relative">
                                                                            <div className="absolute inset-y-0 left-0 bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.4)]" style={{ width: `${reviewProgress}%` }} />
                                                                        </div>
                                                                        <div className="flex gap-2 text-[9px] font-black uppercase tracking-tighter opacity-70 group-hover:opacity-100 transition-opacity">
                                                                            <span className="text-lime-400">OK {approvedCount}</span>
                                                                            <span className="text-rose-400">RE {rejectedCount}</span>
                                                                            <span className="text-amber-400">WAIT {submittedCount}</span>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest italic">No Review</span>
                                                                )}
                                                            </>
                                                        );
                                                        const unassignCell = (
                                                            <button
                                                                type="button"
                                                                disabled={isArchived || unassigningFolder !== null}
                                                                onClick={() => void handleUnassignFolderRow(row.folder)}
                                                                className="px-2 py-1.5 rounded text-[11px] font-bold border border-rose-700/50 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50 hover:border-rose-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                                                title="프로젝트 맵·project_id 및 작업자 맵·assignedWorker 해제"
                                                            >
                                                                {unassigningFolder === row.folder ? '처리 중…' : '배정 해제'}
                                                            </button>
                                                        );
                                                        if (!isVlmProjectDetail) {
                                                            return (
                                                                <tr key={row.folder} className="hover:bg-slate-800/40 transition-colors group">
                                                                    <td className="px-6 py-4 min-w-0 align-top">
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => onOpenFolder(row.folder, project?.workflowSourceType)}
                                                                            className="text-left w-full max-w-full text-slate-200 font-bold text-sm hover:text-cyan-300 hover:underline underline-offset-4 transition-all tracking-tight truncate block"
                                                                            title={`${row.folder} 열기`}
                                                                        >
                                                                            {row.folder}
                                                                        </button>
                                                                    </td>
                                                                    <td className="px-4 py-4 align-top whitespace-nowrap">
                                                                        <div className="flex items-baseline gap-1">
                                                                            <span className="text-amber-200/90 font-bold font-mono text-sm">{un.toLocaleString()}</span>
                                                                            <span className="text-slate-500 font-mono text-xs">/ </span>
                                                                            <span className="text-sky-300 font-mono text-xs">{as.toLocaleString()}</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-4 align-top whitespace-nowrap">
                                                                        <div className="flex items-baseline gap-1">
                                                                            <span className="text-slate-200 font-bold font-mono text-sm">{Number(row.completedCount || 0).toLocaleString()}</span>
                                                                            <span className="text-slate-500 font-mono text-xs">/ {Number(row.taskCount || 0).toLocaleString()}</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-4 align-top whitespace-nowrap">
                                                                        <div className="flex items-center gap-2 min-w-0">
                                                                            <div className="flex-1 min-w-0 h-1.5 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                                                                <div className="h-full bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.4)]" style={{ width: `${progress}%` }} />
                                                                            </div>
                                                                            <span className="text-cyan-400 font-mono text-xs font-bold shrink-0">{progress}%</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-4 align-top">{reviewCell}</td>
                                                                    <td className="px-4 py-4 align-top whitespace-nowrap">{unassignCell}</td>
                                                                </tr>
                                                            );
                                                        }
                                                        return (
                                                            <tr key={row.folder} className="hover:bg-slate-800/40 transition-colors group">
                                                                <td className="px-6 py-4 min-w-0 align-top">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => onOpenFolder(row.folder, project?.workflowSourceType)}
                                                                        className="text-left w-full max-w-full text-slate-200 font-bold text-sm hover:text-cyan-300 hover:underline underline-offset-4 transition-all tracking-tight truncate block"
                                                                        title={`${row.folder} 열기`}
                                                                    >
                                                                        {row.folder}
                                                                    </button>
                                                                </td>
                                                                <td className="px-4 py-4 align-top whitespace-nowrap">
                                                                    <span className="text-slate-300 text-sm">{row.assignedWorker || 'Unassigned'}</span>
                                                                </td>
                                                                <td className="px-4 py-4 align-top whitespace-nowrap">
                                                                    <div className="flex items-baseline gap-1">
                                                                        <span className="text-slate-200 font-bold font-mono text-sm">{Number(row.completedCount || 0).toLocaleString()}</span>
                                                                        <span className="text-slate-500 font-mono text-xs">/ {Number(row.taskCount || 0).toLocaleString()}</span>
                                                                    </div>
                                                                </td>
                                                                <td className="px-4 py-4 align-top whitespace-nowrap">
                                                                    <div className="flex items-center gap-2 min-w-0">
                                                                        <div className="flex-1 min-w-0 h-1.5 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                                                            <div className="h-full bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.4)]" style={{ width: `${progress}%` }} />
                                                                        </div>
                                                                        <span className="text-cyan-400 font-mono text-xs font-bold shrink-0">{progress}%</span>
                                                                    </div>
                                                                </td>
                                                                <td className="px-4 py-4 align-top">{reviewCell}</td>
                                                                <td className="px-4 py-4 align-top whitespace-nowrap">{unassignCell}</td>
                                                            </tr>
                                                        );
                                                    })
                                                ]);
                                            })()}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div >
    );
};

/** Notice 편집을 별도 컴포넌트로 분리해 타이핑 시 Dashboard 전체 리렌더를 막고 끊김을 줄임 */
const NoticeEditor: React.FC<{ initialContent: string; onSave: (content: string) => void; onCancel: () => void }> = ({ initialContent, onSave, onCancel }) => {
    const [content, setContent] = useState(initialContent);
    const quillRef = useRef<any>(null);

    const imageHandler = useCallback(() => {
        const input = document.createElement('input');
        input.setAttribute('type', 'file');
        input.setAttribute('accept', 'image/*');
        input.click();
        input.onchange = async () => {
            if (input.files && input.files[0]) {
                const file = input.files[0];
                const reader = new FileReader();
                reader.onload = async () => {
                    const base64Content = reader.result as string;
                    try {
                        const response = await fetch(apiUrl('/api/upload-image'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ fileName: file.name, content: base64Content })
                        });
                        const data = await response.json();
                        if (data.success && quillRef.current) {
                            const quill = quillRef.current.getEditor();
                            const range = quill.getSelection();
                            if (range) quill.insertEmbed(range.index, 'image', data.url);
                        }
                    } catch (e) {
                        console.error('Image upload failed', e);
                        alert('이미지 업로드에 실패했습니다.');
                    }
                };
                reader.readAsDataURL(file);
            }
        };
    }, []);

    const quillModules = useMemo(() => ({
        toolbar: {
            container: [
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'color': [] }, { 'background': [] }],
                [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                ['link', 'image'],
                ['clean']
            ],
            handlers: { image: imageHandler }
        }
    }), [imageHandler]);

    return (
        <div className="flex flex-col gap-4 h-full">
            <style>{`
                .notice-editor-quill .quill { height: 100%; display: flex; flex-direction: column; background: #1e293b; border-radius: 0.75rem; border: 1px solid #334155; overflow: hidden; }
                .notice-editor-quill .ql-toolbar { background: #334155; border: none !important; border-bottom: 1px solid #475569 !important; }
                .notice-editor-quill .ql-container { flex: 1; border: none !important; font-family: inherit; font-size: 0.875rem; color: #e2e8f0; }
                .notice-editor-quill .ql-editor { min-height: 200px; }
                .notice-editor-quill .ql-stroke { stroke: #94a3b8 !important; }
                .notice-editor-quill .ql-fill { fill: #94a3b8 !important; }
                .notice-editor-quill .ql-picker { color: #94a3b8 !important; }
                .notice-editor-quill .ql-editor img { max-width: 100%; height: auto; border-radius: 0.5rem; margin: 8px 0; }
            `}</style>
            <div className="flex-1 min-h-0 notice-editor-quill">
                <ReactQuill ref={quillRef} theme="snow" value={content} onChange={setContent} modules={quillModules} className="h-full" />
            </div>
            <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => onSave(content)} className="flex-1 bg-sky-600 text-white font-bold py-3 rounded-xl hover:bg-sky-500 transition-colors shadow-lg shadow-sky-900/20">
                    Save Notice
                </button>
                <button onClick={onCancel} className="px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors">
                    Cancel
                </button>
            </div>
        </div>
    );
};

const NoticeHomeView: React.FC<{ notice: string; onStart: () => void }> = ({ notice, onStart }) => {
    return (
        <div className="h-full overflow-y-auto flex justify-center items-start p-10 bg-slate-950/20 font-sans">
            <div className="max-w-6xl w-full bg-slate-900/60 backdrop-blur-3xl border border-white/10 rounded-[2.5rem] p-12 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col items-center text-center relative overflow-hidden group h-fit my-auto">
                {/* Decorative Elements */}
                <div className="absolute -top-24 -left-24 w-64 h-64 bg-cyan-500/10 rounded-full blur-[80px] group-hover:bg-cyan-500/20 transition-colors duration-700" />
                <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-amber-500/5 rounded-full blur-[80px] group-hover:bg-amber-500/10 transition-colors duration-700" />

                {/* Header */}
                <div className="w-20 h-20 rounded-3xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 mb-8 shadow-[0_0_20px_rgba(34,211,238,0.1)] relative z-10">
                    <svg className="w-10 h-10 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                    </svg>
                </div>

                <h1 className="text-3xl font-black text-white mb-3 tracking-tighter relative z-10">공지사항 (Notice)</h1>
                <p className="text-slate-400 text-base mb-8 font-medium relative z-10">작업 시작 전 지침 사항을 반드시 숙지해 주시기 바랍니다.</p>

                <div className="w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent mb-10 relative z-10" />

                {/* Content */}
                <div className="w-full bg-slate-950/40 border border-white/5 rounded-3xl p-10 mb-12 text-left relative z-10 min-h-[300px]">
                    <div
                        className="text-[1.1rem] text-slate-200 whitespace-pre-wrap leading-[1.8] font-medium prose prose-invert max-w-none"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(notice || '<span class="text-slate-500 italic">게시된 공지사항이 없습니다.</span>') }}
                    />
                </div>

                {/* Action */}
                <button
                    onClick={onStart}
                    className="group/btn relative px-12 py-5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-2xl text-xl font-bold transition-all duration-300 shadow-[0_10px_30px_rgba(8,145,178,0.3)] hover:shadow-[0_15px_40px_rgba(8,145,178,0.5)] hover:-translate-y-1 relative z-10 overflow-hidden"
                >
                    <span className="relative z-10 flex items-center gap-3">
                        작업 시작하기 (Go to Work List)
                        <svg className="w-6 h-6 group-hover/btn:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                    </span>
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20 group-hover/btn:h-full transition-all duration-300" />
                </button>
            </div>
        </div>
    );
};

const Dashboard: React.FC<DashboardProps> = ({
    role,
    accountType,
    onSelectTask,
    onRefresh,
    onSync,
    onFullDiskSync,
    onSyncProject,
    onSyncFolders,
    onAdoptFolders,
    onLightRefresh,
    onFolderPrepareLoading,
    tasks,
    username,
    token,
    openIssueRequestsSignal,
    openUserManagementSignal,
    workerOverviewRefreshKey = 0,
    reviewerScopeWorker = null,
    onClearReviewerScope
}) => {
    const [workers, setWorkers] = useState<string[]>([]);
    const [workerProjectOverview, setWorkerProjectOverview] = useState<Storage.ProjectOverviewPayload | null>(null);

    useEffect(() => {
        const fetchProjectOverview = async () => {
            try {
                const payload = await Storage.getProjectOverview();
                setWorkerProjectOverview(payload || null);
            } catch (_e) {
                setWorkerProjectOverview(null);
            }
        };
        fetchProjectOverview();
        /** tasks.length 제외: 작업 목록 변동마다 overview 재호출 → 서버 대기열·pending 폭주 방지 */
    }, [accountType, workerOverviewRefreshKey]);

    const hiddenWorkerProjectIds = useMemo(() => {
        if (accountType === AccountType.ADMIN || !workerProjectOverview) return new Set<string>();
        const hidden = new Set<string>();
        (workerProjectOverview.projects || []).forEach((project) => {
            if (project.status === 'ARCHIVED' || project.visibleToWorkers === false) {
                hidden.add(String(project.id));
            }
        });
        return hidden;
    }, [accountType, workerProjectOverview]);

    const isWorkerVisibleFolder = (folderName: string): boolean => {
        if (accountType === AccountType.ADMIN || !workerProjectOverview) return true;
        const projectId = resolveProjectMapEntryForFolder(folderName, workerProjectOverview.projectMap || {})?.projectId;
        if (!projectId) return true;
        return !hiddenWorkerProjectIds.has(String(projectId));
    };

    const visibleTasks = useMemo(() => {
        if (role === UserRole.WORKER) {
            return tasks.filter((t) => t.assignedWorker === username && t.status !== TaskStatus.APPROVED && isWorkerVisibleFolder(t.folder));
        } else {
            return [...tasks].sort((a, b) => {
                if (a.status === TaskStatus.SUBMITTED && b.status !== TaskStatus.SUBMITTED) return -1;
                if (a.status !== TaskStatus.SUBMITTED && b.status === TaskStatus.SUBMITTED) return 1;
                return 0;
            });
        }
    }, [role, tasks, username, accountType, workerProjectOverview, hiddenWorkerProjectIds]);

    const folderOverviews = useMemo(() => {
        const map = new Map<string, {
            name: string;
            count: number;
            completed: number;
            todo: number;
            inProgress: number;
            submitted: number;
            approved: number;
            rejected: number;
            assignedWorker?: string;
            lastUpdated?: number;
        }>();

        /** 작업자 Work List·폴더 요약: (folder,effectiveWorker) breakdown 우선 — 전체 폴더 한 줄과 슬라이더 불일치 방지 */
        if (role === UserRole.WORKER && workerProjectOverview) {
            const uid = String(username || '').trim();
            const breakdown = workerProjectOverview.workerFolderBreakdown;
            if (breakdown?.length) {
                return breakdown
                    .filter((row) => String(row.assignedWorker || '').trim() === uid && isWorkerVisibleFolder(row.folder))
                    .map((row) => {
                        const count = Math.max(0, Number(row.taskCount || 0));
                        const completed = Math.max(0, Math.min(count, Number(row.completedCount || 0)));
                        const rest = Math.max(0, count - completed);
                        return {
                            name: row.folder,
                            count,
                            completed,
                            todo: rest,
                            inProgress: 0,
                            submitted: 0,
                            approved: 0,
                            rejected: 0,
                            assignedWorker: row.assignedWorker,
                            lastUpdated: row.lastUpdated
                        };
                    })
                    .sort((a, b) => a.name.localeCompare(b.name));
            }
            if (workerProjectOverview.folders?.length) {
                return workerProjectOverview.folders
                    .filter((row) => String(row.assignedWorker || '').trim() === uid && isWorkerVisibleFolder(row.folder))
                    .map((row) => {
                        const count = Math.max(0, Number(row.taskCount || 0));
                        const completed = Math.max(0, Math.min(count, Number(row.completedCount || 0)));
                        const rest = Math.max(0, count - completed);
                        return {
                            name: row.folder,
                            count,
                            completed,
                            todo: rest,
                            inProgress: 0,
                            submitted: 0,
                            approved: 0,
                            rejected: 0,
                            assignedWorker: row.assignedWorker,
                            lastUpdated: row.lastUpdated
                        };
                    })
                    .sort((a, b) => a.name.localeCompare(b.name));
            }
        }

        const sourceTasks =
            role === UserRole.WORKER
                ? visibleTasks
                : role === UserRole.REVIEWER && reviewerScopeWorker
                  ? tasks.filter((t) => String(t.assignedWorker || '').trim() === reviewerScopeWorker)
                  : tasks;
        sourceTasks.forEach(t => {
            if (!map.has(t.folder)) {
                map.set(t.folder, {
                    name: t.folder,
                    count: 0,
                    completed: 0,
                    todo: 0,
                    inProgress: 0,
                    submitted: 0,
                    approved: 0,
                    rejected: 0,
                    assignedWorker: t.assignedWorker
                });
            }
            const info = map.get(t.folder)!;
            info.count++;
            if (t.status === TaskStatus.APPROVED) info.approved++;
            else if (t.status === TaskStatus.SUBMITTED) info.submitted++;
            else if (t.status === TaskStatus.REJECTED) info.rejected++;
            else if (t.status === TaskStatus.IN_PROGRESS) info.inProgress++;
            else info.todo++;

            if (t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED) {
                info.completed++;
            }

            if (t.lastUpdated && (!info.lastUpdated || t.lastUpdated > info.lastUpdated)) {
                info.lastUpdated = t.lastUpdated;
            }
        });

        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [role, tasks, visibleTasks, workerProjectOverview, username, accountType, hiddenWorkerProjectIds, reviewerScopeWorker]);

    const assignedWorkListFolders = useMemo(() => {
        return folderOverviews
            .filter((f) => String(f.assignedWorker || '').trim() === String(username || '').trim())
            .filter((f) => isWorkerVisibleFolder(f.name))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [folderOverviews, username, accountType, workerProjectOverview, hiddenWorkerProjectIds]);

    const assignedWorkListGrouped = useMemo(
        () => groupByTopLevel(assignedWorkListFolders, (f) => f.name),
        [assignedWorkListFolders]
    );

    /** Work List 경로 그룹 접기(기본 접힘); 펼친 그룹 키만 보관 */
    const [workListExpandedPathGroups, setWorkListExpandedPathGroups] = useState<Set<string>>(() => new Set());

    useEffect(() => {
        const fetchWorkers = async () => {
            try {
                const res = await fetch(apiUrl('/api/users'), {
                    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
                });
                if (res.ok) {
                    const data = await res.json();
                    const workerList = data
                        .filter((u: any) => u.accountType === 'WORKER')
                        .map((u: any) => u.username);
                    setWorkers(workerList);
                }
            } catch (e) {
                console.error("Failed to fetch workers", e);
            }
        };
        fetchWorkers();
    }, [token]);

    const [selectedFolder, setSelectedFolder] = useState<string>(role === UserRole.WORKER ? NOTICE_HOME_VIEW : '');
    const [folderMeta, setFolderMeta] = useState<FolderMetadata>({ tags: [], memo: '' });
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [tempMeta, setTempMeta] = useState<FolderMetadata>({ tags: [], memo: '' });
    const [newTagInput, setNewTagInput] = useState('');
    const [isExporting, setIsExporting] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isLightRefreshing, setIsLightRefreshing] = useState(false);
    const [convertedFolders] = useState<Set<string>>(new Set());

    const [loading, setLoading] = useState(false);
    const [noticeContent, setNoticeContent] = useState('');
    const [isEditingNotice, setIsEditingNotice] = useState(false);

    const [folderReturnView, setFolderReturnView] = useState<string>('');
    const [activeProjectWorkflowSourceType, setActiveProjectWorkflowSourceType] = useState<'' | 'native-yolo' | 'vlm-review' | 'image-classification'>('');
    const [overviewRefreshKey, setOverviewRefreshKey] = useState(0);
    /** 폴더 상세: 서버 페이지네이션 + folder-metrics */
    const [folderPager, setFolderPager] = useState<{
        folder: string;
        sort: 'name' | 'id';
        items: Task[];
        total: number;
        metrics: Storage.FolderMetricsPayload | null;
        loading: boolean;
        loadingMore: boolean;
    } | null>(null);
    const [continueWorkLoading, setContinueWorkLoading] = useState(false);
    const isProjectDetailView = selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX);
    const selectedProjectId = isProjectDetailView ? selectedFolder.substring(PROJECT_DETAIL_VIEW_PREFIX.length) : '';

    useEffect(() => {
        if (accountType === AccountType.ADMIN) return;
        if (!selectedFolder) return;
        const nonFolderViews = new Set([
            DASHBOARD_HOME_VIEW,
            WORK_LIST_VIEW,
            USER_MANAGEMENT_VIEW,
            WORKER_REPORT_VIEW,
            WEEKLY_REPORT_VIEW,
            DAILY_REPORT_VIEW,
            SCHEDULE_VIEW,
            ISSUE_REQUEST_VIEW,
            PROJECT_OVERVIEW_VIEW,
            DATA_IMPORT_EXPORT_VIEW,
            REVIEW_QUEUE_VIEW
        ]);
        if (nonFolderViews.has(selectedFolder) || selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX)) return;
        if (!isWorkerVisibleFolder(selectedFolder)) {
            setSelectedFolder(WORK_LIST_VIEW);
        }
    }, [accountType, selectedFolder, workerProjectOverview, hiddenWorkerProjectIds]);

    useEffect(() => {
        const fetchNotice = async () => {
            try {
                const res = await fetch(apiUrl('/api/label?path=datasets/_notice.txt'));
                if (res.ok) {
                    const text = await res.text();
                    setNoticeContent(text);
                }
            } catch (e) {
                console.error("Failed to fetch notice", e);
            }
        };
        fetchNotice();
    }, []);

    const handleSaveNotice = async (content: string) => {
        try {
            await fetch(apiUrl('/api/save'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: 'datasets/_notice.txt',
                    content
                })
            });
            setNoticeContent(content);
            setIsEditingNotice(false);
        } catch (e) {
            alert('Failed to save notice');
        }
    };

    useEffect(() => {
        if (!selectedFolder) {
            setSelectedFolder(accountType === AccountType.ADMIN ? PROJECT_OVERVIEW_VIEW : DASHBOARD_HOME_VIEW);
        }
    }, [accountType, selectedFolder]);

    useEffect(() => {
        if (accountType === AccountType.ADMIN && (selectedFolder === DASHBOARD_HOME_VIEW || selectedFolder === WORK_LIST_VIEW)) {
            setSelectedFolder(PROJECT_OVERVIEW_VIEW);
        }
    }, [accountType, selectedFolder]);

    useEffect(() => {
        const nonFolderViews = new Set([
            DASHBOARD_HOME_VIEW,
            WORK_LIST_VIEW,
            DATA_IMPORT_EXPORT_VIEW,
            PROJECT_OVERVIEW_VIEW,
            USER_MANAGEMENT_VIEW,
            WORKER_REPORT_VIEW,
            WEEKLY_REPORT_VIEW,
            DAILY_REPORT_VIEW,
            SCHEDULE_VIEW,
            ISSUE_REQUEST_VIEW,
            REVIEW_QUEUE_VIEW
        ]);
        if (selectedFolder && (nonFolderViews.has(selectedFolder) || selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX))) {
            setFolderReturnView('');
            setActiveProjectWorkflowSourceType('');
        }
    }, [selectedFolder]);

    useEffect(() => {
        if (accountType === AccountType.ADMIN && openIssueRequestsSignal) {
            setSelectedFolder(ISSUE_REQUEST_VIEW);
        }
    }, [accountType, openIssueRequestsSignal]);

    useEffect(() => {
        if (accountType === AccountType.ADMIN && openUserManagementSignal) {
            setSelectedFolder(USER_MANAGEMENT_VIEW);
        }
    }, [accountType, openUserManagementSignal]);

    useEffect(() => {
        if (role === UserRole.WORKER && selectedFolder === REVIEW_QUEUE_VIEW) {
            setSelectedFolder(PROJECT_OVERVIEW_VIEW);
        }
    }, [role, selectedFolder]);

    useEffect(() => {
        const handleFolderEntry = async () => {
            const nonFolderViews = new Set([
                DASHBOARD_HOME_VIEW,
                WORK_LIST_VIEW,
                DATA_IMPORT_EXPORT_VIEW,
                PROJECT_OVERVIEW_VIEW,
                USER_MANAGEMENT_VIEW,
                WORKER_REPORT_VIEW,
                WEEKLY_REPORT_VIEW,
                DAILY_REPORT_VIEW,
                SCHEDULE_VIEW,
                ISSUE_REQUEST_VIEW,
                REVIEW_QUEUE_VIEW
            ]);
            if (selectedFolder && !nonFolderViews.has(selectedFolder) && !selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX)) {
                const meta = Storage.getFolderMetadata(selectedFolder);
                setFolderMeta(meta);
                setTempMeta(meta);

                setIsEditingMeta(false);
            }
        };
        handleFolderEntry();
    }, [selectedFolder]);

    /** 실제 datasets 폴더 선택 시: 서버 folder-metrics + 페이지 단위 목록(캐시 머지) */
    const folderHydrateSeqRef = useRef(0);
    useEffect(() => {
        const nonFolderViews = new Set([
            DASHBOARD_HOME_VIEW,
            WORK_LIST_VIEW,
            DATA_IMPORT_EXPORT_VIEW,
            PROJECT_OVERVIEW_VIEW,
            USER_MANAGEMENT_VIEW,
            WORKER_REPORT_VIEW,
            WEEKLY_REPORT_VIEW,
            DAILY_REPORT_VIEW,
            SCHEDULE_VIEW,
            ISSUE_REQUEST_VIEW,
            NOTICE_HOME_VIEW,
            REVIEW_QUEUE_VIEW
        ]);
        if (!selectedFolder || nonFolderViews.has(selectedFolder) || selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX)) {
            setFolderPager(null);
            return;
        }
        const seq = ++folderHydrateSeqRef.current;
        let loadingShown = false;
        if (onFolderPrepareLoading) {
            onFolderPrepareLoading(true);
            loadingShown = true;
        }
        void (async () => {
            try {
                setFolderPager({
                    folder: selectedFolder,
                    sort: 'name',
                    items: [],
                    total: 0,
                    metrics: null,
                    loading: true,
                    loadingMore: false
                });
                const [metrics, peek, count] = await Promise.all([
                    Storage.fetchFolderMetricsFromServer(selectedFolder),
                    Storage.peekFolderFirstTaskRemote(selectedFolder),
                    Storage.getFolderTaskCountFromServer(selectedFolder)
                ]);
                if (seq !== folderHydrateSeqRef.current) return;
                const sort: 'name' | 'id' = peek?.sourceType === 'vlm-review' ? 'id' : 'name';
                const page = await Storage.fetchFolderTaskPageIntoCache(
                    selectedFolder,
                    0,
                    Storage.FOLDER_TASK_LIST_PAGE_SIZE,
                    sort
                );
                if (seq !== folderHydrateSeqRef.current) return;
                onRefresh();
                const total = count ?? metrics?.total ?? page.length;
                setFolderPager({
                    folder: selectedFolder,
                    sort,
                    items: page,
                    total,
                    metrics,
                    loading: false,
                    loadingMore: false
                });
            } catch (e) {
                console.error('Folder task hydrate failed', e);
                if (seq === folderHydrateSeqRef.current) {
                    setFolderPager(null);
                }
            } finally {
                if (loadingShown && seq === folderHydrateSeqRef.current) {
                    onFolderPrepareLoading?.(false);
                }
            }
        })();
    }, [selectedFolder, onRefresh, onFolderPrepareLoading]);

    const handleSaveMeta = async () => {
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

    const handleAssignWorker = async (folderName: string, workerName: string) => {
        const worker = workerName === 'Unassigned' ? undefined : workerName;
        await Storage.assignFolderToWorker(folderName, worker);
        onRefresh();
    };

    const tasksInFolder = useMemo(() => {
        if (!selectedFolder) return [];

        const applyWorkflowFilterAndSort = (base: Task[]): Task[] => {
            const useProjectWorkflowFilter = Boolean(folderReturnView && activeProjectWorkflowSourceType);
            const isVlmFolder = base.length > 0 && base.some((t) => t.sourceType === 'vlm-review');
            const sortBy = (a: { id: string; name: string }, b: { id: string; name: string }) =>
                isVlmFolder ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true });
            if (!useProjectWorkflowFilter) {
                return [...base].sort(sortBy);
            }
            const filtered = base.filter((t) => {
                const sourceType =
                    t.sourceType === 'vlm-review'
                        ? 'vlm-review'
                        : t.sourceType === 'image-classification'
                          ? 'image-classification'
                          : 'native-yolo';
                return sourceType === activeProjectWorkflowSourceType;
            });
            const effective = filtered.length > 0 ? filtered : base;
            return [...effective].sort(sortBy);
        };

        let out: Task[];
        if (folderPager && folderPager.folder === selectedFolder) {
            if (!folderPager.loading && folderPager.items.length >= 0) {
                out = applyWorkflowFilterAndSort(folderPager.items);
            } else {
                const fallback = visibleTasks.filter((t) => t.folder === selectedFolder);
                out = applyWorkflowFilterAndSort(fallback);
            }
        } else {
            const allInFolder = visibleTasks.filter((t) => t.folder === selectedFolder);
            out = applyWorkflowFilterAndSort(allInFolder);
        }
        if (role === UserRole.REVIEWER && reviewerScopeWorker) {
            return out.filter((t) => String(t.assignedWorker || '').trim() === reviewerScopeWorker);
        }
        return out;
    }, [visibleTasks, selectedFolder, activeProjectWorkflowSourceType, folderReturnView, workerProjectOverview, folderPager, role, reviewerScopeWorker]);

    /** 작업 이어하기: 폴더 전체 페이지를 캐시에 받은 뒤 미완료 태스크 검색(첫 페이지만 보던 버그 방지) */
    const handleContinueWorkInFolder = useCallback(
        async (mode: 'todo-only' | 'pending-worker') => {
            const folder = String(selectedFolder || '').trim();
            if (!folder) return;

            let sort: 'name' | 'id' | 'updated' =
                folderPager?.folder === folder ? folderPager.sort : 'name';
            let totalHint: number | null =
                folderPager?.folder === folder ? folderPager.total ?? null : null;

            try {
                setContinueWorkLoading(true);
                onFolderPrepareLoading?.(true);

                if (!folderPager || folderPager.folder !== folder) {
                    const peek = await Storage.peekFolderFirstTaskRemote(folder);
                    sort = peek?.sourceType === 'vlm-review' ? 'id' : 'name';
                    totalHint = await Storage.getFolderTaskCountFromServer(folder);
                }

                await Storage.fetchAllFolderPagesIntoCache(folder, sort, totalHint);
                onRefresh();

                const allTasks = Storage.getTasks();
                const raw = allTasks.filter((t) => t.folder === folder);
                let base: Task[];
                if (role === UserRole.WORKER) {
                    base = raw.filter(
                        (t) =>
                            t.assignedWorker === username &&
                            t.status !== TaskStatus.APPROVED &&
                            isWorkerVisibleFolder(t.folder)
                    );
                } else if (role === UserRole.REVIEWER && reviewerScopeWorker) {
                    base = raw.filter((t) => String(t.assignedWorker || '').trim() === reviewerScopeWorker);
                } else {
                    base = raw;
                }

                const useProjectWorkflowFilter = Boolean(folderReturnView && activeProjectWorkflowSourceType);
                const isVlmFolder = base.length > 0 && base.some((t) => t.sourceType === 'vlm-review');
                const sortBy = (a: { id: string; name: string }, b: { id: string; name: string }) =>
                    isVlmFolder ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name, undefined, { numeric: true });

                let folderTasks: Task[];
                if (!useProjectWorkflowFilter) {
                    folderTasks = [...base].sort(sortBy);
                } else {
                    const filtered = base.filter((t) => {
                        const sourceType =
                            t.sourceType === 'vlm-review'
                                ? 'vlm-review'
                                : t.sourceType === 'image-classification'
                                  ? 'image-classification'
                                  : 'native-yolo';
                        return sourceType === activeProjectWorkflowSourceType;
                    });
                    const effective = filtered.length > 0 ? filtered : base;
                    folderTasks = [...effective].sort(sortBy);
                }

                setFolderPager((p) => {
                    if (!p || p.folder !== folder) return p;
                    return {
                        ...p,
                        items: folderTasks,
                        total: folderTasks.length,
                        loading: false,
                        loadingMore: false,
                        sort: sort === 'updated' ? p.sort : (sort as 'name' | 'id')
                    };
                });

                if (mode === 'todo-only') {
                    const first = folderTasks.find((t) => t.status === TaskStatus.TODO);
                    if (first) onSelectTask(first.id);
                    else alert('이 폴더에서 TODO 상태 작업을 찾지 못했습니다.');
                    return;
                }

                const firstPending = folderTasks.find(
                    (t) =>
                        t.status === TaskStatus.TODO ||
                        t.status === TaskStatus.IN_PROGRESS ||
                        t.status === TaskStatus.REJECTED
                );
                if (firstPending) onSelectTask(firstPending.id);
                else alert('이 폴더에서 진행할 작업(TODO/진행중/반려)을 찾지 못했습니다.');
            } catch (e) {
                console.error('Continue work / full folder load failed', e);
                alert('폴더 작업 목록을 불러오지 못했습니다. 네트워크 또는 서버를 확인해 주세요.');
            } finally {
                onFolderPrepareLoading?.(false);
                setContinueWorkLoading(false);
            }
        },
        [
            selectedFolder,
            folderPager,
            role,
            username,
            folderReturnView,
            activeProjectWorkflowSourceType,
            onRefresh,
            onSelectTask,
            onFolderPrepareLoading,
            isWorkerVisibleFolder,
            reviewerScopeWorker
        ]
    );

    const activeFolderStats = useMemo(() => {
        if (!selectedFolder) return null;
        const ov = folderOverviews.find(f => f.name === selectedFolder);
        const reviewerScoped = role === UserRole.REVIEWER && Boolean(reviewerScopeWorker);
        /** 서버 metrics는 폴더 전체 — 검수자·특정 작업자 범위일 때는 캐시 집계(ov·태스크)만 사용 */
        if (!reviewerScoped && folderPager && folderPager.folder === selectedFolder && folderPager.metrics) {
            const m = folderPager.metrics;
            return {
                name: selectedFolder,
                count: m.total,
                completed: m.completed,
                todo: m.todo,
                inProgress: m.inProgress,
                submitted: m.submitted,
                approved: m.approved,
                rejected: m.rejected,
                assignedWorker: ov?.assignedWorker,
                lastUpdated: ov?.lastUpdated
            };
        }
        return ov ?? null;
    }, [folderOverviews, selectedFolder, folderPager, role, reviewerScopeWorker]);

    const activeFolderDetails = useMemo(() => {
        if (!selectedFolder) return null;
        if (folderPager && folderPager.folder === selectedFolder && folderPager.metrics) {
            return { modifiedCount: folderPager.metrics.modifiedCount, classCount: 0 };
        }
        let allInFolder = tasks.filter(t => t.folder === selectedFolder);
        if (role === UserRole.REVIEWER && reviewerScopeWorker) {
            allInFolder = allInFolder.filter((t) => String(t.assignedWorker || '').trim() === reviewerScopeWorker);
        }
        const modifiedCount = allInFolder.filter(t => t.isModified).length;
        const uniqueClasses = new Set<number>();
        allInFolder.forEach(t => {
            if (t.annotations) {
                t.annotations.forEach(a => uniqueClasses.add(a.classId));
            }
        });
        return { modifiedCount, classCount: uniqueClasses.size };
    }, [tasks, selectedFolder, folderPager, role, reviewerScopeWorker]);

    const renderedTasks = tasksInFolder;
    const representativeTask = tasksInFolder.length > 0 ? tasksInFolder[0] : null;

    const handleLoadMoreFolderTasks = async () => {
        if (!folderPager || folderPager.folder !== selectedFolder || folderPager.loadingMore || folderPager.loading) return;
        if (folderPager.items.length >= folderPager.total) return;
        const sort = folderPager.sort;
        const offset = folderPager.items.length;
        setFolderPager((p) => (p && p.folder === selectedFolder ? { ...p, loadingMore: true } : p));
        try {
            const next = await Storage.fetchFolderTaskPageIntoCache(selectedFolder, offset, Storage.FOLDER_TASK_LIST_PAGE_SIZE, sort);
            onRefresh();
            setFolderPager((p) => {
                if (!p || p.folder !== selectedFolder) return p;
                return { ...p, items: [...p.items, ...next], loadingMore: false };
            });
        } catch (e) {
            console.error('Load more folder tasks failed', e);
            setFolderPager((p) => (p && p.folder === selectedFolder ? { ...p, loadingMore: false } : p));
        }
    };

    /** DB·캐시만 갱신 (디스크 스캔 없음) */
    const handleSync = async () => {
        setIsSyncing(true);
        try {
            await onSync();
        } catch (e) {
            console.error(e);
            alert('새로고침에 실패했습니다.');
        } finally {
            setIsSyncing(false);
        }
    };

    const handleFullDiskSyncClick = async () => {
        if (!onFullDiskSync) return;
        setIsSyncing(true);
        try {
            await onFullDiskSync();
        } catch (e) {
            console.error(e);
            alert('전체 디스크 스캔에 실패했습니다.');
        } finally {
            setIsSyncing(false);
        }
    };

    const handleLightRefresh = async () => {
        if (!onLightRefresh) return;
        setIsLightRefreshing(true);
        try {
            await onLightRefresh();
        } catch (e) {
            console.error(e);
            alert("Refresh failed");
        } finally {
            setIsLightRefreshing(false);
        }
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
        <div className="w-full h-full flex flex-col bg-slate-950 p-6 overflow-hidden">

            {/* --- 상단 액션 (Total Progress/Tasks/Time 제거: 전량 datasets 로드 유발) --- */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-md flex flex-wrap gap-8 items-center justify-end shrink-0">
                <div className="flex gap-3 flex-wrap justify-end">
                    {accountType === AccountType.ADMIN && (
                        <>
                            <button
                                onClick={handleLightRefresh}
                                disabled={isLightRefreshing || isSyncing}
                                className="bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-700/50 px-4 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all shadow active:scale-[0.98] disabled:opacity-50"
                                title="파일 스캔 없이 DB 기준으로 진행 현황만 새로고침"
                            >
                                {isLightRefreshing ? (
                                    <svg className="animate-spin h-4 w-4 text-emerald-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                ) : (
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h4a1 1 0 010 2H5v3a1 1 0 11-2 0V4zm18 0a1 1 0 00-1-1h-4a1 1 0 100 2h3v3a1 1 0 102 0V4zM3 20a1 1 0 001 1h4a1 1 0 100-2H5v-3a1 1 0 10-2 0v4zm18 0a1 1 0 01-1 1h-4a1 1 0 110-2h3v-3a1 1 0 112 0v4z" /></svg>
                                )}
                                {isLightRefreshing ? 'Refreshing...' : 'Refresh Metrics'}
                            </button>
                            <button
                                onClick={handleSync}
                                disabled={isSyncing || isLightRefreshing}
                                className="bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-700/50 px-4 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all shadow active:scale-[0.98] disabled:opacity-50"
                                title="디스크 스캔 없이 DB 기준 작업 목록·통계만 새로고침"
                            >
                                {isSyncing ? (
                                    <svg className="animate-spin h-4 w-4 text-emerald-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                ) : (
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                )}
                                {isSyncing ? '새로고침…' : 'DB 새로고침'}
                            </button>
                            {onFullDiskSync && (
                                <button
                                    type="button"
                                    onClick={() => void handleFullDiskSyncClick()}
                                    disabled={isSyncing || isLightRefreshing}
                                    className="bg-slate-900 hover:bg-slate-800 text-amber-200/90 border border-amber-800/60 px-4 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all shadow active:scale-[0.98] disabled:opacity-50"
                                    title="datasets 전체 디스크 스캔 — 프로젝트 상세의 동기화를 권장"
                                >
                                    전체 디스크 스캔
                                </button>
                            )}
                        </>
                    )}
                    {accountType !== AccountType.ADMIN && onLightRefresh && (
                        <button
                            onClick={handleLightRefresh}
                            disabled={isLightRefreshing}
                            className="bg-slate-800 hover:bg-slate-700 text-sky-300 border border-sky-700/50 px-4 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all shadow active:scale-[0.98] disabled:opacity-50"
                            title="DB에 반영된 목록만 새로고침 (폴더 스캔 없음)"
                        >
                            {isLightRefreshing ? (
                                <svg className="animate-spin h-4 w-4 text-sky-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                            ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                            )}
                            {isLightRefreshing ? '새로고침 중...' : '목록 새로고침'}
                        </button>
                    )}
                </div>
            </div>

            {/* --- Main Workspace --- */}
            <div className="flex-1 flex gap-6 overflow-hidden">

                {/* Left Sidebar: Navigation */}
                <div className="w-[280px] flex-shrink-0 flex flex-col bg-slate-900 border border-slate-800 rounded-xl shadow-md overflow-hidden">
                    <div className="p-4 border-b border-slate-800 bg-slate-800/30">
                        <h3 className="font-bold text-slate-300 text-sm uppercase tracking-wide">Dashboard</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 space-y-1">
                        {accountType !== AccountType.ADMIN && (
                            <>
                                <button
                                    onClick={() => setSelectedFolder(NOTICE_HOME_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === NOTICE_HOME_VIEW
                                        ? 'bg-amber-900/30 text-amber-200 border border-amber-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>
                                    Notice
                                </button>
                                <button
                                    onClick={() => setSelectedFolder(DASHBOARD_HOME_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === DASHBOARD_HOME_VIEW
                                        ? 'bg-cyan-900/30 text-cyan-200 border border-cyan-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l9-9 9 9M4 10v10h16V10" /></svg>
                                    Dashboard
                                </button>
                                <button
                                    onClick={() => setSelectedFolder(WORK_LIST_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === WORK_LIST_VIEW
                                        ? 'bg-sky-900/30 text-sky-200 border border-sky-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                                    Work List
                                </button>
                            </>
                        )}

                        {accountType === AccountType.ADMIN && (
                            <>
                                <div className="my-3 border-t border-slate-800" />
                                <button
                                    onClick={() => setSelectedFolder(PROJECT_OVERVIEW_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${(selectedFolder === PROJECT_OVERVIEW_VIEW || selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX))
                                        ? 'bg-cyan-900/30 text-cyan-200 border border-cyan-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h18M6 12h12M9 17h6" /></svg>
                                    Project Overview
                                </button>
                                {role === UserRole.REVIEWER && (
                                    <button
                                        onClick={() => setSelectedFolder(REVIEW_QUEUE_VIEW)}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === REVIEW_QUEUE_VIEW
                                            ? 'bg-purple-900/40 text-purple-100 border border-purple-600/50 shadow-sm'
                                            : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                            }`}
                                    >
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                                        검수 큐
                                    </button>
                                )}
                                <button
                                    onClick={() => setSelectedFolder(WORKER_REPORT_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${(selectedFolder === WORKER_REPORT_VIEW || selectedFolder === WEEKLY_REPORT_VIEW || selectedFolder === DAILY_REPORT_VIEW)
                                        ? 'bg-blue-900/30 text-blue-200 border border-blue-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2a4 4 0 00-4-4H5m11 0h.01M16 21h4a2 2 0 002-2v-9a2 2 0 00-2-2H6a2 2 0 00-2 2v1h2m10-4V7a2 2 0 00-2-2H8a2 2 0 00-2 2v2m4 6h.01" /></svg>
                                    Reports
                                </button>
                                <button
                                    onClick={() => setSelectedFolder(SCHEDULE_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === SCHEDULE_VIEW
                                        ? 'bg-violet-900/30 text-violet-200 border border-violet-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                    Schedule
                                </button>
                                <button
                                    onClick={() => setSelectedFolder(ISSUE_REQUEST_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === ISSUE_REQUEST_VIEW
                                        ? 'bg-rose-900/30 text-rose-200 border border-rose-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l6.518 11.593c.75 1.334-.213 2.998-1.742 2.998H3.48c-1.53 0-2.492-1.664-1.743-2.998L8.257 3.1z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01" /></svg>
                                    Issue Requests
                                </button>
                                <button
                                    onClick={() => setSelectedFolder(DATA_IMPORT_EXPORT_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === DATA_IMPORT_EXPORT_VIEW
                                        ? 'bg-emerald-900/30 text-emerald-200 border border-emerald-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m10 16V8M3 20h18" /></svg>
                                    Data Import/Export
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {/* Center Content: Task List */}
                <div className="flex-1 bg-slate-900 border border-slate-800 rounded-xl shadow-md overflow-hidden flex flex-col relative min-w-0">
                    {role === UserRole.REVIEWER && reviewerScopeWorker && (
                        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-purple-950/40 border-b border-purple-800/40 text-xs text-purple-100">
                            <span>
                                검수 범위:{' '}
                                <span className="font-bold text-white">{reviewerScopeWorker}</span>
                                <span className="text-purple-300/90"> 배정 태스크만 표시</span>
                            </span>
                            {onClearReviewerScope && (
                                <button
                                    type="button"
                                    onClick={() => onClearReviewerScope()}
                                    className="shrink-0 px-2 py-1 rounded-md bg-slate-800/80 hover:bg-slate-700 text-purple-200 text-[11px] font-semibold border border-purple-700/40"
                                >
                                    전체 보기
                                </button>
                            )}
                        </div>
                    )}

                    {/* --- ADMIN VIEWS & FOLDER MODES --- */}
                    {selectedFolder === REVIEW_QUEUE_VIEW && accountType === AccountType.ADMIN && role === UserRole.REVIEWER ? (
                        <ReviewQueuePanel workers={workers} tasks={tasks} onSelectTask={onSelectTask} onRefresh={onRefresh} />
                    ) : selectedFolder === NOTICE_HOME_VIEW && accountType !== AccountType.ADMIN ? (
                        <NoticeHomeView
                            notice={noticeContent}
                            onStart={() => setSelectedFolder(WORK_LIST_VIEW)}
                        />
                    ) : selectedFolder === DASHBOARD_HOME_VIEW && accountType !== AccountType.ADMIN ? (
                        <DashboardHomeView />
                    ) : selectedFolder === WORK_LIST_VIEW && accountType !== AccountType.ADMIN ? (
                        <div className="h-full overflow-auto p-6">
                            <div className="mb-4">
                                <h2 className="text-lg font-bold text-white tracking-tight">내 배정 작업 (Work List)</h2>
                                <p className="text-sm text-slate-400 mt-1">본인에게 배정된 작업 목록입니다. 항목을 누르면 기존 폴더 상세 화면으로 이동합니다.</p>
                            </div>
                            <div className="bg-slate-900/60 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left border-collapse">
                                        <thead className="bg-slate-950/50 text-slate-500 text-[12px] font-bold uppercase tracking-widest border-b border-white/5">
                                            <tr>
                                                <th className="px-6 py-5">프로젝트명</th>
                                                <th className="px-6 py-5">폴더 경로 (Full Path)</th>
                                                <th className="px-6 py-5 w-1/4">진행 상태</th>
                                                <th className="px-6 py-5 text-right">작업량 (완료/전체)</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/5">
                                            {assignedWorkListFolders.length === 0 ? (
                                                <tr>
                                                    <td colSpan={4} className="px-6 py-16 text-center text-slate-500 text-base italic">
                                                        현재 배정된 작업이 없습니다.
                                                    </td>
                                                </tr>
                                            ) : (
                                                assignedWorkListGrouped.flatMap(({ groupName, items }) => {
                                                    const gKey = groupName || '__root__';
                                                    const isFlatOnly = items.length === 1 && items[0].name === groupName;

                                                    const renderFolderRow = (folder: (typeof items)[0], pathLabel: string, pathTitle?: string) => {
                                                        const progress = folder.count > 0 ? Math.round((folder.completed / folder.count) * 100) : 0;
                                                        const projectId = resolveProjectMapEntryForFolder(folder.name, workerProjectOverview?.projectMap || {})?.projectId;
                                                        const project = projectId ? workerProjectOverview?.projects?.find((p) => String(p.id) === String(projectId)) : null;
                                                        const projectName = project ? project.name : getTopLevelGroup(folder.name);
                                                        return (
                                                            <tr
                                                                key={folder.name}
                                                                onClick={() => {
                                                                    setFolderReturnView(WORK_LIST_VIEW);
                                                                    setActiveProjectWorkflowSourceType('');
                                                                    setSelectedFolder(folder.name);
                                                                }}
                                                                className="hover:bg-cyan-500/5 transition-all duration-200 group cursor-pointer"
                                                            >
                                                                <td className="px-6 py-6 whitespace-nowrap">
                                                                    <span className="inline-flex items-center px-4 py-1.5 rounded-md bg-slate-800 text-slate-300 text-[14px] font-bold border border-white/10 group-hover:border-cyan-500/40 group-hover:text-cyan-300 transition-colors">
                                                                        {projectName}
                                                                    </span>
                                                                </td>
                                                                <td className="px-6 py-6">
                                                                    <div
                                                                        className="text-[17px] font-bold text-slate-200 group-hover:text-white transition-colors break-all leading-relaxed"
                                                                        title={pathTitle || folder.name}
                                                                    >
                                                                        {pathLabel}
                                                                    </div>
                                                                </td>
                                                                <td className="px-6 py-6">
                                                                    <div className="flex items-center gap-4">
                                                                        <div className="flex-1 h-2 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                                                            <div
                                                                                className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.4)] transition-all duration-500"
                                                                                style={{ width: `${progress}%` }}
                                                                            />
                                                                        </div>
                                                                        <span className="text-[17px] font-black font-mono text-cyan-400 w-16 text-right whitespace-nowrap">{progress}%</span>
                                                                    </div>
                                                                </td>
                                                                <td className="px-6 py-6 text-right whitespace-nowrap">
                                                                    <div className="flex items-baseline justify-end gap-2">
                                                                        <span className="text-[20px] font-bold text-amber-400 font-mono tracking-tighter drop-shadow-[0_0_8px_rgba(251,191,36,0.3)]">
                                                                            {Number(folder.completed || 0).toLocaleString()}
                                                                        </span>
                                                                        <span className="text-[15px] text-white font-mono font-bold opacity-90">
                                                                            / {Number(folder.count || 0).toLocaleString()}
                                                                        </span>
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        );
                                                    };

                                                    if (isFlatOnly) {
                                                        return [renderFolderRow(items[0], items[0].name)];
                                                    }

                                                    const expanded = workListExpandedPathGroups.has(gKey);
                                                    const aggCompleted = items.reduce((s, f) => s + Number(f.completed || 0), 0);
                                                    const aggCount = items.reduce((s, f) => s + Number(f.count || 0), 0);
                                                    const aggProgress = aggCount > 0 ? Math.round((aggCompleted / aggCount) * 100) : 0;
                                                    const showSlash = items.some((i) => i.name !== groupName);

                                                    const headerRow = (
                                                        <tr
                                                            key={`grp-${gKey}`}
                                                            className="hover:bg-cyan-500/5 transition-all duration-200 group cursor-pointer select-none"
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                setWorkListExpandedPathGroups((prev) => {
                                                                    const next = new Set(prev);
                                                                    if (next.has(gKey)) next.delete(gKey);
                                                                    else next.add(gKey);
                                                                    return next;
                                                                });
                                                            }}
                                                        >
                                                            <td className="px-6 py-6 whitespace-nowrap align-middle">
                                                                <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-slate-800 text-slate-300 text-[14px] font-bold border border-white/10 group-hover:border-cyan-500/40 group-hover:text-cyan-300 transition-colors">
                                                                    <span className="text-cyan-400 font-mono text-xs" aria-hidden>
                                                                        {expanded ? '▼' : '▶'}
                                                                    </span>
                                                                    {items.length}개 폴더
                                                                </span>
                                                            </td>
                                                            <td className="px-6 py-6 align-middle">
                                                                <div
                                                                    className="text-[17px] font-bold text-slate-200 group-hover:text-white transition-colors break-all leading-relaxed"
                                                                    title={items.map((i) => i.name).join('\n')}
                                                                >
                                                                    {groupName}
                                                                    {showSlash ? '/' : ''}
                                                                </div>
                                                                <div className="text-[12px] text-slate-500 font-medium mt-1">
                                                                    클릭하여 {expanded ? '접기' : '펼치기'}
                                                                </div>
                                                            </td>
                                                            <td className="px-6 py-6 align-middle">
                                                                <div className="flex items-center gap-4">
                                                                    <div className="flex-1 h-2 bg-slate-950 rounded-full overflow-hidden shadow-inner">
                                                                        <div
                                                                            className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.4)] transition-all duration-500"
                                                                            style={{ width: `${aggProgress}%` }}
                                                                        />
                                                                    </div>
                                                                    <span className="text-[17px] font-black font-mono text-cyan-400 w-16 text-right whitespace-nowrap">
                                                                        {aggProgress}%
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td className="px-6 py-6 text-right whitespace-nowrap align-middle">
                                                                <div className="flex items-baseline justify-end gap-2">
                                                                    <span className="text-[20px] font-bold text-amber-400 font-mono tracking-tighter drop-shadow-[0_0_8px_rgba(251,191,36,0.3)]">
                                                                        {Number(aggCompleted).toLocaleString()}
                                                                    </span>
                                                                    <span className="text-[15px] text-white font-mono font-bold opacity-90">
                                                                        / {Number(aggCount).toLocaleString()}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    );

                                                    if (!expanded) {
                                                        return [headerRow];
                                                    }

                                                    return [headerRow, ...items.map((folder) => renderFolderRow(folder, folderPathAfterGroup(folder.name, groupName), folder.name))];
                                                })
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    ) : isProjectDetailView && accountType === AccountType.ADMIN ? (
                        <ProjectDetailView
                            projectId={selectedProjectId}
                            role={role}
                            onBack={() => setSelectedFolder(PROJECT_OVERVIEW_VIEW)}
                            onArchived={() => onRefresh()}
                            onRefresh={onRefresh}
                            onRefreshTasksFromServer={onLightRefresh}
                            onSyncProject={onSyncProject}
                            workerNames={workers}
                            onOpenFolder={async (folderName, workflowSourceType) => {
                                const wf = workflowSourceType === 'vlm-review' ? 'vlm-review' : workflowSourceType === 'image-classification' ? 'image-classification' : 'native-yolo';
                                if (wf === 'image-classification') {
                                    onFolderPrepareLoading?.(true);
                                    try {
                                        await Storage.fetchAndMergeTasksByFolder(folderName);
                                        onRefresh?.();
                                    } finally {
                                        onFolderPrepareLoading?.(false);
                                    }
                                }
                                setFolderReturnView(`${PROJECT_DETAIL_VIEW_PREFIX}${selectedProjectId}`);
                                setActiveProjectWorkflowSourceType(wf);
                                setSelectedFolder(folderName);
                            }}
                            tasks={tasks}
                            onSelectTask={onSelectTask}
                        />
                    ) : selectedFolder === PROJECT_OVERVIEW_VIEW && accountType === AccountType.ADMIN ? (
                        <ProjectOverviewView
                            onSync={async () => {
                                setIsSyncing(true);
                                try {
                                    await onSync();
                                    Storage.invalidateProjectOverviewCache();
                                    setOverviewRefreshKey((k) => k + 1);
                                } catch (e) {
                                    console.error(e);
                                    alert('새로고침에 실패했습니다.');
                                } finally {
                                    setIsSyncing(false);
                                }
                            }}
                            onFullDiskSync={
                                onFullDiskSync
                                    ? async () => {
                                          setIsSyncing(true);
                                          try {
                                              await onFullDiskSync();
                                              Storage.invalidateProjectOverviewCache();
                                              setOverviewRefreshKey((k) => k + 1);
                                          } catch (e) {
                                              console.error(e);
                                              alert('전체 디스크 스캔에 실패했습니다.');
                                          } finally {
                                              setIsSyncing(false);
                                          }
                                      }
                                    : undefined
                            }
                            onSyncFolders={
                                onSyncFolders
                                    ? async (folders) => {
                                          setIsSyncing(true);
                                          try {
                                              await onSyncFolders(folders);
                                              setOverviewRefreshKey((k) => k + 1);
                                          } catch (e) {
                                              console.error(e);
                                              alert('선택 폴더 스캔에 실패했습니다.');
                                          } finally {
                                              setIsSyncing(false);
                                          }
                                      }
                                    : undefined
                            }
                            onAdoptFolders={
                                onAdoptFolders
                                    ? async (paths, projectId, assignedWorker) => {
                                          setIsSyncing(true);
                                          try {
                                              await onAdoptFolders(paths, projectId, assignedWorker);
                                              setOverviewRefreshKey((k) => k + 1);
                                          } catch (e) {
                                              console.error(e);
                                              alert('프로젝트 등록·스캔에 실패했습니다.');
                                          } finally {
                                              setIsSyncing(false);
                                          }
                                      }
                                    : undefined
                            }
                            isSyncing={isSyncing}
                            onOpenProject={(projectId) => setSelectedFolder(`${PROJECT_DETAIL_VIEW_PREFIX}${projectId}`)}
                            overviewRefreshKey={overviewRefreshKey}
                            workerNames={workers}
                        />
                    ) : selectedFolder === USER_MANAGEMENT_VIEW && accountType === AccountType.ADMIN ? (
                        <UserManagementView token={token} />
                    ) : (selectedFolder === WORKER_REPORT_VIEW || selectedFolder === WEEKLY_REPORT_VIEW || selectedFolder === DAILY_REPORT_VIEW) && accountType === AccountType.ADMIN ? (
                        <UnifiedReportsView validWorkers={workers} onOpenSchedule={() => setSelectedFolder(SCHEDULE_VIEW)} />
                    ) : selectedFolder === ISSUE_REQUEST_VIEW && accountType === AccountType.ADMIN ? (
                        <IssueRequestView currentAdmin={username} onSelectTask={onSelectTask} />
                    ) : selectedFolder === SCHEDULE_VIEW && accountType === AccountType.ADMIN ? (
                        <ScheduleManagementView validWorkers={workers} />
                    ) : selectedFolder === DATA_IMPORT_EXPORT_VIEW && accountType === AccountType.ADMIN ? (
                        <DataImportExportView onRefreshTasks={onRefresh} workers={workers} onRefreshOverview={onRefresh} />
                    ) : (
                        // --- FOLDER DETAIL MODE ---
                        selectedFolder ? (
                            <>
                                {/* Header */}
                                <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex justify-between items-center flex-shrink-0">
                                    <div>
                                        {folderReturnView && (
                                            <button
                                                onClick={() => setSelectedFolder(folderReturnView)}
                                                className="mb-2 text-xs text-slate-400 hover:text-white transition-colors"
                                            >
                                                ← 프로젝트 상세로
                                            </button>
                                        )}
                                        <div className="flex items-center gap-3">
                                            <h2 className="text-lg font-bold text-white tracking-tight">{selectedFolder}</h2>
                                            {activeFolderStats?.assignedWorker && (
                                                <span className="text-[10px] font-bold text-sky-300 bg-sky-900/30 px-2 py-0.5 rounded-full border border-sky-800/50 uppercase tracking-wide">
                                                    {activeFolderStats.assignedWorker}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Middle Split Panel */}
                                <div className="p-6 border-b border-slate-800 grid grid-cols-1 lg:grid-cols-2 gap-4">
                                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden min-h-[250px] flex items-center justify-center">
                                        {representativeTask ? (
                                            <img
                                                src={resolveDatasetPublicUrl(representativeTask.imageUrl)}
                                                alt={representativeTask.name}
                                                className="w-full h-full object-contain bg-black"
                                            />
                                        ) : (
                                            <span className="text-sm text-slate-500 italic">No image in this folder.</span>
                                        )}
                                    </div>

                                    <div className="space-y-4">
                                        {/* Guidelines Panel */}
                                        <div className={`p-5 border border-slate-800 rounded-xl transition-colors ${role === UserRole.WORKER ? 'bg-sky-900/5' : 'bg-slate-900/50'}`}>
                                            <div className="flex items-center justify-between mb-3">
                                                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Guidelines</h3>
                                                {role === UserRole.REVIEWER && (
                                                    <button
                                                        onClick={() => setIsEditingMeta(!isEditingMeta)}
                                                        className="text-xs text-sky-400 hover:text-sky-300 font-medium"
                                                    >
                                                        {isEditingMeta ? 'Cancel' : 'Edit'}
                                                    </button>
                                                )}
                                            </div>

                                            {isEditingMeta ? (
                                                <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 space-y-3">
                                                    <div>
                                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Tags</label>
                                                        <input
                                                            type="text"
                                                            value={newTagInput}
                                                            onChange={(e) => setNewTagInput(e.target.value)}
                                                            onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                                                            placeholder="Add tags..."
                                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-sky-500 outline-none mb-2"
                                                        />
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                        {(tempMeta.tags || []).map((tag, idx) => (
                                                            <span key={`${tag}-${idx}`} className="px-2 py-1 bg-sky-600 text-white text-xs rounded-md flex items-center gap-1">
                                                                {tag}
                                                                <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-200">×</button>
                                                            </span>
                                                        ))}
                                                    </div>
                                                    <textarea
                                                        value={tempMeta.memo}
                                                        onChange={(e) => setTempMeta({ ...tempMeta, memo: e.target.value })}
                                                        className="w-full h-20 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-sky-500 outline-none resize-none"
                                                        placeholder="Instructions..."
                                                    />
                                                    <div className="flex gap-2">
                                                        <button
                                                            type="button"
                                                            disabled={continueWorkLoading}
                                                            onClick={() => void handleContinueWorkInFolder('todo-only')}
                                                            className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-sky-900/20 disabled:opacity-50 disabled:pointer-events-none"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                            작업 이어하기
                                                        </button>
                                                        {activeProjectWorkflowSourceType !== 'vlm-review' && (
                                                            <>
                                                                <button
                                                                    onClick={() => handleAssignWorker(selectedFolder, username)}
                                                                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                                                                >
                                                                    Assign to Me
                                                                </button>
                                                                <button
                                                                    onClick={() => {
                                                                        const newOwner = prompt('Enter username to assign folder to:');
                                                                        if (newOwner) handleAssignWorker(selectedFolder, newOwner);
                                                                    }}
                                                                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                                                                >
                                                                    Assign...
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                    <div className="flex justify-end">
                                                        <button
                                                            onClick={handleSaveMeta}
                                                            className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold"
                                                        >
                                                            Save
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="space-y-2">
                                                    {(folderMeta?.tags || []).length > 0 && (
                                                        <div className="flex flex-wrap gap-2">
                                                            {(folderMeta.tags || []).map((tag, idx) => (
                                                                <span key={`${tag}-${idx}`} className="px-2 py-0.5 bg-sky-500/10 text-sky-300 border border-sky-500/20 text-xs font-medium rounded-full">
                                                                    #{tag}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    <p className="text-sm text-slate-400 leading-relaxed whitespace-pre-wrap">
                                                        {folderMeta.memo || <span className="italic text-slate-600">No specific guidelines.</span>}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                        {/* Action Buttons */}
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                disabled={continueWorkLoading}
                                                onClick={() => void handleContinueWorkInFolder('pending-worker')}
                                                className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-sky-900/20 disabled:opacity-50 disabled:pointer-events-none"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                작업 이어하기
                                            </button>

                                            {role === UserRole.REVIEWER && (
                                                <button
                                                    onClick={() => {
                                                        const folderTasks = [...tasksInFolder];
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
                                            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                                                {role === UserRole.REVIEWER ? (
                                                    <div className="bg-slate-800/50 rounded-xl p-3 border border-slate-800">
                                                        <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">검수 현황</span>
                                                        <div className="flex items-baseline gap-1 mt-1">
                                                            <span className="text-xl font-bold text-white">{activeFolderStats.approved}</span>
                                                            <span className="text-xs text-slate-500">/ {activeFolderStats.completed - activeFolderStats.approved}</span>
                                                        </div>
                                                        <div className="text-[10px] text-slate-500 mt-0.5 font-medium">완료 / 대기</div>
                                                        <div className="w-full bg-slate-700 h-1 mt-2 rounded-full overflow-hidden">
                                                            <div className="bg-purple-500 h-full" style={{ width: `${activeFolderStats.completed > 0 ? (activeFolderStats.approved / activeFolderStats.completed) * 100 : 0}%` }}></div>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="bg-slate-800/50 rounded-xl p-3 border border-slate-800">
                                                        <span className="text-xs text-slate-500 font-bold uppercase">태스크</span>
                                                        <div className="flex items-baseline gap-1 mt-1">
                                                            <span className="text-xl font-bold text-white">{activeFolderStats.completed}</span>
                                                            <span className="text-xs text-slate-500">/ {activeFolderStats.count}</span>
                                                        </div>
                                                        <div className="w-full bg-slate-700 h-1 mt-2 rounded-full overflow-hidden">
                                                            <div className="bg-sky-500 h-full" style={{ width: `${activeFolderStats.count > 0 ? (activeFolderStats.completed / activeFolderStats.count) * 100 : 0}%` }}></div>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="bg-slate-800/50 rounded-xl p-3 border border-slate-800">
                                                    <span className="text-xs text-slate-500 font-bold uppercase">완료</span>
                                                    <div className="mt-1 text-xl font-bold text-lime-400">{activeFolderStats.approved}</div>
                                                </div>
                                                <div className="bg-slate-800/50 rounded-xl p-3 border border-slate-800">
                                                    <span className="text-xs text-slate-500 font-bold uppercase">반려</span>
                                                    <div className="mt-1 text-xl font-bold text-red-400">{activeFolderStats.rejected}</div>
                                                </div>
                                                <div className="bg-slate-800/50 rounded-xl p-3 border border-slate-800">
                                                    <span className="text-xs text-slate-500 font-bold uppercase">수정된 이미지</span>
                                                    <div className="mt-1 text-xl font-bold text-purple-400">{activeFolderDetails.modifiedCount}</div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Task Grid */}
                                <div className="flex-1 overflow-y-auto p-6 bg-slate-900/50">
                                    <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                                        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                                            Task List
                                            {folderPager && folderPager.folder === selectedFolder && (
                                                <span className="text-slate-600 normal-case font-medium ml-2">
                                                    ({tasksInFolder.length}
                                                    {folderPager.total > 0 ? ` / ${folderPager.total}` : ''}
                                                    {folderPager.loading ? ' · 로딩…' : ''})
                                                </span>
                                            )}
                                        </h3>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3">
                                        {folderPager && folderPager.folder === selectedFolder && folderPager.loading && renderedTasks.length === 0 ? (
                                            <div className="h-40 flex items-center justify-center text-slate-500 text-sm italic border border-dashed border-slate-800 rounded-xl">
                                                폴더 작업 목록을 불러오는 중…
                                            </div>
                                        ) : renderedTasks.length === 0 ? (
                                            <div className="h-40 flex items-center justify-center text-slate-500 text-sm italic border border-dashed border-slate-800 rounded-xl">
                                                No pending tasks.
                                            </div>
                                        ) : (
                                            renderedTasks.map((task, idx) => (
                                                <div key={`${task.id}-${idx}`} className="group bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between hover:border-slate-600 transition-all shadow-sm">
                                                    <div className="flex items-center gap-4">
                                                        <div>
                                                            <h3 className="text-slate-200 font-bold text-sm group-hover:text-sky-400 transition-colors">{task.name}</h3>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-bold border
                                                            ${task.status === TaskStatus.TODO ? 'bg-slate-800 text-slate-400 border-slate-700' : ''}
                                                            ${task.status === TaskStatus.IN_PROGRESS ? 'bg-sky-900/30 text-sky-300 border border-sky-800/50' : ''}
                                                            ${task.status === TaskStatus.SUBMITTED ? 'bg-amber-900/30 text-amber-300 border border-amber-800/50' : ''}
                                                            ${task.status === TaskStatus.APPROVED ? 'bg-lime-900/30 text-lime-300 border border-lime-800/50' : ''}
                                                            ${task.status === TaskStatus.REJECTED ? 'bg-rose-900/30 text-rose-300 border border-rose-800/50' : ''}
                                                            ${task.status === TaskStatus.ISSUE_PENDING ? 'bg-purple-900/30 text-purple-300 border border-purple-800/50' : ''}
                                                        `}>
                                                                    {TaskStatusLabels[task.status] || task.status}
                                                                </span>
                                                                <span className="text-xs text-slate-600">Updated {new Date(task.lastUpdated).toLocaleDateString()}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <button
                                                        onClick={() => onSelectTask(task.id)}
                                                        className="opacity-0 group-hover:opacity-100 px-5 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold transition-all shadow-md transform translate-x-2 group-hover:translate-x-0"
                                                    >
                                                        {role === UserRole.WORKER
                                                            ? (task.status === TaskStatus.REJECTED ? 'Fix' : 'Start')
                                                            : 'Review'}
                                                    </button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                    {folderPager && folderPager.folder === selectedFolder && folderPager.items.length < folderPager.total && !folderPager.loading && (
                                        <button
                                            type="button"
                                            onClick={() => void handleLoadMoreFolderTasks()}
                                            disabled={folderPager.loadingMore}
                                            className="mt-4 w-full py-2.5 rounded-lg text-sm font-bold border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                                        >
                                            {folderPager.loadingMore ? '불러오는 중…' : `더 보기 (${folderPager.items.length} / ${folderPager.total})`}
                                        </button>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
                                <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mb-4 text-slate-600">
                                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                                </div>
                                <p>Select a folder to view details.</p>
                            </div>
                        )
                    )}
                </div>
                {accountType === AccountType.ADMIN && (
                    <div className="w-[400px] flex-shrink-0 flex flex-col bg-slate-900 border border-slate-800 rounded-xl shadow-md overflow-hidden">
                        <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                            <h3 className="font-bold text-red-400 text-sm uppercase tracking-wide">Notice</h3>
                            {accountType === AccountType.ADMIN && (
                                <button
                                    onClick={() => setIsEditingNotice(!isEditingNotice)}
                                    className="text-xs text-sky-400 hover:text-sky-300"
                                >
                                    {isEditingNotice ? 'Cancel' : 'Edit'}
                                </button>
                            )}
                        </div>
                        <div className="flex-1 p-4 overflow-y-auto custom-quill-container">
                            {isEditingNotice ? (
                                <NoticeEditor
                                    initialContent={noticeContent}
                                    onSave={handleSaveNotice}
                                    onCancel={() => setIsEditingNotice(false)}
                                />
                            ) : (
                                <div
                                    className="text-sm text-slate-300 leading-relaxed prose prose-invert prose-sm max-w-none"
                                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(noticeContent || '<span class="text-slate-500 italic">No notices posted.</span>') }}
                                />
                            )}
                        </div>
                    </div>
                )}
            </div>

        </div>
    );
};

/** 디스크 스캔·동기화 후 App 등에서 호출 — 열린 프로젝트 상세가 옛 통계를 쓰지 않도록 */
export function invalidateProjectDetailCache() {
    projectDetailCache.clear();
}

export default Dashboard;

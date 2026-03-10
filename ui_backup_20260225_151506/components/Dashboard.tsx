import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Task, TaskStatus, TaskStatusLabels, UserRole, FolderMetadata, AccountType, TaskIssue, TaskIssueStatus, VacationRecord } from '../types';
import * as Storage from '../services/storage';
import { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Tooltip, Legend, Bar, Line } from 'recharts';
import { toBlob } from 'html-to-image';

interface DashboardProps {
    role: UserRole;
    accountType: AccountType;
    onSelectTask: (taskId: string) => void;
    onRefresh: () => void;
    onSync: () => Promise<void>;
    tasks: Task[];
    username: string;
    token?: string;
    openIssueRequestsSignal?: number;
    openUserManagementSignal?: number;
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
const VLM_MIGRATION_VIEW = 'VLM_MIGRATION';
const PROJECT_DETAIL_VIEW_PREFIX = 'PROJECT_DETAIL:';
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
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 mb-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-200 mb-3">{title}</h3>
            <div className="w-full h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 8, right: 20, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="userId" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                        <YAxis yAxisId="left" stroke="#34d399" tick={{ fontSize: 11 }} allowDecimals={false} />
                        <YAxis yAxisId="right" orientation="right" stroke="#38bdf8" tick={{ fontSize: 11 }} />
                        <Tooltip
                            contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                            formatter={(value: any, name: string) => {
                                if (name === 'submitted') return [`${value}`, 'Submissions'];
                                return [`${value}h`, 'Work Time'];
                            }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar yAxisId="left" dataKey="submitted" name="submitted" fill="#10b981" radius={[4, 4, 0, 0]} />
                        <Line yAxisId="right" type="monotone" dataKey="workTimeHours" name="workTime" stroke="#0ea5e9" strokeWidth={2.5} dot={{ r: 3 }} />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

type ReportMode = 'DAILY' | 'WEEKLY' | 'MONTHLY';

type ProcessedReportRow = {
    userId: string;
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

const UnifiedReportPanel: React.FC<{ mode: ReportMode; tasks: Task[]; validWorkers: string[] }> = ({ mode, tasks, validWorkers }) => {
    const now = new Date();
    const [selectedDay, setSelectedDay] = useState(() => toDateInputValue(now));
    const [selectedWeekAnchor, setSelectedWeekAnchor] = useState(() => toDateInputValue(now));
    const [selectedMonth, setSelectedMonth] = useState(() => toMonthInputValue(now));
    const [reportData, setReportData] = useState<any[]>([]);
    const [vacations, setVacations] = useState<VacationRecord[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const reportCaptureRef = useRef<HTMLDivElement | null>(null);
    const reportFetchSeqRef = useRef(0);

    const weekRange = useMemo(() => getWeekRange(new Date(selectedWeekAnchor)), [selectedWeekAnchor]);

    const titleText = mode === 'DAILY' ? 'Daily Report (일일 리포트)' : mode === 'WEEKLY' ? 'Weekly Report (주간 리포트)' : 'Monthly Report (월간 리포트)';
    const subtitleText = mode === 'DAILY' ? 'Specific day performance metrics' : mode === 'WEEKLY' ? 'Weekly performance metrics' : 'Monthly performance metrics';
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
            try {
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
            } finally {
                if (requestSeq === reportFetchSeqRef.current) {
                    setIsLoading(false);
                }
            }
        };
        fetchData();
    }, [mode, selectedDay, selectedMonth, weekRange.startTs, weekRange.startDate]);

    const fetchVacations = async () => {
        const rows = await Storage.getVacations(periodRange.startDate, periodRange.endDate);
        setVacations(rows);
    };

    useEffect(() => {
        fetchVacations();
    }, [periodRange.endDate, periodRange.startDate]);

    const processedData = useMemo(() => {
        const stats = new Map<string, ProcessedReportRow>();
        const workerKeys = new Set<string>();

        tasks.forEach(task => {
            if (!task.assignedWorker) return;
            const name = sanitizeWorkerName(task.assignedWorker, validWorkers);
            if (name.toLowerCase() !== 'admin') workerKeys.add(name);
        });

        workerKeys.forEach(worker => {
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
        });

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
            .sort((a, b) => b.totalTimeSeconds - a.totalTimeSeconds);
    }, [mode, periodRange.endDate, periodRange.startDate, periodRange.totalDays, reportData, selectedDay, selectedMonth, tasks, vacations, validWorkers, weekRange.endTs]);

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

    const chartTitle = mode === 'DAILY'
        ? '일간 작업자별 Submissions / Work Time'
        : mode === 'WEEKLY'
            ? '주간 작업자별 Submissions / Work Time'
            : '월간 작업자별 Submissions / Work Time';

    const handleExportCSV = () => {
        const header = ['Worker ID', 'Work Duration (s)', 'Formatted Duration', 'Submissions', 'Vacation Days', 'Working Days', 'Submissions / Working Day', 'Last Activity', 'Manual Boxes', 'Folders Worked'];
        const rows = processedData.map(row => [
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
        <div className="flex flex-col h-full bg-slate-900" ref={reportCaptureRef}>
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">{titleText}</h2>
                    <p className="text-slate-400 text-sm mt-1">{subtitleText}</p>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex items-center bg-slate-950 rounded-lg p-1 border border-slate-700">
                        {mode === 'DAILY' && (
                            <>
                                <button
                                    onClick={() => setSelectedDay(shiftDateInputValue(selectedDay, -1))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
                                    title="Previous Day"
                                >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <input
                                    type="date"
                                    value={selectedDay}
                                    onChange={(e) => setSelectedDay(e.target.value)}
                                    className="bg-transparent border-none text-white px-2 py-1 focus:outline-none transition-all font-mono text-sm cursor-pointer"
                                />
                                <div className="w-px h-4 bg-slate-700 mx-1"></div>
                                <button
                                    onClick={() => setSelectedDay(toDateInputValue(new Date()))}
                                    className="p-1 px-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors text-xs font-bold"
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
                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg flex items-center gap-2 transition-colors text-sm font-bold shadow-lg disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-700"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        CSV Export
                    </button>
                    <button
                        onClick={handleExportJpg}
                        disabled={isLoading}
                        className="px-4 py-2 bg-fuchsia-700 hover:bg-fuchsia-600 text-white rounded-lg flex items-center gap-2 transition-colors text-sm font-bold shadow-lg no-export disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-fuchsia-700"
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

                <div className="grid grid-cols-1 md:grid-cols-6 gap-4 mb-6">
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 shadow-lg shadow-black/20">
                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Total Workers</div>
                        <div className="text-2xl font-bold text-white">{totals.workers}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 shadow-lg shadow-black/20">
                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Total Work Time</div>
                        <div className="text-2xl font-bold text-sky-400">{formatDuration(totals.totalTimeSeconds)}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 shadow-lg shadow-black/20">
                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Total Submissions</div>
                        <div className="text-2xl font-bold text-emerald-400">{totals.submissions}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 shadow-lg shadow-black/20">
                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Total Manual Boxes</div>
                        <div className="text-2xl font-bold text-orange-400">{totals.manualBoxes}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 shadow-lg shadow-black/20">
                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Total Vacation Days</div>
                        <div className="text-2xl font-bold text-violet-300">{totals.vacationDays}</div>
                    </div>
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 shadow-lg shadow-black/20">
                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Avg Submissions / Workday</div>
                        <div className="text-2xl font-bold text-cyan-300">{totals.avgSubmissionsPerWorkingDay}</div>
                    </div>
                </div>

                <WorkerPerformanceComboChart
                    data={(() => {
                        const oneDayRows = processedData.filter(row => Number(row.workingDays || 0) === 1);
                        const sourceRows = oneDayRows.length > 0 ? oneDayRows : processedData;
                        return sourceRows.map(row => ({
                            userId: row.userId,
                            submitted: row.submitted,
                            totalTimeSeconds: row.totalTimeSeconds
                        }));
                    })()}
                    title={chartTitle}
                />

                <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden shadow-2xl backdrop-blur-sm">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-900/80 text-slate-400 text-xs font-bold uppercase tracking-wider">
                                <th className="px-5 py-4 border-b border-slate-700">Worker ID</th>
                                <th className="px-5 py-4 border-b border-slate-700">Work Time</th>
                                <th className="px-5 py-4 border-b border-slate-700">Submissions</th>
                                <th className="px-5 py-4 border-b border-slate-700">Vacation Days</th>
                                <th className="px-5 py-4 border-b border-slate-700">Working Days</th>
                                <th className="px-5 py-4 border-b border-slate-700">Sub / Workday</th>
                                <th className="px-5 py-4 border-b border-slate-700">Last Activity</th>
                                <th className="px-5 py-4 border-b border-slate-700">Manual Boxes</th>
                                <th className="px-5 py-4 border-b border-slate-700">Folders Worked</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/50">
                            {processedData.map((row) => (
                                <tr key={row.userId} className="hover:bg-slate-700/30 transition-colors group">
                                    <td className="px-5 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 border border-slate-600 group-hover:bg-blue-600/20 group-hover:text-blue-400 group-hover:border-blue-500/50 transition-all">
                                                {row.userId?.substring(0, 2)?.toUpperCase() || '?'}
                                            </div>
                                            <span className="font-semibold text-slate-200 group-hover:text-white transition-colors capitalize">{row.userId}</span>
                                        </div>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="text-slate-300 font-mono text-sm">{formatDuration(row.totalTimeSeconds)}</span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded border border-blue-800/50 text-xs font-bold font-mono">
                                            {Number(row.submitted || 0)}
                                        </span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="bg-violet-900/30 text-violet-300 px-2 py-0.5 rounded border border-violet-800/50 text-xs font-bold font-mono">
                                            {Number(row.vacationDays || 0)}
                                        </span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="text-slate-300 font-mono text-sm">{Number(row.workingDays || 0)}</span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="bg-cyan-900/30 text-cyan-300 px-2 py-0.5 rounded border border-cyan-800/50 text-xs font-bold font-mono">
                                            {Number(row.submissionsPerWorkingDay || 0)}
                                        </span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="text-slate-400 font-mono text-xs">
                                            {row.lastTimestamp ? new Date(row.lastTimestamp).toLocaleString() : <span className="italic text-slate-600">No activity</span>}
                                        </span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <span className="bg-amber-900/30 text-amber-400 px-2 py-0.5 rounded border border-amber-800/50 text-xs font-bold font-mono">
                                            {Number(row.totalManualBoxes || 0).toLocaleString()}
                                        </span>
                                    </td>
                                    <td className="px-5 py-4">
                                        <div className="flex flex-wrap gap-1 max-w-[300px]">
                                            {Array.from((row.assignedFolders ?? new Set<string>()) as Set<string>).slice(0, 3).map((folderName: string) => (
                                                <span key={folderName} className="text-[10px] bg-slate-700/50 text-slate-400 px-1.5 py-0.5 rounded border border-slate-600/50">
                                                    {folderName}
                                                </span>
                                            ))}
                                            {((row.assignedFolders ?? new Set<string>()) as Set<string>).size > 3 && (
                                                <span className="text-[10px] text-slate-500 px-1">+ {((row.assignedFolders ?? new Set<string>()) as Set<string>).size - 3} more</span>
                                            )}
                                            {((row.assignedFolders ?? new Set<string>()) as Set<string>).size === 0 && (
                                                <span className="text-[10px] text-slate-600 italic">No folders logged</span>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {!isLoading && processedData.length === 0 && (
                                <tr>
                                    <td colSpan={9} className="px-5 py-12 text-center text-slate-500 italic">
                                        No work logs found for this period.
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
            const res = await fetch('/api/users', {
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
            const res = await fetch('/api/users', {
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
            const res = await fetch('/api/users', {
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
        <div className="flex flex-col h-full bg-slate-900">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-white">사용자 관리 (User Management)</h2>
                    <span className="text-xs bg-orange-900/40 text-orange-300 px-2 py-0.5 rounded border border-orange-800/50">Admin Mode</span>
                </div>
                {!isAdding && (
                    <button
                        onClick={() => setIsAdding(true)}
                        className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-bold transition-all shadow-md"
                    >
                        + 새 사용자 추가
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-y-auto p-6">
                {isAdding && (
                    <div className="mb-6 bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-xl animate-in fade-in slide-in-from-top-4">
                        <h3 className="text-white font-bold mb-4">새 사용자 계정 생성</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Username</label>
                                <input
                                    type="text"
                                    value={newUser.username}
                                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                                    placeholder="아이디"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Password</label>
                                <input
                                    type="password"
                                    value={newUser.password}
                                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                                    placeholder="비밀번호"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Account Type</label>
                                <select
                                    value={newUser.accountType}
                                    onChange={(e) => setNewUser({ ...newUser, accountType: e.target.value })}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                                >
                                    <option value="WORKER">WORKER (작업자)</option>
                                    <option value="REVIEWER">REVIEWER (검수자)</option>
                                    <option value="ADMIN">ADMIN (관리자)</option>
                                </select>
                            </div>
                        </div>
                        {error && <div className="text-red-400 text-xs mb-4">{error}</div>}
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setIsAdding(false)}
                                className="px-4 py-2 text-slate-400 hover:text-slate-200 text-sm font-medium"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleAddUser}
                                className="px-6 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-bold transition-all shadow-md"
                            >
                                사용자 생성
                            </button>
                        </div>
                    </div>
                )}

                <div className="bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden shadow-sm">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="bg-slate-900/50 text-slate-400 text-xs uppercase tracking-wider">
                                <th className="px-6 py-4 font-semibold">Username</th>
                                <th className="px-6 py-4 font-semibold">Account Type</th>
                                <th className="px-6 py-4 font-semibold">Status</th>
                                <th className="px-6 py-4 font-semibold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                            {users.map(user => (
                                <tr key={user.username} className="hover:bg-slate-700/30 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-slate-400">
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                                            </div>
                                            <span className="text-slate-200 font-medium">{user.username}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${user.accountType === 'ADMIN'
                                            ? 'bg-red-900/20 text-red-400 border-red-800/50'
                                            : user.accountType === 'REVIEWER'
                                                ? 'bg-purple-900/20 text-purple-400 border-purple-800/50'
                                                : 'bg-sky-900/20 text-sky-400 border-sky-800/50'
                                            }`}>
                                            {user.accountType}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="flex items-center gap-1.5 text-xs text-lime-400">
                                            <span className="w-1.5 h-1.5 rounded-full bg-lime-500"></span>
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
                                                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 outline-none w-24"
                                                />
                                                <button
                                                    onClick={() => handleUpdatePassword(user.username)}
                                                    className="text-xs text-sky-400 hover:text-sky-300 font-bold"
                                                >
                                                    저장
                                                </button>
                                                <button
                                                    onClick={() => setEditingUser(null)}
                                                    className="text-xs text-slate-500 hover:text-slate-400"
                                                >
                                                    취소
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={() => setEditingUser(user.username)}
                                                className="text-slate-500 hover:text-sky-400 transition-colors"
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

const WeeklyReportView: React.FC<{ tasks: Task[], validWorkers: string[] }> = ({ tasks, validWorkers }) => {
    return <UnifiedReportPanel mode="WEEKLY" tasks={tasks} validWorkers={validWorkers} />;
};

const WorkerReportView: React.FC<{ tasks: Task[], validWorkers: string[] }> = ({ tasks, validWorkers }) => {
    return <UnifiedReportPanel mode="MONTHLY" tasks={tasks} validWorkers={validWorkers} />;
};

const DailyReportView: React.FC<{ tasks: Task[], validWorkers: string[] }> = ({ tasks, validWorkers }) => {
    return <UnifiedReportPanel mode="DAILY" tasks={tasks} validWorkers={validWorkers} />;
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

const UnifiedReportsView: React.FC<{ tasks: Task[], validWorkers: string[], onOpenSchedule?: () => void }> = ({ tasks, validWorkers, onOpenSchedule }) => {
    const [tab, setTab] = useState<ReportTab>('DAILY');

    return (
        <div className="flex flex-col h-full bg-slate-900">
            <div className="px-6 py-3 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">Reports</h2>
                    <span className="text-[11px] text-slate-500">일간 UI 기준 통합 뷰</span>
                </div>
                <div className="flex bg-slate-900 border border-slate-700 rounded-lg p-1">
                    <button
                        onClick={() => setTab('DAILY')}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${tab === 'DAILY' ? 'bg-blue-900/50 text-blue-200 border border-blue-700/50' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                    >
                        Daily
                    </button>
                    <button
                        onClick={() => setTab('WEEKLY')}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${tab === 'WEEKLY' ? 'bg-lime-900/50 text-lime-200 border border-lime-700/50' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                    >
                        Weekly
                    </button>
                    <button
                        onClick={() => setTab('MONTHLY')}
                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${tab === 'MONTHLY' ? 'bg-emerald-900/50 text-emerald-200 border border-emerald-700/50' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                    >
                        Monthly
                    </button>
                </div>
                {onOpenSchedule && (
                    <button
                        onClick={onOpenSchedule}
                        className="ml-3 px-3 py-1.5 rounded-md text-xs font-bold transition-all bg-violet-900/40 text-violet-200 border border-violet-700/50 hover:bg-violet-800/50"
                    >
                        일정관리
                    </button>
                )}
            </div>
            <div className="flex-1 min-h-0">
                {tab === 'DAILY' ? (
                    <DailyReportView tasks={tasks} validWorkers={validWorkers} />
                ) : tab === 'WEEKLY' ? (
                    <WeeklyReportView tasks={tasks} validWorkers={validWorkers} />
                ) : (
                    <WorkerReportView tasks={tasks} validWorkers={validWorkers} />
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
        <div className="flex flex-col h-full bg-slate-900">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">일정관리</h2>
                    <p className="text-slate-400 text-sm mt-1">휴가/공휴일(전체 적용) 관리</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex bg-slate-900 border border-slate-700 rounded-lg p-1">
                        <button
                            onClick={() => setViewMode('MANAGE')}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${viewMode === 'MANAGE' ? 'bg-violet-900/50 text-violet-200 border border-violet-700/50' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                        >
                            관리
                        </button>
                        <button
                            onClick={() => setViewMode('BOARD')}
                            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${viewMode === 'BOARD' ? 'bg-violet-900/50 text-violet-200 border border-violet-700/50' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                        >
                            일정확인
                        </button>
                    </div>
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-violet-500"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
                {viewMode === 'MANAGE' && (
                <>
                <div className="mb-4 bg-slate-800/60 border border-slate-700 rounded-xl p-4">
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                        <select
                            value={form.userId}
                            onChange={(e) => setForm(prev => ({ ...prev, userId: e.target.value }))}
                            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-violet-500"
                        >
                            <option value="__ALL__">전체(공휴일)</option>
                            {validWorkers.map(worker => (
                                <option key={worker} value={worker}>{worker}</option>
                            ))}
                        </select>
                        <input
                            type="date"
                            value={form.startDate}
                            onChange={(e) => setForm(prev => ({ ...prev, startDate: e.target.value }))}
                            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-violet-500"
                        />
                        <input
                            type="date"
                            value={form.endDate}
                            onChange={(e) => setForm(prev => ({ ...prev, endDate: e.target.value }))}
                            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-violet-500"
                        />
                        <div className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-violet-200 font-mono">
                            평일 기준 {computedDays}일
                        </div>
                        <button
                            onClick={handleCreate}
                            className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold"
                        >
                            일정 저장
                        </button>
                    </div>
                    <input
                        type="text"
                        value={form.note}
                        onChange={(e) => setForm(prev => ({ ...prev, note: e.target.value }))}
                        className="mt-3 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-violet-500"
                        placeholder="메모(선택)"
                    />
                </div>

                <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden shadow-2xl backdrop-blur-sm">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-900/80 text-slate-400 text-xs font-bold uppercase tracking-wider">
                                <th className="px-5 py-4 border-b border-slate-700">Target</th>
                                <th className="px-5 py-4 border-b border-slate-700">Start</th>
                                <th className="px-5 py-4 border-b border-slate-700">End</th>
                                <th className="px-5 py-4 border-b border-slate-700">Days(Weekdays)</th>
                                <th className="px-5 py-4 border-b border-slate-700">Note</th>
                                <th className="px-5 py-4 border-b border-slate-700">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/50">
                            {vacations.map((item) => (
                                <tr key={item.id} className="hover:bg-slate-700/30 transition-colors">
                                    <td className="px-5 py-4 text-slate-200 font-medium">{item.userId === '__ALL__' ? 'ALL (Holiday)' : item.userId}</td>
                                    <td className="px-5 py-4 text-slate-300 font-mono text-sm">{item.startDate}</td>
                                    <td className="px-5 py-4 text-slate-300 font-mono text-sm">{item.endDate}</td>
                                    <td className="px-5 py-4 text-violet-300 font-mono text-sm">{item.days}</td>
                                    <td className="px-5 py-4 text-slate-400 text-sm">{item.note || '-'}</td>
                                    <td className="px-5 py-4">
                                        <button
                                            onClick={() => handleDelete(item.id)}
                                            className="px-2 py-1 rounded bg-rose-900/40 text-rose-300 border border-rose-700/50 hover:bg-rose-800/50 text-xs font-bold"
                                        >
                                            삭제
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {vacations.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-5 py-12 text-center text-slate-500 italic">
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
                    <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden shadow-2xl backdrop-blur-sm">
                        <div className="overflow-auto">
                            <table className="w-full text-left border-collapse min-w-[1200px]">
                                <thead>
                                    <tr className="bg-slate-900/80 text-slate-400 text-xs font-bold uppercase tracking-wider">
                                        <th className="px-4 py-3 border-b border-slate-700 sticky left-0 bg-slate-900/95 z-20 min-w-[140px]">작업자</th>
                                        {monthWeekdays.map((day) => (
                                            <th key={day.date} className="px-3 py-3 border-b border-slate-700 text-center min-w-[64px]">{day.day}일</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-700/50">
                                    {validWorkers.map((worker) => (
                                        <tr key={worker} className="hover:bg-slate-700/20 transition-colors">
                                            <td className="px-4 py-3 text-slate-200 font-semibold sticky left-0 bg-slate-900/95 z-10">{worker}</td>
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

const IssueRequestView: React.FC<{ currentAdmin: string }> = ({ currentAdmin }) => {
    const [issues, setIssues] = useState<TaskIssue[]>([]);
    const [selectedStatus, setSelectedStatus] = useState<TaskIssueStatus | 'ALL'>('OPEN');
    const [isLoading, setIsLoading] = useState(false);

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
        try {
            await Storage.updateTaskIssueStatus(issue.id, status, currentAdmin, note);
            await fetchIssues();
        } catch {
            alert('요청 처리에 실패했습니다.');
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
                                <th className="px-4 py-3">Reason</th>
                                <th className="px-4 py-3">Task</th>
                                <th className="px-4 py-3">Created By</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/60">
                            {issues.map(issue => (
                                <tr key={issue.id} className="hover:bg-slate-700/20">
                                    <td className="px-4 py-3 text-slate-200 font-semibold">{issue.type}</td>
                                    <td className="px-4 py-3 text-slate-300">{ISSUE_REASON_LABELS[issue.reasonCode] || issue.reasonCode}</td>
                                    <td className="px-4 py-3 text-slate-300 truncate max-w-[240px]" title={issue.imageUrl}>{issue.folder}</td>
                                    <td className="px-4 py-3 text-slate-300">{issue.createdBy}</td>
                                    <td className="px-4 py-3 text-slate-200">{ISSUE_STATUS_LABELS[issue.status] || issue.status}</td>
                                    <td className="px-4 py-3">
                                        {issue.status === 'OPEN' || issue.status === 'IN_REVIEW' ? (
                                            <div className="flex gap-1">
                                                <button onClick={() => resolveIssue(issue, 'DELETE')} className="px-2 py-1 text-[11px] bg-red-700/30 border border-red-700 text-red-300 rounded">Delete</button>
                                                <button onClick={() => resolveIssue(issue, 'RESOLVED')} className="px-2 py-1 text-[11px] bg-slate-700 border border-slate-600 text-slate-200 rounded">Resolve</button>
                                            </div>
                                        ) : (
                                            <span className="text-xs text-slate-500">-</span>
                                        )}
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
                    {isLoading && <div className="px-4 py-6 text-center text-slate-500 text-sm">불러오는 중...</div>}
                </div>
            </div>
        </div>
    );
};

const ProjectOverviewView: React.FC<{ onSync: () => Promise<void>; isSyncing: boolean; onOpenProject: (projectId: string) => void }> = ({ onSync, isSyncing, onOpenProject }) => {
    const [loading, setLoading] = useState<boolean>(true);
    const [savingProject, setSavingProject] = useState<boolean>(false);
    const [mappingFolder, setMappingFolder] = useState<string>('');
    const [projectName, setProjectName] = useState<string>('');
    const [projectTarget, setProjectTarget] = useState<string>('');
    const [projectWorkflowSourceType, setProjectWorkflowSourceType] = useState<'native-yolo' | 'vlm-review'>('native-yolo');
    const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'MAPPING' | 'ARCHIVE'>('OVERVIEW');
    const [searchKeyword, setSearchKeyword] = useState<string>('');
    const [unassignedOnly, setUnassignedOnly] = useState<boolean>(true);
    const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set());
    const [bulkTargetProject, setBulkTargetProject] = useState<string>('');
    const [editingProjectId, setEditingProjectId] = useState<string>('');
    const [editingWorkflowSourceType, setEditingWorkflowSourceType] = useState<'native-yolo' | 'vlm-review'>('native-yolo');
    const [restoringProjectId, setRestoringProjectId] = useState<string>('');
    const [overview, setOverview] = useState<Storage.ProjectOverviewPayload>({
        projects: [],
        projectMap: {},
        unassigned: { folderCount: 0, allocated: 0, completed: 0 },
        folders: []
    });

    const refreshOverview = async () => {
        setLoading(true);
        try {
            const data = await Storage.getProjectOverview();
            setOverview(data);
            setSelectedForBulk(new Set());
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refreshOverview();
    }, []);

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
            setEditingWorkflowSourceType('native-yolo');
            return;
        }
        const selected = activeProjects.find((p) => p.id === editingProjectId) || activeProjects[0];
        setEditingProjectId(selected.id);
        setEditingWorkflowSourceType(selected.workflowSourceType === 'vlm-review' ? 'vlm-review' : 'native-yolo');
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
    const filteredFolders = useMemo(() => {
        return overview.folders.filter((row) => {
            if (unassignedOnly && row.projectId) return false;
            if (!keyword) return true;
            return row.folder.toLowerCase().includes(keyword) || String(row.assignedWorker || '').toLowerCase().includes(keyword);
        });
    }, [keyword, overview.folders, unassignedOnly]);

    const foldersByProject = useMemo(() => {
        const map: Record<string, typeof overview.folders> = {};
        map.__UNASSIGNED__ = [];
        overview.projects.forEach((project) => {
            map[project.id] = [];
        });
        filteredFolders.forEach((folderRow) => {
            const key = folderRow.projectId || '__UNASSIGNED__';
            if (!map[key]) map[key] = [];
            map[key].push(folderRow);
        });
        return map;
    }, [filteredFolders, overview.projects]);

    const getWorkflowMismatchMessage = (row: Storage.ProjectOverviewPayload['folders'][number], projectId: string): string => {
        if (!projectId) return '';
        const project = overview.projects.find((p) => p.id === projectId);
        if (!project) return '';
        const nativeCount = Number(row.nativeTaskCount || 0);
        const vlmCount = Number(row.vlmTaskCount || 0);
        if (project.workflowSourceType === 'native-yolo' && vlmCount > 0) {
            return `YOLO 프로젝트인데 VLM 작업 ${vlmCount}건이 포함되어 있습니다.`;
        }
        if (project.workflowSourceType === 'vlm-review' && nativeCount > 0) {
            return `VLM 프로젝트인데 YOLO 작업 ${nativeCount}건이 포함되어 있습니다.`;
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
        const targetTotal = Math.max(0, Number(projectTarget || 0));
        setSavingProject(true);
        try {
            await Storage.saveProject({ name, targetTotal, workflowSourceType: projectWorkflowSourceType });
            setProjectName('');
            setProjectTarget('');
            setProjectWorkflowSourceType('native-yolo');
            await refreshOverview();
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
                name: target.name,
                targetTotal: Number(target.targetTotal || 0),
                workflowSourceType: editingWorkflowSourceType
            });
            await refreshOverview();
        } catch (_e) {
            alert('프로젝트 작업 방식 변경에 실패했습니다.');
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
            await refreshOverview();
            alert('프로젝트가 복원되었습니다.');
        } catch (_e) {
            alert('프로젝트 복원에 실패했습니다.');
        } finally {
            setRestoringProjectId('');
        }
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
            await refreshOverview();
        } catch (e) {
            alert('프로젝트 매핑 저장에 실패했습니다.');
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
            await refreshOverview();
            setSelectedForBulk(new Set());
        } catch (e) {
            alert('일괄 매핑에 실패했습니다.');
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
                        <div className="text-xs text-slate-300 mt-1">작업자: <span className="font-medium text-slate-100">{row.assignedWorker || 'Unassigned'}</span></div>
                        <div className="text-[11px] text-slate-400">YOLO {Number(row.nativeTaskCount || 0)} / VLM {Number(row.vlmTaskCount || 0)}</div>
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
                            onClick={() => setActiveTab('MAPPING')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'MAPPING' ? 'bg-cyan-900/40 text-cyan-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            매핑
                        </button>
                        <button
                            onClick={() => setActiveTab('ARCHIVE')}
                            className={`px-3 py-1.5 text-xs font-bold rounded ${activeTab === 'ARCHIVE' ? 'bg-amber-900/40 text-amber-200' : 'text-slate-400 hover:text-slate-200'}`}
                        >
                            아카이브
                        </button>
                    </div>
                    <button
                        onClick={refreshOverview}
                        disabled={loading}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                    >
                        새로고침
                    </button>
                    <button
                        onClick={onSync}
                        disabled={isSyncing}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50"
                    >
                        {isSyncing ? 'Syncing...' : 'Sync Data'}
                    </button>
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
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">프로젝트 수</div>
                                <div className="text-2xl font-bold text-white">{totals.projectCount}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">전체 목표량</div>
                                <div className="text-2xl font-bold text-cyan-300">{totals.totalTarget.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">배분량</div>
                                <div className="text-2xl font-bold text-sky-300">{totals.totalAllocated.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">완료량</div>
                                <div className="text-2xl font-bold text-lime-300">{totals.totalCompleted.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">전체 진행률</div>
                                <div className="text-2xl font-bold text-white">{totals.progress}%</div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                            <div className="xl:col-span-2 bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                                <h3 className="text-sm font-bold text-slate-200 mb-3">프로젝트 카드</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {activeProjects.map((project) => (
                                        <button
                                            key={project.id}
                                            onClick={() => onOpenProject(project.id)}
                                            className={`text-left rounded-xl p-3 transition-all border ${project.status === 'ARCHIVED'
                                                ? 'bg-gradient-to-br from-amber-900/20 via-slate-900/70 to-amber-900/10 border-amber-700/40 hover:border-amber-500/70'
                                                : 'bg-gradient-to-br from-cyan-900/35 via-slate-900/70 to-blue-900/25 border-cyan-700/40 hover:border-cyan-400/70 hover:shadow-lg hover:shadow-cyan-900/25'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="text-base font-extrabold text-cyan-100 tracking-tight">{project.name}</div>
                                                <div className="flex items-center gap-1.5">
                                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${project.workflowSourceType === 'vlm-review' ? 'bg-violet-900/30 text-violet-200 border-violet-700/50' : 'bg-sky-900/30 text-sky-200 border-sky-700/50'}`}>
                                                        {project.workflowSourceType === 'vlm-review' ? 'VLM' : 'YOLO'}
                                                    </span>
                                                    {project.status === 'ARCHIVED' && (
                                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-amber-900/30 text-amber-200 border-amber-700/50">
                                                            Archived
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="mt-2 text-sm text-slate-200 space-y-1 leading-relaxed">
                                                <div className="font-medium">목표량: <span className="text-white font-semibold">{Number(project.targetTotal || 0).toLocaleString()}</span></div>
                                                <div className="font-medium">배분량: <span className="text-white font-semibold">{Number(project.allocated || 0).toLocaleString()}</span></div>
                                                <div className="font-medium">완료량: <span className="text-white font-semibold">{Number(project.completed || 0).toLocaleString()}</span></div>
                                            </div>
                                            <div className="mt-2">
                                                <div className="h-2 bg-slate-700/80 rounded-full overflow-hidden">
                                                    <div className="h-full bg-gradient-to-r from-sky-500 to-cyan-300" style={{ width: `${Math.min(100, Number(project.progress || 0))}%` }} />
                                                </div>
                                                <div className="text-right text-xs font-semibold text-slate-200 mt-1">{Number(project.progress || 0)}%</div>
                                            </div>
                                        </button>
                                    ))}
                                    <div className="rounded-xl p-3 border border-dashed border-violet-700/40 bg-gradient-to-br from-violet-900/20 via-slate-900/70 to-fuchsia-900/15">
                                        <div className="text-base font-extrabold text-violet-100 tracking-tight">미분류</div>
                                        <div className="mt-2 text-sm text-slate-200 space-y-1 leading-relaxed">
                                            <div className="font-medium">폴더 수: <span className="text-white font-semibold">{overview.unassigned.folderCount}</span></div>
                                            <div className="font-medium">배분량: <span className="text-white font-semibold">{Number(overview.unassigned.allocated || 0).toLocaleString()}</span></div>
                                            <div className="font-medium">완료량: <span className="text-white font-semibold">{Number(overview.unassigned.completed || 0).toLocaleString()}</span></div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                                <h3 className="text-sm font-bold text-slate-200 mb-3">프로젝트 생성</h3>
                                <label className="text-xs text-slate-500 block mb-1">프로젝트명</label>
                                <input
                                    value={projectName}
                                    onChange={(e) => setProjectName(e.target.value)}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 mb-3 outline-none focus:border-sky-500"
                                    placeholder="예: YOLO-Phase-1"
                                />
                                <label className="text-xs text-slate-500 block mb-1">목표량</label>
                                <input
                                    type="number"
                                    min={0}
                                    value={projectTarget}
                                    onChange={(e) => setProjectTarget(e.target.value)}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 mb-3 outline-none focus:border-sky-500"
                                    placeholder="예: 50000"
                                />
                                <label className="text-xs text-slate-500 block mb-1">작업 방식</label>
                                <select
                                    value={projectWorkflowSourceType}
                                    onChange={(e) => setProjectWorkflowSourceType(e.target.value === 'vlm-review' ? 'vlm-review' : 'native-yolo')}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 mb-3 outline-none focus:border-sky-500"
                                >
                                    <option value="native-yolo">YOLO</option>
                                    <option value="vlm-review">VLM</option>
                                </select>
                                <button
                                    onClick={handleSaveProject}
                                    disabled={savingProject}
                                    className="w-full bg-sky-600 hover:bg-sky-500 text-white rounded-lg py-2 text-sm font-bold disabled:opacity-50"
                                >
                                    {savingProject ? '저장 중...' : '저장'}
                                </button>

                                <div className="my-4 border-t border-slate-700/70" />
                                <h4 className="text-xs font-bold text-slate-300 mb-2">프로젝트 작업 방식 변경</h4>
                                <label className="text-xs text-slate-500 block mb-1">대상 프로젝트</label>
                                <select
                                    value={editingProjectId}
                                    onChange={(e) => {
                                        const nextId = e.target.value;
                                        setEditingProjectId(nextId);
                                        const target = overview.projects.find((p) => p.id === nextId);
                                        if (target) {
                                            setEditingWorkflowSourceType(target.workflowSourceType === 'vlm-review' ? 'vlm-review' : 'native-yolo');
                                        }
                                    }}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 mb-3 outline-none focus:border-sky-500"
                                >
                                    {activeProjects.map((project) => (
                                        <option key={project.id} value={project.id}>
                                            {project.name}
                                        </option>
                                    ))}
                                </select>
                                <label className="text-xs text-slate-500 block mb-1">변경할 작업 방식</label>
                                <select
                                    value={editingWorkflowSourceType}
                                    onChange={(e) => setEditingWorkflowSourceType(e.target.value === 'vlm-review' ? 'vlm-review' : 'native-yolo')}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 mb-3 outline-none focus:border-sky-500"
                                >
                                    <option value="native-yolo">YOLO</option>
                                    <option value="vlm-review">VLM</option>
                                </select>
                                <button
                                    onClick={handleUpdateProjectWorkflow}
                                    disabled={savingProject || !editingProjectId}
                                    className="w-full bg-violet-600 hover:bg-violet-500 text-white rounded-lg py-2 text-sm font-bold disabled:opacity-50"
                                >
                                    {savingProject ? '변경 중...' : '작업 방식 변경'}
                                </button>
                            </div>
                        </div>
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
                                        checked={unassignedOnly}
                                        onChange={(e) => setUnassignedOnly(e.target.checked)}
                                        className="rounded border-slate-600 bg-slate-900 text-sky-500"
                                    />
                                    미분류 우선 보기
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
                                        onClick={() => handleToggleColumnBulk(foldersByProject.__UNASSIGNED__ || [])}
                                        className="text-[10px] px-2 py-1 rounded border border-amber-700/40 text-amber-200 hover:bg-amber-900/20"
                                    >
                                        {(foldersByProject.__UNASSIGNED__ || []).length > 0 && (foldersByProject.__UNASSIGNED__ || []).every((row) => selectedForBulk.has(row.folder)) ? '해제' : '전체 선택'}
                                    </button>
                                </div>
                                <div className="space-y-2 max-h-[60vh] overflow-auto pr-1">
                                    {(foldersByProject.__UNASSIGNED__ || []).map(renderFolderCard)}
                                </div>
                            </div>

                            {activeProjects.map((project) => (
                                <div key={project.id} className="bg-slate-800/20 border border-slate-700 rounded-xl p-3">
                                    <div className="flex items-center justify-between mb-2 gap-2">
                                        <div className="text-xs font-bold text-cyan-300">{project.name} ({foldersByProject[project.id]?.length || 0})</div>
                                        <button
                                            onClick={() => handleToggleColumnBulk(foldersByProject[project.id] || [])}
                                            className="text-[10px] px-2 py-1 rounded border border-cyan-700/40 text-cyan-200 hover:bg-cyan-900/20"
                                        >
                                            {(foldersByProject[project.id] || []).length > 0 && (foldersByProject[project.id] || []).every((row) => selectedForBulk.has(row.folder)) ? '해제' : '전체 선택'}
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
                                        onClick={handleBulkMove}
                                        disabled={mappingFolder === '__BULK__'}
                                        className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-50"
                                    >
                                        {mappingFolder === '__BULK__' ? '이동 중...' : '선택 항목 이동'}
                                    </button>
                                    <button
                                        onClick={() => setSelectedForBulk(new Set())}
                                        className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-bold"
                                    >
                                        선택 해제
                                    </button>
                                </div>
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

    const totals = useMemo(() => {
        const totalTarget = overview.projects.reduce((acc, row) => acc + Number(row.targetTotal || 0), 0);
        const totalAllocated = overview.projects.reduce((acc, row) => acc + Number(row.allocated || 0), 0) + Number(overview.unassigned.allocated || 0);
        const totalCompleted = overview.projects.reduce((acc, row) => acc + Number(row.completed || 0), 0) + Number(overview.unassigned.completed || 0);
        const progress = totalTarget > 0 ? Number(((totalCompleted / totalTarget) * 100).toFixed(2)) : 0;
        return { totalTarget, totalAllocated, totalCompleted, progress };
    }, [overview]);

    return (
        <div className="h-full overflow-auto p-6 space-y-6">
            {loading && (
                <div className="text-sm text-sky-300 bg-sky-900/20 border border-sky-700/40 rounded-lg px-4 py-3">
                    프로젝트 대시보드 로딩 중...
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">총 목표량</div>
                    <div className="text-2xl font-bold text-cyan-300">{Number(totals.totalTarget || 0).toLocaleString()}</div>
                </div>
                <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">총 배분량</div>
                    <div className="text-2xl font-bold text-sky-300">{Number(totals.totalAllocated || 0).toLocaleString()}</div>
                </div>
                <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">총 완료량</div>
                    <div className="text-2xl font-bold text-lime-300">{Number(totals.totalCompleted || 0).toLocaleString()}</div>
                </div>
                <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                    <div className="text-xs text-slate-400 mb-1">전체 진행률</div>
                    <div className="text-2xl font-bold text-white">{Number(totals.progress || 0)}%</div>
                </div>
            </div>

            <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                <h3 className="text-sm font-bold text-slate-200 mb-3">프로젝트 카드</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {overview.projects.map((project) => (
                        <div key={project.id} className={`rounded-xl border p-4 ${project.status === 'ARCHIVED' ? 'border-amber-700/40 bg-amber-900/10' : 'border-slate-700 bg-slate-900/60'}`}>
                            <div className="flex items-center justify-between gap-2">
                                <div className="text-base font-extrabold text-cyan-100 tracking-tight">{project.name}</div>
                                <div className="flex items-center gap-1.5">
                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${project.workflowSourceType === 'vlm-review' ? 'bg-violet-900/30 text-violet-200 border-violet-700/50' : 'bg-sky-900/30 text-sky-200 border-sky-700/50'}`}>
                                        {project.workflowSourceType === 'vlm-review' ? 'VLM' : 'YOLO'}
                                    </span>
                                    {project.status === 'ARCHIVED' && (
                                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-amber-900/30 text-amber-200 border-amber-700/50">
                                            Archived
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="text-xs text-slate-300 mt-2">목표량 <span className="text-white font-semibold">{Number(project.targetTotal || 0).toLocaleString()}</span></div>
                            <div className="text-xs text-slate-300">배분량 <span className="text-white font-semibold">{Number(project.allocated || 0).toLocaleString()}</span></div>
                            <div className="text-xs text-slate-300">완료량 <span className="text-white font-semibold">{Number(project.completed || 0).toLocaleString()}</span></div>
                            <div className="mt-2 text-xs text-slate-300">진행률 <span className="text-white font-semibold">{Number(project.progress || 0)}%</span></div>
                            <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden mt-2">
                                <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, Number(project.progress || 0))}%` }} />
                            </div>
                        </div>
                    ))}
                    {overview.projects.length === 0 && (
                        <div className="col-span-full text-sm text-slate-500 italic">프로젝트 데이터가 없습니다.</div>
                    )}
                </div>
            </div>
        </div>
    );
};

const VlmMigrationView: React.FC<{ onRefreshTasks: () => void; workers: string[] }> = ({ onRefreshTasks, workers }) => {
    const [loadingDryRun, setLoadingDryRun] = useState<boolean>(false);
    const [loadingCommit, setLoadingCommit] = useState<boolean>(false);
    const [dryRun, setDryRun] = useState<Storage.VlmMigrationDryRunResult | null>(null);
    const [lastCommitResult, setLastCommitResult] = useState<any>(null);
    const [importFiles, setImportFiles] = useState<Storage.VlmImportJsonFileInfo[]>([]);
    const [loadingImportFiles, setLoadingImportFiles] = useState<boolean>(false);
    const [selectedImportFiles, setSelectedImportFiles] = useState<Set<string>>(new Set());
    const [selectedAssignees, setSelectedAssignees] = useState<Set<string>>(new Set());
    const [assignCountInput, setAssignCountInput] = useState<string>('0');
    const [keepUnassigned, setKeepUnassigned] = useState<boolean>(true);
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
    }>({
        inProgress: false,
        done: 0,
        total: 0,
        percent: 0,
        currentFile: ''
    });

    const importPlanSummary = useMemo(() => {
        const selectedFiles = importFiles.filter((file) => selectedImportFiles.has(file.fileName));
        const total = selectedFiles.reduce((acc, file) => acc + Math.max(0, Number(file.totalRows || 0)), 0);
        const assignCount = Math.max(0, Number(assignCountInput || 0));
        const hasAssignees = selectedAssignees.size > 0;
        let assigned = 0;
        let unassigned = total;
        if (hasAssignees) {
            if (keepUnassigned) {
                assigned = Math.min(total, assignCount);
                unassigned = total - assigned;
            } else {
                assigned = total;
                unassigned = 0;
            }
        }
        return {
            total,
            assigned,
            unassigned,
            parseErrorCount: selectedFiles.filter((file) => Boolean(file.parseError)).length
        };
    }, [importFiles, selectedImportFiles, assignCountInput, selectedAssignees, keepUnassigned]);

    const refreshImportFiles = async () => {
        setLoadingImportFiles(true);
        try {
            const files = await Storage.listVlmImportJsonFiles();
            setImportFiles(files);
            setSelectedImportFiles((prev) => {
                const next = new Set<string>();
                files.forEach((file) => {
                    if (prev.has(file.fileName)) next.add(file.fileName);
                });
                return next;
            });
        } finally {
            setLoadingImportFiles(false);
        }
    };

    useEffect(() => {
        refreshImportFiles();
    }, []);

    const refreshExportFiles = async () => {
        setLoadingExportFiles(true);
        try {
            const files = await Storage.listVlmExportJsonFiles();
            setExportFiles(files);
            setSelectedExportFiles((prev) => {
                const next = new Set<string>();
                files.forEach((file) => {
                    if (prev.has(file.sourceFile)) next.add(file.sourceFile);
                });
                return next;
            });
        } finally {
            setLoadingExportFiles(false);
        }
    };

    useEffect(() => {
        refreshExportFiles();
    }, []);

    const handleDryRun = async () => {
        setLoadingDryRun(true);
        try {
            const result = await Storage.getVlmMigrationDryRun(100, 0);
            setDryRun(result);
        } finally {
            setLoadingDryRun(false);
        }
    };

    const handleCommit = async () => {
        const ok = window.confirm('VLM 데이터를 1회 이관할까요? 이미 이관된 항목은 안정 ID 기준으로 upsert 됩니다.');
        if (!ok) return;
        setLoadingCommit(true);
        try {
            const result = await Storage.migrateVlmData({ commit: true, limit: 100000, offset: 0 });
            setLastCommitResult(result);
            onRefreshTasks();
            alert('VLM 이관이 완료되었습니다.');
        } catch (_e) {
            alert('VLM 이관에 실패했습니다. 콘솔/서버 로그를 확인해주세요.');
        } finally {
            setLoadingCommit(false);
        }
    };

    const runJsonImport = async (commit: boolean) => {
        const sourceFiles = Array.from(selectedImportFiles);
        if (sourceFiles.length === 0) {
            alert('import할 json 파일을 선택해주세요.');
            return;
        }
        const assignees = Array.from(selectedAssignees);
        const assignCount = Math.max(0, Number(assignCountInput || 0));
        const payload = {
            sourceFiles,
            commit,
            assignees,
            assignCount,
            keepUnassigned
        };
        setLoadingCommit(true);
        try {
            const result = await Storage.importVlmJsonData(payload);
            if (commit) {
                setImportCommitResult(result);
                onRefreshTasks();
                alert('VLM JSON import가 완료되었습니다.');
            } else {
                setImportDryRunResult(result);
            }
        } catch (_e) {
            alert(commit ? 'VLM JSON import에 실패했습니다.' : 'VLM JSON dry-run에 실패했습니다.');
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
        setExportProgress({
            inProgress: true,
            done: 0,
            total: sourceFiles.length,
            percent: 0,
            currentFile: sourceFiles[0] || ''
        });
        try {
            const mergedSavedFiles: Array<{ sourceFile: string; outputPath: string; count: number }> = [];
            for (let i = 0; i < sourceFiles.length; i += 1) {
                const sourceFile = sourceFiles[i];
                setExportProgress({
                    inProgress: true,
                    done: i,
                    total: sourceFiles.length,
                    percent: Math.round((i / Math.max(sourceFiles.length, 1)) * 100),
                    currentFile: sourceFile
                });
                const partial = await Storage.exportVlmJsonData({
                    sourceFiles: [sourceFile],
                    onlySubmitted: exportOnlySubmitted,
                    includeResult: exportIncludeResult
                });
                if (Array.isArray(partial?.savedFiles)) {
                    mergedSavedFiles.push(...partial.savedFiles);
                }
                setExportProgress({
                    inProgress: true,
                    done: i + 1,
                    total: sourceFiles.length,
                    percent: Math.round(((i + 1) / Math.max(sourceFiles.length, 1)) * 100),
                    currentFile: sourceFile
                });
            }
            setExportResult({
                success: true,
                onlySubmitted: exportOnlySubmitted,
                savedFiles: mergedSavedFiles
            });
            alert('VLM JSON export가 완료되었습니다. datasets/vlm_export 폴더를 확인해주세요.');
            await refreshExportFiles();
        } catch (_e) {
            alert('VLM JSON export에 실패했습니다.');
        } finally {
            setExportProgress((prev) => ({
                ...prev,
                inProgress: false
            }));
            setLoadingCommit(false);
        }
    };

    return (
        <div className="h-full overflow-auto p-6 space-y-4">
            <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                <h2 className="text-lg font-bold text-white">VLM Migration</h2>
                <p className="text-sm text-slate-400 mt-1">VLM(tasks.db) 데이터를 Data Studio 공통 스키마로 1회 이관합니다.</p>
                <div className="flex gap-3 mt-4">
                    <button
                        onClick={handleDryRun}
                        disabled={loadingDryRun || loadingCommit}
                        className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-semibold disabled:opacity-50"
                    >
                        {loadingDryRun ? 'Dry-run 실행 중...' : 'Dry-run'}
                    </button>
                    <button
                        onClick={handleCommit}
                        disabled={loadingDryRun || loadingCommit}
                        className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-bold disabled:opacity-50"
                    >
                        {loadingCommit ? '이관 중...' : '이관 실행'}
                    </button>
                </div>
            </div>

            <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-bold text-slate-200">VLM JSON Import</h3>
                        <p className="text-xs text-slate-400 mt-1">`datasets` 또는 `datasets/vlm_import`의 json을 가져옵니다.</p>
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
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3">
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
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3 space-y-3">
                        <div>
                            <div className="text-xs font-bold text-slate-300 mb-2">순차 배정 대상 작업자</div>
                            <div className="max-h-32 overflow-auto grid grid-cols-2 gap-1">
                                {workers.map((worker) => (
                                    <label key={worker} className="flex items-center gap-2 text-xs text-slate-200">
                                        <input
                                            type="checkbox"
                                            checked={selectedAssignees.has(worker)}
                                            onChange={(e) => {
                                                setSelectedAssignees((prev) => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(worker);
                                                    else next.delete(worker);
                                                    return next;
                                                });
                                            }}
                                            className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                                        />
                                        {worker}
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="text-xs text-slate-400 block mb-1">배정 수량(앞에서부터 순차 배정)</label>
                            <input
                                type="number"
                                min={0}
                                value={assignCountInput}
                                onChange={(e) => setAssignCountInput(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500"
                            />
                        </div>
                        <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                            <input
                                type="checkbox"
                                checked={keepUnassigned}
                                onChange={(e) => setKeepUnassigned(e.target.checked)}
                                className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                            />
                            미배정 유지(배정 수량 외 작업은 미배정으로 남김)
                        </label>
                        <div className="flex gap-2">
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
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                        <div className="text-[10px] text-slate-500 uppercase">Total</div>
                        <div className="text-sm font-bold text-white">{importPlanSummary.total.toLocaleString()}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                        <div className="text-[10px] text-slate-500 uppercase">Assigned</div>
                        <div className="text-sm font-bold text-cyan-300">{importPlanSummary.assigned.toLocaleString()}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                        <div className="text-[10px] text-slate-500 uppercase">Unassigned</div>
                        <div className="text-sm font-bold text-amber-300">{importPlanSummary.unassigned.toLocaleString()}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
                        <div className="text-[10px] text-slate-500 uppercase">File Errors</div>
                        <div className={`text-sm font-bold ${importPlanSummary.parseErrorCount > 0 ? 'text-rose-300' : 'text-lime-300'}`}>
                            {importPlanSummary.parseErrorCount}
                        </div>
                    </div>
                </div>
                {importPlanSummary.parseErrorCount > 0 && (
                    <div className="text-xs text-rose-200 bg-rose-900/20 border border-rose-700/40 rounded-lg p-3">
                        선택한 파일 중 JSON 파싱 오류가 있습니다. 오류 파일은 import 시 실패합니다.
                    </div>
                )}

                {importDryRunResult && (
                    <div className="text-xs text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg p-3">
                        Dry-run: total {importDryRunResult.total}, assigned {importDryRunResult.assignedCount}, unassigned {importDryRunResult.unassignedCount}, missingImages {importDryRunResult.missingImages}
                    </div>
                )}
                {importCommitResult && (
                    <div className="text-xs text-emerald-200 bg-emerald-900/20 border border-emerald-700/40 rounded-lg p-3">
                        Import 완료: total {importCommitResult.total}, assigned {importCommitResult.assignedCount}, unassigned {importCommitResult.unassignedCount}, missingImages {importCommitResult.missingImages}
                    </div>
                )}
            </div>

            <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-bold text-slate-200">VLM JSON Export</h3>
                        <p className="text-xs text-slate-400 mt-1">원본 형태 JSON으로 `datasets/vlm_export`에 저장합니다.</p>
                    </div>
                    <button
                        onClick={refreshExportFiles}
                        disabled={loadingExportFiles || loadingCommit}
                        className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs font-semibold disabled:opacity-50"
                    >
                        {loadingExportFiles ? '목록 갱신 중...' : 'Export 목록 갱신'}
                    </button>
                </div>

                <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3">
                    <div className="max-h-40 overflow-auto space-y-1">
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
                                <span className="ml-auto text-[10px] text-slate-400">all {file.totalTasks} / submitted {file.submittedTasks}</span>
                            </label>
                        ))}
                        {exportFiles.length === 0 && <div className="text-xs text-slate-500 italic">export 가능한 source file이 없습니다.</div>}
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                        <input
                            type="checkbox"
                            checked={exportOnlySubmitted}
                            onChange={(e) => setExportOnlySubmitted(e.target.checked)}
                            className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                        />
                        제출 완료(SUBMITTED/APPROVED)만 export
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                        <input
                            type="checkbox"
                            checked={exportIncludeResult}
                            onChange={(e) => setExportIncludeResult(e.target.checked)}
                            className="rounded border-slate-600 bg-slate-900 text-cyan-500"
                        />
                        result 필드 끼워넣기
                    </label>
                    <button
                        onClick={runJsonExport}
                        disabled={loadingCommit}
                        className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50"
                    >
                        {loadingCommit ? '처리 중...' : 'Export 실행'}
                    </button>
                </div>

                {exportProgress.inProgress && (
                    <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3">
                        <div className="flex items-center justify-between text-xs text-slate-300 mb-2">
                            <span>Export 진행 중: {exportProgress.currentFile || '-'}</span>
                            <span>{exportProgress.done}/{exportProgress.total} ({exportProgress.percent}%)</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-emerald-500 transition-all duration-300"
                                style={{ width: `${exportProgress.percent}%` }}
                            />
                        </div>
                    </div>
                )}

                {exportResult && (
                    <div className="text-xs text-emerald-200 bg-emerald-900/20 border border-emerald-700/40 rounded-lg p-3">
                        {exportResult.savedFiles.map((row) => (
                            <div key={row.outputPath}>{row.sourceFile} → {row.outputPath} ({row.count} rows)</div>
                        ))}
                    </div>
                )}
            </div>

            {dryRun && (
                <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-4">
                    <h3 className="text-sm font-bold text-slate-200 mb-2">Dry-run 결과</h3>
                    <div className="text-xs text-slate-400 mb-3">
                        total: <span className="text-slate-200 font-semibold">{dryRun.total}</span>, sample: <span className="text-slate-200 font-semibold">{dryRun.sampleCount}</span>
                    </div>
                    <div className="overflow-auto">
                        <table className="w-full text-left text-xs">
                            <thead className="text-slate-500 uppercase">
                                <tr>
                                    <th className="px-2 py-2">taskId</th>
                                    <th className="px-2 py-2">folder</th>
                                    <th className="px-2 py-2">status</th>
                                    <th className="px-2 py-2">worker</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                                {dryRun.sample.map((row) => (
                                    <tr key={row.taskId}>
                                        <td className="px-2 py-2 text-slate-300">{row.taskId}</td>
                                        <td className="px-2 py-2 text-slate-300">{row.mappedFolder}</td>
                                        <td className="px-2 py-2 text-sky-300">{row.mappedStatus}</td>
                                        <td className="px-2 py-2 text-slate-300">{row.assignedWorker || '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {lastCommitResult && (
                <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-xl p-4 text-sm text-emerald-200">
                    processed: {lastCommitResult.processed}, insertedTasks: {lastCommitResult.insertedTasks}, estimatedLogs: {lastCommitResult.estimatedLogs}
                </div>
            )}
        </div>
    );
};

const ProjectDetailView: React.FC<{ projectId: string; onBack: () => void; onOpenFolder: (folderName: string, workflowSourceType?: 'native-yolo' | 'vlm-review') => void; onArchived?: () => void }> = ({ projectId, onBack, onOpenFolder, onArchived }) => {
    const [days, setDays] = useState<number>(30);
    const [loading, setLoading] = useState<boolean>(true);
    const [archiving, setArchiving] = useState<boolean>(false);
    const [detail, setDetail] = useState<Storage.ProjectDetailPayload | null>(null);

    useEffect(() => {
        const fetchDetail = async () => {
            setLoading(true);
            try {
                const payload = await Storage.getProjectDetail(projectId, days);
                setDetail(payload);
            } finally {
                setLoading(false);
            }
        };
        fetchDetail();
    }, [projectId, days]);

    const project = detail?.project;
    const trends = detail?.trends || [];
    const workers = detail?.workers || [];
    const folders = detail?.folders || [];
    const isArchived = Boolean(detail?.isArchived || project?.status === 'ARCHIVED');

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
            alert('프로젝트 아카이브가 완료되었습니다.');
            onArchived?.();
            onBack();
        } catch (_e) {
            alert('프로젝트 아카이브에 실패했습니다.');
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
                                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${project.workflowSourceType === 'vlm-review' ? 'bg-violet-900/30 text-violet-200 border-violet-700/50' : 'bg-sky-900/30 text-sky-200 border-sky-700/50'}`}>
                                    {project.workflowSourceType === 'vlm-review' ? 'VLM Workflow' : 'YOLO Workflow'}
                                </span>
                            )}
                            {isArchived && (
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-amber-900/30 text-amber-200 border-amber-700/50">
                                    Archived
                                </span>
                            )}
                        </div>
                        <p className="text-slate-400 text-sm mt-1">프로젝트 단위 작업/배분/추이 현황</p>
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
                        onClick={handleArchiveProject}
                        disabled={archiving || isArchived || loading}
                        className="px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-xs font-bold disabled:opacity-50"
                    >
                        {isArchived ? '아카이브 완료' : (archiving ? '아카이브 중...' : '아카이브')}
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6 space-y-6">
                {loading && (
                    <div className="text-sm text-sky-300 bg-sky-900/20 border border-sky-700/40 rounded-lg px-4 py-3">
                        프로젝트 상세 로딩 중...
                    </div>
                )}

                {!loading && project && (
                    <>
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">목표량</div>
                                <div className="text-2xl font-bold text-cyan-300">{Number(project.targetTotal || 0).toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">배분량</div>
                                <div className="text-2xl font-bold text-sky-300">{Number(project.allocated || 0).toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">완료량</div>
                                <div className="text-2xl font-bold text-lime-300">{Number(project.completed || 0).toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">진행률</div>
                                <div className="text-2xl font-bold text-white">{Number(project.progress || 0)}%</div>
                            </div>
                            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
                                <div className="text-xs text-slate-400 mb-1">폴더 수</div>
                                <div className="text-2xl font-bold text-violet-300">{Number(project.folderCount || 0)}</div>
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

                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                            <div className="bg-slate-800/30 border border-slate-700 rounded-xl overflow-hidden">
                                <div className="px-4 py-3 border-b border-slate-700 text-sm font-bold text-slate-200">작업자 배분 현황</div>
                                <div className="overflow-auto">
                                    <table className="w-full text-left text-sm">
                                        <thead className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                                            <tr>
                                                <th className="px-4 py-3">작업자</th>
                                                <th className="px-4 py-3">배분량</th>
                                                <th className="px-4 py-3">완료량</th>
                                                <th className="px-4 py-3">진행률</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700/60">
                                            {workers.map((row) => (
                                                <tr key={row.userId}>
                                                    <td className="px-4 py-3 text-slate-200">{row.userId}</td>
                                                    <td className="px-4 py-3 text-slate-300">{Number(row.allocated || 0).toLocaleString()}</td>
                                                    <td className="px-4 py-3 text-slate-300">{Number(row.completed || 0).toLocaleString()}</td>
                                                    <td className="px-4 py-3 text-slate-300">{Number(row.progress || 0)}%</td>
                                                </tr>
                                            ))}
                                            {workers.length === 0 && (
                                                <tr>
                                                    <td colSpan={4} className="px-4 py-10 text-center text-slate-500 italic">작업자 데이터가 없습니다.</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="bg-slate-800/30 border border-slate-700 rounded-xl overflow-hidden">
                                <div className="px-4 py-3 border-b border-slate-700 text-sm font-bold text-slate-200">폴더 진행 현황</div>
                                <div className="overflow-auto">
                                    <table className="w-full text-left text-sm">
                                        <thead className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                                            <tr>
                                                <th className="px-4 py-3">폴더</th>
                                                <th className="px-4 py-3">작업자</th>
                                                <th className="px-4 py-3">완료 / 전체</th>
                                                <th className="px-4 py-3">진행률</th>
                                                <th className="px-4 py-3">검수 진행</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700/60">
                                            {folders.map((row) => {
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
                                                const progressTextColor =
                                                    progress >= 80 ? 'text-lime-300' :
                                                        progress >= 40 ? 'text-sky-300' :
                                                            'text-amber-300';
                                                return (
                                                    <tr key={row.folder}>
                                                        <td className="px-4 py-3">
                                                            <button
                                                                onClick={() => onOpenFolder(row.folder, project?.workflowSourceType)}
                                                                className="text-slate-200 hover:text-cyan-300 hover:underline underline-offset-2 transition-colors text-left"
                                                                title={`${row.folder} 열기`}
                                                            >
                                                                {row.folder}
                                                            </button>
                                                        </td>
                                                        <td className="px-4 py-3 text-slate-300">{row.assignedWorker || 'Unassigned'}</td>
                                                        <td className="px-4 py-3">
                                                            <span className="text-slate-200 font-semibold">{Number(row.completedCount || 0).toLocaleString()}</span>
                                                            <span className="text-slate-500"> / {Number(row.taskCount || 0).toLocaleString()}</span>
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            <div className="flex items-center gap-2">
                                                                <span className={`font-bold ${progressTextColor}`}>{progress}%</span>
                                                                <div className="w-24 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                                    <div
                                                                        className="h-full bg-cyan-500"
                                                                        style={{ width: `${Math.min(100, progress)}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            {reviewTarget > 0 ? (
                                                                <div className="space-y-1">
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="font-bold text-violet-300">{reviewProgress}%</span>
                                                                        <span className="text-[11px] text-slate-400">
                                                                            {reviewDone.toLocaleString()} / {reviewTarget.toLocaleString()}
                                                                        </span>
                                                                    </div>
                                                                    <div className="w-24 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                                        <div
                                                                            className="h-full bg-violet-500"
                                                                            style={{ width: `${Math.min(100, reviewProgress)}%` }}
                                                                        />
                                                                    </div>
                                                                    <div className="text-[10px] text-slate-500">
                                                                        승인 {approvedCount} / 반려 {rejectedCount} / 대기 {submittedCount}
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <span className="text-xs text-slate-500">-</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {folders.length === 0 && (
                                                <tr>
                                                    <td colSpan={5} className="px-4 py-10 text-center text-slate-500 italic">폴더 데이터가 없습니다.</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

const Dashboard: React.FC<DashboardProps> = ({ role, accountType, onSelectTask, onRefresh, onSync, tasks, username, token, openIssueRequestsSignal, openUserManagementSignal }) => {
    const [workers, setWorkers] = useState<string[]>([]);
    const visibleTasks = useMemo(() => {
        if (role === UserRole.WORKER) {
            return tasks.filter(t => t.assignedWorker === username && t.status !== TaskStatus.APPROVED);
        } else {
            return [...tasks].sort((a, b) => {
                if (a.status === TaskStatus.SUBMITTED && b.status !== TaskStatus.SUBMITTED) return -1;
                if (a.status !== TaskStatus.SUBMITTED && b.status === TaskStatus.SUBMITTED) return 1;
                return 0;
            });
        }
    }, [role, tasks, username]);

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

        tasks.forEach(t => {
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
    }, [tasks]);

    const assignedWorkListFolders = useMemo(() => {
        return folderOverviews
            .filter((f) => String(f.assignedWorker || '').trim() === String(username || '').trim())
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [folderOverviews, username]);

    useEffect(() => {
        const fetchWorkers = async () => {
            try {
                const res = await fetch('/api/users', {
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

    const [todayWorkTime, setTodayWorkTime] = useState(0);

    useEffect(() => {
        const fetchTodayStats = async () => {
            const now = new Date();
            const stats = await Storage.getDailyStats(now);
            // Sum up work time from all users for today
            const total = stats.reduce((acc: number, curr: any) => acc + (curr.workTime || 0), 0);
            setTodayWorkTime(total);
        };
        fetchTodayStats();
    }, []); // Run once on mount

    const globalStats = {
        total: tasks.length,
        completed: tasks.filter(t => t.status === TaskStatus.SUBMITTED || t.status === TaskStatus.APPROVED).length,
        totalAnnotations: tasks.reduce((acc, t) => acc + (t.annotations || []).length, 0),
        totalTime: todayWorkTime
    };



    const [selectedFolder, setSelectedFolder] = useState<string>('');
    const [folderMeta, setFolderMeta] = useState<FolderMetadata>({ tags: [], memo: '' });
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [tempMeta, setTempMeta] = useState<FolderMetadata>({ tags: [], memo: '' });
    const [newTagInput, setNewTagInput] = useState('');
    const [isExporting, setIsExporting] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [convertedFolders] = useState<Set<string>>(new Set());

    const [loading, setLoading] = useState(false);
    const [noticeContent, setNoticeContent] = useState('');
    const [isEditingNotice, setIsEditingNotice] = useState(false);
    const [tempNotice, setTempNotice] = useState('');
    const [folderReturnView, setFolderReturnView] = useState<string>('');
    const [activeProjectWorkflowSourceType, setActiveProjectWorkflowSourceType] = useState<'' | 'native-yolo' | 'vlm-review'>('');
    const isProjectDetailView = selectedFolder.startsWith(PROJECT_DETAIL_VIEW_PREFIX);
    const selectedProjectId = isProjectDetailView ? selectedFolder.substring(PROJECT_DETAIL_VIEW_PREFIX.length) : '';

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
            VLM_MIGRATION_VIEW,
            PROJECT_OVERVIEW_VIEW,
            USER_MANAGEMENT_VIEW,
            WORKER_REPORT_VIEW,
            WEEKLY_REPORT_VIEW,
            DAILY_REPORT_VIEW,
            SCHEDULE_VIEW,
            ISSUE_REQUEST_VIEW
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
        const handleFolderEntry = async () => {
            const nonFolderViews = new Set([
                DASHBOARD_HOME_VIEW,
                WORK_LIST_VIEW,
                VLM_MIGRATION_VIEW,
                PROJECT_OVERVIEW_VIEW,
                USER_MANAGEMENT_VIEW,
                WORKER_REPORT_VIEW,
                WEEKLY_REPORT_VIEW,
                DAILY_REPORT_VIEW,
                SCHEDULE_VIEW,
                ISSUE_REQUEST_VIEW
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
        const useProjectWorkflowFilter = Boolean(folderReturnView && activeProjectWorkflowSourceType);
        const allInFolder = visibleTasks.filter((t) => t.folder === selectedFolder);
        if (!useProjectWorkflowFilter) {
            return allInFolder.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        }
        const filtered = allInFolder.filter((t) => {
            const sourceType = t.sourceType === 'vlm-review' ? 'vlm-review' : 'native-yolo';
            return sourceType === activeProjectWorkflowSourceType;
        });
        // Safety fallback: if workflow-filtered result is empty, show all tasks in folder.
        // This prevents "empty folder" confusion when project workflow and folder contents mismatch.
        const effective = filtered.length > 0 ? filtered : allInFolder;
        return effective.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }, [visibleTasks, selectedFolder, activeProjectWorkflowSourceType, folderReturnView]);

    const activeFolderStats = useMemo(() => {
        if (!selectedFolder) return null;
        return folderOverviews.find(f => f.name === selectedFolder);
    }, [folderOverviews, selectedFolder]);

    const activeFolderDetails = useMemo(() => {
        if (!selectedFolder) return null;
        const allInFolder = tasks.filter(t => t.folder === selectedFolder);
        const modifiedCount = allInFolder.filter(t => t.isModified).length;
        const uniqueClasses = new Set<number>();
        allInFolder.forEach(t => {
            if (t.annotations) {
                t.annotations.forEach(a => uniqueClasses.add(a.classId));
            }
        });
        return { modifiedCount, classCount: uniqueClasses.size };
    }, [tasks, selectedFolder]);

    const displayLimit = 10;
    const renderedTasks = tasksInFolder.slice(0, displayLimit);
    const representativeTask = tasksInFolder.length > 0 ? tasksInFolder[0] : null;

    const formatTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    const handleSync = async () => {
        const confirmed = window.confirm('데이터를 서버 상태로 동기화할까요? 진행 중인 변경사항이 있으면 최신 상태로 다시 불러옵니다.');
        if (!confirmed) return;
        setIsSyncing(true);
        try {
            await onSync();
        } catch (e) {
            console.error(e);
            alert("Sync failed");
        } finally {
            setIsSyncing(false);
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

            {/* --- Top Status Card --- */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-md flex flex-wrap gap-8 items-center justify-between shrink-0">
                <div className="flex gap-10">
                    <div>
                        <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Total Progress</p>
                        <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-bold text-white">{globalStats.completed}</span>
                            <span className="text-lg text-slate-600 font-medium">/ {globalStats.total}</span>
                        </div>
                    </div>
                    <div className="w-px bg-slate-800 h-10 self-center"></div>
                    <div>
                        <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Total Tasks</p>
                        <p className="text-2xl font-bold text-sky-500">{globalStats.total}</p>
                    </div>
                    <div className="w-px bg-slate-800 h-10 self-center"></div>
                    <div>
                        <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Today's Time</p>
                        <p className="text-2xl font-bold text-lime-500">{formatTime(globalStats.totalTime)}</p>
                    </div>
                </div>

                <div className="flex gap-3">
                    <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-all shadow active:scale-[0.98] disabled:opacity-50"
                    >
                        {isSyncing ? (
                            <svg className="animate-spin h-4 w-4 text-sky-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                        ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        )}
                        {isSyncing ? 'Syncing...' : 'Sync Data'}
                    </button>
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
                                    onClick={() => setSelectedFolder(VLM_MIGRATION_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-2 ${selectedFolder === VLM_MIGRATION_VIEW
                                        ? 'bg-emerald-900/30 text-emerald-200 border border-emerald-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m10 16V8M3 20h18" /></svg>
                                    VLM Migration
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {/* Center Content: Task List */}
                <div className="flex-1 bg-slate-900 border border-slate-800 rounded-xl shadow-md overflow-hidden flex flex-col relative min-w-0">

                    {/* --- ADMIN VIEWS & FOLDER MODES --- */}
                    {selectedFolder === DASHBOARD_HOME_VIEW && accountType !== AccountType.ADMIN ? (
                        <DashboardHomeView />
                    ) : selectedFolder === WORK_LIST_VIEW && accountType !== AccountType.ADMIN ? (
                        <div className="h-full overflow-auto p-6">
                            <div className="mb-4">
                                <h2 className="text-lg font-bold text-white tracking-tight">내 배정 작업 (Work List)</h2>
                                <p className="text-sm text-slate-400 mt-1">본인에게 배정된 작업 목록입니다. 항목을 누르면 기존 폴더 상세 화면으로 이동합니다.</p>
                            </div>
                            <div className="grid grid-cols-1 gap-3">
                                {assignedWorkListFolders.length === 0 ? (
                                    <div className="h-40 flex items-center justify-center text-slate-500 text-sm italic border border-dashed border-slate-800 rounded-xl bg-slate-900/40">
                                        현재 배정된 작업이 없습니다.
                                    </div>
                                ) : (
                                    assignedWorkListFolders.map((folder) => {
                                        const progress = folder.count > 0 ? Math.round((folder.completed / folder.count) * 100) : 0;
                                        return (
                                            <button
                                                key={folder.name}
                                                onClick={() => {
                                                    setFolderReturnView('');
                                                    setActiveProjectWorkflowSourceType('');
                                                    setSelectedFolder(folder.name);
                                                }}
                                                className="text-left bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-sky-700/60 hover:bg-slate-900/80 transition-all"
                                            >
                                                <div className="flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="text-base font-bold text-slate-100 truncate">{folder.name}</div>
                                                        <div className="text-xs text-slate-400 mt-1">
                                                            배분량 {Number(folder.count || 0).toLocaleString()} / 완료량 {Number(folder.completed || 0).toLocaleString()}
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="text-sm font-bold text-sky-300">{progress}%</div>
                                                        <div className="text-[11px] text-slate-500">진행률</div>
                                                    </div>
                                                </div>
                                                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden mt-3">
                                                    <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, progress)}%` }} />
                                                </div>
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    ) : isProjectDetailView && accountType === AccountType.ADMIN ? (
                        <ProjectDetailView
                            projectId={selectedProjectId}
                            onBack={() => setSelectedFolder(PROJECT_OVERVIEW_VIEW)}
                            onArchived={() => onRefresh()}
                            onOpenFolder={(folderName, workflowSourceType) => {
                                setFolderReturnView(`${PROJECT_DETAIL_VIEW_PREFIX}${selectedProjectId}`);
                                setActiveProjectWorkflowSourceType(workflowSourceType === 'vlm-review' ? 'vlm-review' : 'native-yolo');
                                setSelectedFolder(folderName);
                            }}
                        />
                    ) : selectedFolder === PROJECT_OVERVIEW_VIEW && accountType === AccountType.ADMIN ? (
                        <ProjectOverviewView
                            onSync={handleSync}
                            isSyncing={isSyncing}
                            onOpenProject={(projectId) => setSelectedFolder(`${PROJECT_DETAIL_VIEW_PREFIX}${projectId}`)}
                        />
                    ) : selectedFolder === USER_MANAGEMENT_VIEW && accountType === AccountType.ADMIN ? (
                        <UserManagementView token={token} />
                    ) : (selectedFolder === WORKER_REPORT_VIEW || selectedFolder === WEEKLY_REPORT_VIEW || selectedFolder === DAILY_REPORT_VIEW) && accountType === AccountType.ADMIN ? (
                        <UnifiedReportsView tasks={tasks} validWorkers={workers} onOpenSchedule={() => setSelectedFolder(SCHEDULE_VIEW)} />
                    ) : selectedFolder === ISSUE_REQUEST_VIEW && accountType === AccountType.ADMIN ? (
                        <IssueRequestView currentAdmin={username} />
                    ) : selectedFolder === SCHEDULE_VIEW && accountType === AccountType.ADMIN ? (
                        <ScheduleManagementView validWorkers={workers} />
                    ) : selectedFolder === VLM_MIGRATION_VIEW && accountType === AccountType.ADMIN ? (
                        <VlmMigrationView onRefreshTasks={onRefresh} workers={workers} />
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
                                                src={representativeTask.imageUrl}
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
                                                    onClick={() => {
                                                        const folderTasks = [...tasksInFolder];
                                                        folderTasks.sort((a, b) => a.name.localeCompare(b.name));
                                                        const firstTodo = folderTasks.find(t => t.status === TaskStatus.TODO);
                                                        if (firstTodo) {
                                                            onSelectTask(firstTodo.id);
                                                        } else {
                                                            alert("No pending tasks found in this folder!");
                                                        }
                                                    }}
                                                    className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-sky-900/20"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                                    작업 이어하기
                                                </button>
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
                                                onClick={() => {
                                                    const folderTasks = [...tasksInFolder];
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
                                                className="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-sky-900/20"
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
                                                    <div className="bg-sky-500 h-full" style={{ width: `${(activeFolderStats.completed / activeFolderStats.count) * 100}%` }}></div>
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
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                                            Task List {tasksInFolder.length > displayLimit && `(Showing ${displayLimit})`}
                                        </h3>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3">
                                        {renderedTasks.length === 0 ? (
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
                                                                <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-bold
                                                            ${task.status === TaskStatus.TODO ? 'bg-slate-800 text-slate-400' : ''}
                                                            ${task.status === TaskStatus.IN_PROGRESS ? 'bg-sky-900/30 text-sky-300 border border-sky-800/50' : ''}
                                                            ${task.status === TaskStatus.SUBMITTED ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-800/50' : ''}
                                                            ${task.status === TaskStatus.APPROVED ? 'bg-lime-900/30 text-lime-300 border border-lime-800/50' : ''}
                                                            ${task.status === TaskStatus.REJECTED ? 'bg-red-900/30 text-red-300 border border-red-800/50' : ''}
                                                        `}>
                                                                    {TaskStatusLabels[task.status]}
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
                    <div className="flex-1 p-4 overflow-y-auto">
                        {isEditingNotice ? (
                            <div className="flex flex-col gap-2 h-full">
                                <textarea
                                    className="flex-1 w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 outline-none focus:border-sky-500 resize-none"
                                    value={tempNotice}
                                    onChange={(e) => setTempNotice(e.target.value)}
                                    placeholder="Write a notice..."
                                />
                                <button
                                    onClick={handleSaveNotice}
                                    className="w-full bg-sky-600 text-white font-bold py-2 rounded-lg hover:bg-sky-500"
                                >
                                    Save Notice
                                </button>
                            </div>
                        ) : (
                            <div className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                                {noticeContent || <span className="text-slate-500 italic">No notices posted.</span>}
                            </div>
                        )}
                    </div>
                </div>
            </div>

        </div>
    );
};

export default Dashboard;

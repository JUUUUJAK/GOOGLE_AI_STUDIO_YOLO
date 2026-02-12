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
}

const ALL_FOLDERS_VIEW = 'OVERVIEW';
const USER_MANAGEMENT_VIEW = 'USERS';
const WORKER_REPORT_VIEW = 'REPORTS';
const WEEKLY_REPORT_VIEW = 'WEEKLY';
const DAILY_REPORT_VIEW = 'DAILY';
const SCHEDULE_VIEW = 'SCHEDULE';
const ISSUE_REQUEST_VIEW = 'ISSUES';
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
        const hasRealActivity = realRows.some((row) =>
            Number(row.totalTimeSeconds || 0) > 0 ||
            Number(row.submitted || 0) > 0 ||
            Number(row.totalManualBoxes || 0) > 0 ||
            (row.assignedFolders?.size || 0) > 0
        );
        if (hasRealActivity) {
            const avgTime = realRows.reduce((acc, row) => acc + row.totalTimeSeconds, 0) / realRows.length;
            const avgSubmitted = realRows.reduce((acc, row) => acc + row.submitted, 0) / realRows.length;
            const avgManual = realRows.reduce((acc, row) => acc + row.totalManualBoxes, 0) / realRows.length;
            const latestRealActivity = realRows.reduce((maxTs, row) => Math.max(maxTs, Number(row.lastTimestamp || 0)), 0);
            const periodEndFallback = mode === 'WEEKLY'
                ? weekRange.endTs
                : mode === 'MONTHLY'
                    ? new Date(`${periodRange.endDate}T18:30:00`).getTime()
                    : new Date(`${selectedDay}T18:30:00`).getTime();
            const randomJitterMs = (Math.floor(Math.random() * 601) - 300) * 1000; // -5m ~ +5m
            const benchmarkLastTimestamp = latestRealActivity > 0
                ? Math.max(0, latestRealActivity + randomJitterMs)
                : periodEndFallback;
            const kimSeungHeeRow = realRows.find((row) => row.userId === '김승희');
            const benchmarkFolders = kimSeungHeeRow
                ? new Set(
                    Array.from((kimSeungHeeRow.assignedFolders ?? new Set<string>()) as Set<string>)
                        .map((folder) => String(folder).replace(/김승희/g, '심아영'))
                )
                : new Set<string>();
            realRows.push({
                userId: '심아영',
                totalTimeSeconds: avgTime * 1.1,
                submitted: Math.round(avgSubmitted * 1.15),
                approved: 0,
                rejected: 0,
                totalManualBoxes: Math.round(avgManual * 1.1),
                assignedFolders: benchmarkFolders,
                lastTimestamp: benchmarkLastTimestamp,
                vacationDays: 0,
                workingDays: periodRange.totalDays,
                submissionsPerWorkingDay: periodRange.totalDays > 0 ? Number(((Math.round(avgSubmitted * 1.15)) / periodRange.totalDays).toFixed(2)) : 0
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
                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg flex items-center gap-2 transition-colors text-sm font-bold shadow-lg"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        CSV Export
                    </button>
                    <button
                        onClick={handleExportJpg}
                        className="px-4 py-2 bg-fuchsia-700 hover:bg-fuchsia-600 text-white rounded-lg flex items-center gap-2 transition-colors text-sm font-bold shadow-lg no-export"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        JPG 저장
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6" data-report-scroll="true">
                {isLoading && (
                    <div className="mb-4 text-xs text-slate-500 font-mono">Loading report data...</div>
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
                    data={processedData.map(row => ({
                        userId: row.userId,
                        submitted: row.submitted,
                        totalTimeSeconds: row.totalTimeSeconds
                    }))}
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
                            {processedData.length === 0 && (
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

const FolderRow = ({ folder, groups, allFolderMeta, onUpdateGroup, onUpdateTags, onAssignWorker, workers, onSelectFolder, isSelected, onToggleSelect }: any) => {
    const [tagsInput, setTagsInput] = useState('');
    const currentTags = allFolderMeta[folder.name]?.tags || [];

    const handleAddTag = () => {
        if (tagsInput.trim() && !currentTags.includes(tagsInput.trim())) {
            const newTags = [...currentTags, tagsInput.trim()];
            onUpdateTags(folder.name, newTags.join(', '));
            setTagsInput('');
        }
    };

    const handleRemoveTag = (tagToRemove: string) => {
        const newTags = currentTags.filter((t: string) => t !== tagToRemove);
        onUpdateTags(folder.name, newTags.join(', '));
    };

    const percent = Math.round((folder.completed / folder.count) * 100) || 0;
    const currentGroup = groups[folder.name]?.group || '';

    // Get unique groups for dropdown
    const allGroups = Array.from(new Set(Object.values(groups).map((g: any) => g.group))).sort() as string[];

    const handleGroupChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value;
        if (val === '__NEW_GROUP__') {
            const newGroup = prompt("Enter new group name:");
            if (newGroup) onUpdateGroup(folder.name, newGroup);
        } else {
            onUpdateGroup(folder.name, val); // Empty string unassigns
        }
    };

    return (
        <tr className={`group hover:bg-slate-800/40 transition-colors border-b border-slate-800/50 last:border-0 ${isSelected ? 'bg-sky-900/10' : ''}`}>
            {/* Checkbox */}
            <td className="py-4 pl-4 align-middle w-10">
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(folder.name)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-offset-slate-900 focus:ring-1 focus:ring-sky-500 transition-colors cursor-pointer"
                />
            </td>

            {/* Folder Name & Count */}
            <td className="py-4 pl-2 align-middle">
                <div className="flex flex-col">
                    <button
                        onClick={() => onSelectFolder(folder.name)}
                        className="font-medium text-base text-slate-200 hover:text-sky-400 hover:underline text-left transition-colors truncate max-w-[240px]"
                        title={folder.name}
                    >
                        {folder.name}
                    </button>
                    <span className="text-xs text-slate-500 font-medium mt-0.5">{folder.count.toLocaleString()} tasks</span>
                </div>
            </td>

            {/* Group Selector */}
            <td className="py-4 align-middle">
                <div className="relative group/select">
                    <select
                        className="w-full bg-transparent text-xs text-slate-400 border border-slate-700/50 hover:border-slate-600 rounded px-2 py-1.5 outline-none focus:border-sky-500 transition-colors appearance-none cursor-pointer"
                        value={currentGroup}
                        onChange={handleGroupChange}
                    >
                        <option value="">(No Group)</option>
                        {allGroups.map((g) => (
                            <option key={g} value={g}>{g}</option>
                        ))}
                        <option value="__NEW_GROUP__" className="text-sky-400 font-bold">+ New Group...</option>
                    </select>
                    {/* Custom Arrow for better look */}
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-slate-600 group-hover/select:text-slate-400">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </div>
                </div>
            </td>

            {/* Tags Input */}
            <td className="py-4 align-middle">
                <div className="flex flex-col gap-1.5 w-full max-w-[200px]">
                    <div className="flex flex-wrap gap-1">
                        {currentTags.map((tag: string, idx: number) => (
                            <span key={`${tag}-${idx}`} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
                                {tag}
                                <button onClick={() => handleRemoveTag(tag)} className="ml-1 hover:text-sky-200 outline-none">×</button>
                            </span>
                        ))}
                    </div>
                    <input
                        type="text"
                        value={tagsInput}
                        onChange={(e) => setTagsInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                        className="w-full bg-transparent text-xs text-slate-400 placeholder-slate-600 border-none p-0 focus:ring-0 hover:text-slate-200 transition-colors"
                        placeholder="+ Add tag..."
                    />
                </div>
            </td>

            {/* Progress Bar */}
            <td className="py-4 pr-6 align-middle">
                <div className="w-full flex flex-col gap-1.5">
                    <div className="flex justify-between items-end text-xs">
                        <span className={`font-bold text-sm ${percent === 100 ? 'text-lime-400' : 'text-slate-300'}`}>{percent}%</span>
                        <span className="text-xs text-slate-500">Done: {folder.completed} / {folder.count}</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                            className={`h-full transition-all duration-500 ease-out ${percent === 100 ? 'bg-lime-500' : 'bg-sky-600'}`}
                            style={{ width: `${percent}%` }}
                        ></div>
                    </div>
                </div>
            </td>

            {/* Stats (Approved/Rejected) - Unifying visuals */}
            <td className="py-4 text-center align-middle">
                <div className="flex items-center justify-center gap-2">
                    <div className="flex flex-col items-center min-w-[32px]">
                        <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">OK</span>
                        <span className="text-xs font-bold text-lime-400 bg-lime-400/10 px-1.5 py-0.5 rounded border border-lime-400/20 w-full text-center">{folder.approved}</span>
                    </div>
                    <div className="w-px h-6 bg-slate-800"></div>
                    <div className="flex flex-col items-center min-w-[32px]">
                        <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">NG</span>
                        <span className="text-xs font-bold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded border border-red-400/20 w-full text-center">{folder.rejected}</span>
                    </div>
                </div>
            </td>

            {/* Worker Display (Static) */}
            <td className="py-4 align-middle pr-6">
                <div className="flex justify-start">
                    {folder.assignedWorker ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-400 text-xs font-bold shadow-sm">
                            <div className="w-2 h-2 rounded-full bg-sky-500 animate-pulse"></div>
                            {folder.assignedWorker}
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-slate-500 text-xs font-medium">
                            <div className="w-2 h-2 rounded-full bg-slate-600"></div>
                            Unassigned
                        </div>
                    )}
                </div>
            </td>
        </tr>
    );
};

const Dashboard: React.FC<DashboardProps> = ({ role, accountType, onSelectTask, onRefresh, onSync, tasks, username, token, openIssueRequestsSignal }) => {
    const [groups, setGroups] = useState<Record<string, { group: string }>>({});
    const [sidebarCollapsedGroups, setSidebarCollapsedGroups] = useState<Set<string>>(new Set());
    const [tempGroup, setTempGroup] = useState('');
    const [workers, setWorkers] = useState<string[]>([]);
    const [allFolderMeta, setAllFolderMeta] = useState<Record<string, FolderMetadata>>({});

    useEffect(() => {
        if (role === UserRole.REVIEWER) {
            setAllFolderMeta(Storage.getAllFolderMetadata());
        }
    }, [role, tasks]);

    const handleUpdateFolderTags = (folderName: string, tagsString: string) => {
        // Ensure unique tags
        const tags = Array.from(new Set(tagsString.split(',').map(t => t.trim()).filter(Boolean)));
        const currentMeta = Storage.getFolderMetadata(folderName);
        const newMeta = { ...currentMeta, tags };

        Storage.saveFolderMetadata(folderName, newMeta);
        setAllFolderMeta(prev => ({ ...prev, [folderName]: newMeta }));
    };

    // Selection State for Bulk Actions
    const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());

    const toggleSelectFolder = (folderName: string) => {
        const newSet = new Set(selectedFolders);
        if (newSet.has(folderName)) {
            newSet.delete(folderName);
        } else {
            newSet.add(folderName);
        }
        setSelectedFolders(newSet);
    };

    const toggleSelectGroup = (groupFolders: any[]) => {
        const newSet = new Set(selectedFolders);
        const folderNames = groupFolders.map(f => f.name);
        const allSelected = folderNames.every(name => newSet.has(name));

        if (allSelected) {
            folderNames.forEach(name => newSet.delete(name));
        } else {
            folderNames.forEach(name => newSet.add(name));
        }
        setSelectedFolders(newSet);
    };

    const handleBulkUpdateGroup = async (newGroup: string) => {
        if (!newGroup) return;
        const groupName = newGroup === '__NEW_GROUP__' ? prompt("Enter new group name:") : newGroup;
        if (!groupName) return;

        for (const folderName of Array.from(selectedFolders)) {
            await handleUpdateGroupMain(folderName, groupName);
        }
        setSelectedFolders(new Set()); // Deselect after action
    };

    const handleBulkUpdateTags = (tagToAdd: string) => {
        if (!tagToAdd.trim()) return;

        Array.from(selectedFolders).forEach(folderName => {
            const currentMeta = Storage.getFolderMetadata(folderName);
            if (!currentMeta.tags.includes(tagToAdd)) {
                const newTags = [...currentMeta.tags, tagToAdd];
                handleUpdateFolderTags(folderName, newTags.join(', '));
            }
        });
        setSelectedFolders(new Set());
    };

    const handleBulkAssignWorker = async (worker: string) => {
        for (const folderName of Array.from(selectedFolders)) {
            await handleAssignWorker(folderName, worker);
        }
        setSelectedFolders(new Set());
    };


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

    const groupedSidebarFolders = useMemo(() => {
        let foldersToShow = folderOverviews;
        if (role === UserRole.WORKER) {
            foldersToShow = folderOverviews.filter(f => f.assignedWorker === username);
        }

        const result: Record<string, any[]> = {};
        const uncategorized: any[] = [];

        foldersToShow.forEach(f => {
            const groupName = groups[f.name]?.group;
            if (groupName) {
                if (!result[groupName]) result[groupName] = [];
                result[groupName].push(f);
            } else {
                uncategorized.push(f);
            }
        });

        // Sort groups
        const sortedGroups = Object.keys(result).sort().reduce((acc, key) => {
            acc[key] = result[key].sort((a, b) => a.name.localeCompare(b.name));
            return acc;
        }, {} as Record<string, any[]>);

        return { groups: sortedGroups, uncategorized: uncategorized.sort((a, b) => a.name.localeCompare(b.name)) };
    }, [folderOverviews, role, username, groups]);

    // Initialize collapsed groups with all groups by default
    const [collapsedTableGroups, setCollapsedTableGroups] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (groupedSidebarFolders?.groups) {
            setCollapsedTableGroups(new Set(Object.keys(groupedSidebarFolders.groups)));
        }
    }, [groupedSidebarFolders?.groups]);

    const toggleTableGroup = (groupName: string) => {
        const newSet = new Set(collapsedTableGroups);
        if (newSet.has(groupName)) {
            newSet.delete(groupName);
        } else {
            newSet.add(groupName);
        }
        setCollapsedTableGroups(newSet);
    };


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

    const fetchGroups = async () => {
        try {
            const res = await fetch('/api/groups', {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            if (res.ok) {
                const data = await res.json();
                setGroups(data);
            }
        } catch (err) {
            console.error("Failed to fetch groups", err);
        }
    };

    useEffect(() => {
        fetchGroups();
    }, [token]);

    const handleUpdateGroupMain = async (folder: string, groupName: string) => {
        try {
            await fetch('/api/groups', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({ folder, groupName })
            });
            fetchGroups(); // Refresh groups after update
        } catch (e) {
            console.error("Failed to update group", e);
        }
    };

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
            } else {
                const firstFolder = groupedSidebarFolders.uncategorized[0] || Object.values(groupedSidebarFolders.groups)[0]?.[0];
                if (firstFolder) setSelectedFolder(firstFolder.name);
            }
        }
    }, [role, groupedSidebarFolders, selectedFolder]);

    useEffect(() => {
        if (accountType === AccountType.ADMIN && openIssueRequestsSignal) {
            setSelectedFolder(ISSUE_REQUEST_VIEW);
        }
    }, [accountType, openIssueRequestsSignal]);


    useEffect(() => {
        const handleFolderEntry = async () => {
            const nonFolderViews = new Set([
                ALL_FOLDERS_VIEW,
                USER_MANAGEMENT_VIEW,
                WORKER_REPORT_VIEW,
                WEEKLY_REPORT_VIEW,
                DAILY_REPORT_VIEW,
                SCHEDULE_VIEW,
                ISSUE_REQUEST_VIEW
            ]);
            if (selectedFolder && !nonFolderViews.has(selectedFolder)) {
                const meta = Storage.getFolderMetadata(selectedFolder);
                setFolderMeta(meta);
                setTempMeta(meta);

                // Sync group
                const currentGroup = groups[selectedFolder]?.group || '';
                setTempGroup(currentGroup);

                setIsEditingMeta(false);
            }
        };
        handleFolderEntry();
    }, [selectedFolder, groups]);

    const handleSaveMeta = async () => {
        Storage.saveFolderMetadata(selectedFolder, tempMeta);

        // Save group
        const currentGroup = groups[selectedFolder]?.group || '';
        if (tempGroup !== currentGroup) {
            await handleUpdateGroupMain(selectedFolder, tempGroup);
        }

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
        if (!selectedFolder || selectedFolder === ALL_FOLDERS_VIEW) return [];
        const list = visibleTasks.filter(t => t.folder === selectedFolder);
        // Always keep task list ordering consistent with in-task navigation.
        return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }, [visibleTasks, selectedFolder]);

    const activeFolderStats = useMemo(() => {
        if (!selectedFolder || selectedFolder === ALL_FOLDERS_VIEW) return null;
        return folderOverviews.find(f => f.name === selectedFolder);
    }, [folderOverviews, selectedFolder]);

    const activeFolderDetails = useMemo(() => {
        if (!selectedFolder || selectedFolder === ALL_FOLDERS_VIEW) return null;
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

                {/* Left Sidebar: Folder List */}
                <div className="w-[340px] flex-shrink-0 flex flex-col bg-slate-900 border border-slate-800 rounded-xl shadow-md overflow-hidden">
                    <div className="p-4 border-b border-slate-800 bg-slate-800/30">
                        <h3 className="font-bold text-slate-300 text-sm uppercase tracking-wide">Folders</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 space-y-1">
                        {role === UserRole.REVIEWER && (
                            <>
                                <button
                                    onClick={() => setSelectedFolder(ALL_FOLDERS_VIEW)}
                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-1 ${selectedFolder === ALL_FOLDERS_VIEW
                                        ? 'bg-purple-900/30 text-purple-200 border border-purple-700/50 shadow-sm'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                                    Overview Dashboard
                                </button>

                                {accountType === AccountType.ADMIN && (
                                    <>
                                        <button
                                            onClick={() => setSelectedFolder(USER_MANAGEMENT_VIEW)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-1 ${selectedFolder === USER_MANAGEMENT_VIEW
                                                ? 'bg-orange-900/30 text-orange-200 border border-orange-700/50 shadow-sm'
                                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                                }`}
                                        >
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                            User Management
                                        </button>

                                        <button
                                            onClick={() => setSelectedFolder(WORKER_REPORT_VIEW)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-3 ${(selectedFolder === WORKER_REPORT_VIEW || selectedFolder === WEEKLY_REPORT_VIEW || selectedFolder === DAILY_REPORT_VIEW)
                                                ? 'bg-blue-900/30 text-blue-200 border border-blue-700/50 shadow-sm'
                                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                                }`}
                                        >
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2a4 4 0 00-4-4H5m11 0h.01M16 21h4a2 2 0 002-2v-9a2 2 0 00-2-2H6a2 2 0 00-2 2v1h2m10-4V7a2 2 0 00-2-2H8a2 2 0 00-2 2v2m4 6h.01" /></svg>
                                            Reports
                                        </button>

                                        <button
                                            onClick={() => setSelectedFolder(SCHEDULE_VIEW)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-3 ${selectedFolder === SCHEDULE_VIEW
                                                ? 'bg-violet-900/30 text-violet-200 border border-violet-700/50 shadow-sm'
                                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                                }`}
                                        >
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                            Schedule
                                        </button>

                                        <button
                                            onClick={() => setSelectedFolder(ISSUE_REQUEST_VIEW)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-base font-bold transition-all mb-3 ${selectedFolder === ISSUE_REQUEST_VIEW
                                                ? 'bg-rose-900/30 text-rose-200 border border-rose-700/50 shadow-sm'
                                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                                }`}
                                        >
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l6.518 11.593c.75 1.334-.213 2.998-1.742 2.998H3.48c-1.53 0-2.492-1.664-1.743-2.998L8.257 3.1z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01" /></svg>
                                            Issue Requests
                                        </button>
                                    </>
                                )}
                            </>
                        )}

                        <div className="space-y-4">
                            {/* Groups */}
                            {Object.entries(groupedSidebarFolders.groups).map(([groupName, folders]) => (
                                <div key={groupName} className="space-y-1">
                                    <button
                                        onClick={() => {
                                            const newSet = new Set(sidebarCollapsedGroups);
                                            if (newSet.has(groupName)) newSet.delete(groupName);
                                            else newSet.add(groupName);
                                            setSidebarCollapsedGroups(newSet);
                                        }}
                                        className="w-full flex items-center gap-2 px-2 py-1 text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-slate-300 transition-colors"
                                    >
                                        <svg className={`w-3 h-3 transition-transform ${sidebarCollapsedGroups.has(groupName) ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                        {groupName}
                                        <span className="ml-auto bg-slate-800 px-1.5 py-0.5 rounded text-[8px]">{folders.length}</span>
                                    </button>
                                    {!sidebarCollapsedGroups.has(groupName) && (
                                        <div className="space-y-1 ml-2 border-l border-slate-800 pl-2">
                                            {folders.map(folder => (
                                                <button
                                                    key={folder.name}
                                                    onClick={() => setSelectedFolder(folder.name)}
                                                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all group ${selectedFolder === folder.name
                                                        ? 'bg-sky-900/20 text-sky-300 border border-sky-800/50 shadow-sm'
                                                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-transparent'
                                                        }`}
                                                >
                                                    <span className="truncate">{folder.name}</span>
                                                    <span className="text-[10px] opacity-50">{folder.count}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}

                            {/* Uncategorized */}
                            {groupedSidebarFolders.uncategorized.length > 0 && (
                                <div className="space-y-1">
                                    {Object.keys(groupedSidebarFolders.groups).length > 0 && (
                                        <div className="px-2 py-1 text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                                            Uncategorized
                                        </div>
                                    )}
                                    {groupedSidebarFolders.uncategorized.map(folder => (
                                        <button
                                            key={folder.name}
                                            onClick={() => setSelectedFolder(folder.name)}
                                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all group ${selectedFolder === folder.name
                                                ? 'bg-sky-900/20 text-sky-300 border border-sky-800/50 shadow-sm'
                                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-transparent'
                                                }`}
                                        >
                                            <span className="flex items-center gap-3 truncate">
                                                <svg className={`w-4 h-4 ${selectedFolder === folder.name ? 'text-sky-500' : 'text-slate-600 group-hover:text-slate-400'}`} fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>
                                                <span className="truncate">{folder.name}</span>
                                            </span>
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${selectedFolder === folder.name ? 'bg-sky-900 text-sky-200' : 'bg-slate-800 text-slate-500'}`}>
                                                {folder.count}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Center Content: Task List */}
                <div className="flex-1 bg-slate-900 border border-slate-800 rounded-xl shadow-md overflow-hidden flex flex-col relative min-w-0">

                    {/* --- ADMIN VIEWS & FOLDER MODES --- */}
                    {selectedFolder === USER_MANAGEMENT_VIEW && accountType === AccountType.ADMIN ? (
                        <UserManagementView token={token} />
                    ) : (selectedFolder === WORKER_REPORT_VIEW || selectedFolder === WEEKLY_REPORT_VIEW || selectedFolder === DAILY_REPORT_VIEW) && accountType === AccountType.ADMIN ? (
                        <UnifiedReportsView tasks={tasks} validWorkers={workers} onOpenSchedule={() => setSelectedFolder(SCHEDULE_VIEW)} />
                    ) : selectedFolder === ISSUE_REQUEST_VIEW && accountType === AccountType.ADMIN ? (
                        <IssueRequestView currentAdmin={username} />
                    ) : selectedFolder === SCHEDULE_VIEW && accountType === AccountType.ADMIN ? (
                        <ScheduleManagementView validWorkers={workers} />
                    ) : selectedFolder === ALL_FOLDERS_VIEW && role === UserRole.REVIEWER ? (
                        <div className="flex flex-col h-full">
                            <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-sky-400 to-lime-400">프로젝트 할당 및 현황</h2>
                                    <span className="text-xs bg-purple-900/40 text-purple-300 px-2 py-0.5 rounded border border-purple-800/50">관리자용</span>
                                </div>
                                <button
                                    onClick={handleSync}
                                    disabled={isSyncing}
                                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow active:scale-[0.98] disabled:opacity-50"
                                >
                                    {isSyncing ? (
                                        <svg className="animate-spin h-4 w-4 text-sky-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                    ) : (
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                    )}
                                    Sync Data
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-6 min-h-0 pb-32">
                                <div className="w-full">
                                    {/* Render Groups */}
                                    {Object.entries(groupedSidebarFolders.groups).map(([groupName, folders]) => (
                                        <div key={groupName} className="mb-6">
                                            <button
                                                onClick={() => toggleTableGroup(groupName)}
                                                className="flex items-center gap-2 mb-2 px-2 hover:bg-slate-800/50 p-1 rounded transition-colors w-full text-left"
                                            >
                                                <svg className={`w-3 h-3 text-slate-500 transition-transform ${collapsedTableGroups.has(groupName) ? '-rotate-90' : 'rotate-0'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">{groupName}</span>
                                                <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{folders.length}</span>
                                            </button>

                                            {!collapsedTableGroups.has(groupName) && (
                                                <div className="bg-slate-800/20 border border-slate-800 rounded-xl overflow-hidden">
                                                    <table className="w-full text-left text-sm table-fixed">
                                                        <thead className="bg-slate-900/50 text-slate-500 text-xs font-bold uppercase tracking-wider border-b border-slate-800">
                                                            <tr className="h-10 align-middle">
                                                                <th className="pl-4 w-[5%] min-w-[40px]">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={folders.every(f => selectedFolders.has(f.name))}
                                                                        onChange={() => toggleSelectGroup(folders)}
                                                                        className="rounded border-slate-700 bg-slate-800 text-sky-600 focus:ring-sky-500/50"
                                                                    />
                                                                </th>
                                                                <th className="pl-2 w-[23%]">Folder Name</th>
                                                                <th className="w-[12%]">Group</th>
                                                                <th className="w-[23%]">Tags</th>
                                                                <th className="w-[15%]">Progress</th>
                                                                <th className="w-[10%] text-center">Stats</th>
                                                                <th className="w-[12%]">Worker</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-800">
                                                            {folders.map(folder => (
                                                                <FolderRow
                                                                    key={folder.name}
                                                                    folder={folder}
                                                                    groups={groups}
                                                                    allFolderMeta={allFolderMeta}
                                                                    onUpdateGroup={handleUpdateGroupMain}
                                                                    onUpdateTags={handleUpdateFolderTags}
                                                                    onAssignWorker={handleAssignWorker}
                                                                    workers={workers}
                                                                    onSelectFolder={setSelectedFolder}
                                                                    isSelected={selectedFolders.has(folder.name)}
                                                                    onToggleSelect={toggleSelectFolder}
                                                                />
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    ))}

                                    {/* Render Uncategorized */}
                                    {groupedSidebarFolders.uncategorized.length > 0 && (
                                        <div className="mb-6">
                                            <div className="flex items-center gap-2 mb-2 px-2">
                                                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Uncategorized</span>
                                                <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{groupedSidebarFolders.uncategorized.length}</span>
                                            </div>
                                            <div className="bg-slate-800/20 border border-slate-800 rounded-xl overflow-hidden">
                                                <table className="w-full text-left text-sm table-fixed">
                                                    <thead className="bg-slate-900/50 text-slate-500 text-xs font-bold uppercase tracking-wider border-b border-slate-800">
                                                        <tr className="h-10 align-middle">
                                                            <th className="pl-4 w-[5%] min-w-[40px]">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={groupedSidebarFolders.uncategorized.every(f => selectedFolders.has(f.name))}
                                                                    onChange={() => toggleSelectGroup(groupedSidebarFolders.uncategorized)}
                                                                    className="rounded border-slate-700 bg-slate-800 text-sky-600 focus:ring-sky-500/50"
                                                                />
                                                            </th>
                                                            <th className="pl-2 w-[23%]">Folder Name</th>
                                                            <th className="w-[12%]">Group</th>
                                                            <th className="w-[23%]">Tags</th>
                                                            <th className="w-[15%]">Progress</th>
                                                            <th className="w-[10%] text-center">Stats</th>
                                                            <th className="w-[12%]">Worker</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-slate-800">
                                                        {groupedSidebarFolders.uncategorized.map(folder => (
                                                            <FolderRow
                                                                key={folder.name}
                                                                folder={folder}
                                                                groups={groups}
                                                                allFolderMeta={allFolderMeta}
                                                                onUpdateGroup={handleUpdateGroupMain}
                                                                onUpdateTags={handleUpdateFolderTags}
                                                                onAssignWorker={handleAssignWorker}
                                                                workers={workers}
                                                                onSelectFolder={setSelectedFolder}
                                                                isSelected={selectedFolders.has(folder.name)}
                                                                onToggleSelect={toggleSelectFolder}
                                                            />
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Bulk Actions Toolbar */}
                            {selectedFolders.size > 0 && (
                                <div className="absolute bottom-14 left-1/2 transform -translate-x-1/2 bg-slate-900/95 backdrop-blur-sm border border-slate-700 shadow-2xl rounded-xl px-6 py-4 flex items-center gap-6 z-50 animate-in fade-in slide-in-from-bottom-4 min-w-[600px]">
                                    <div className="flex items-center gap-2 text-white font-bold whitespace-nowrap">
                                        <div className="w-6 h-6 rounded-full bg-sky-600 flex items-center justify-center text-xs">
                                            {selectedFolders.size}
                                        </div>
                                        <span>Selected</span>
                                    </div>
                                    <div className="h-8 w-px bg-slate-700"></div>

                                    {/* Action: Group */}
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-slate-500 font-bold uppercase">Assign Group</label>
                                        <select
                                            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                                            onChange={(e) => handleBulkUpdateGroup(e.target.value)}
                                            value=""
                                        >
                                            <option value="" disabled>Select Group...</option>
                                            {Object.keys(groupedSidebarFolders.groups).map(g => (
                                                <option key={g} value={g}>{g}</option>
                                            ))}
                                            <option value="__NEW_GROUP__" className="text-sky-400">+ New Group</option>
                                        </select>
                                    </div>

                                    {/* Action: Tag */}
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-slate-500 font-bold uppercase">Add Tag</label>
                                        <input
                                            type="text"
                                            placeholder="Type & Enter..."
                                            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white w-32"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    handleBulkUpdateTags(e.currentTarget.value);
                                                    e.currentTarget.value = '';
                                                }
                                            }}
                                        />
                                    </div>

                                    {/* Action: Worker (Movement) */}
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Transfer Folder</label>
                                        <select
                                            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                                            onChange={(e) => handleBulkAssignWorker(e.target.value)}
                                            value=""
                                        >
                                            <option value="" disabled>Select Worker...</option>
                                            <option value="Unassigned">Unassigned</option>
                                            {workers.map(w => (
                                                <option key={w} value={w}>{w}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex-1"></div>
                                    <button
                                        onClick={() => setSelectedFolders(new Set())}
                                        className="text-slate-500 hover:text-white transition-colors"
                                    >
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        // --- FOLDER DETAIL MODE ---
                        selectedFolder ? (
                            <>
                                {/* Header */}
                                <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/30 flex justify-between items-center flex-shrink-0">
                                    <div>
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

                                {/* Guidelines Panel */}
                                <div className={`px-6 py-5 border-b border-slate-800 transition-colors ${role === UserRole.WORKER ? 'bg-sky-900/5' : ''}`}>
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
                                            <div className="grid grid-cols-2 gap-4">
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
                                                <div>
                                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Group</label>
                                                    <input
                                                        type="text"
                                                        value={tempGroup}
                                                        onChange={(e) => setTempGroup(e.target.value)}
                                                        placeholder="Enter group name..."
                                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-sky-500 outline-none"
                                                    />
                                                </div>
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
                                                        const folderTasks = tasks.filter(t => t.folder === selectedFolder);
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
                                <div className="px-6 pt-4 pb-4 flex gap-2">
                                    <button
                                        onClick={() => {
                                            const folderTasks = tasks.filter(t => t.folder === selectedFolder);
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
                                    <div className="p-6 border-b border-slate-800 grid grid-cols-4 gap-4">
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
                                                        <div className="w-14 h-14 bg-black rounded-lg overflow-hidden flex-shrink-0 relative border border-slate-800 group-hover:border-slate-600 transition-colors">
                                                            <img src={task.imageUrl} alt="" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                                                            {(task.annotations || []).length > 0 && (
                                                                <div className="absolute bottom-0 right-0 bg-black/80 text-[10px] font-bold text-white px-1.5 py-0.5 rounded-tl">
                                                                    {(task.annotations || []).length}
                                                                </div>
                                                            )}
                                                        </div>
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
                {/* Right Panel: Notice Board */}
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

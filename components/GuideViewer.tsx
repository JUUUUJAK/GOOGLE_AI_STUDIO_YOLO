import React, { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

// Core worker for PDF rendering (required for react-pdf)
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
).toString();

interface GuideViewerProps {
    pdfUrl: string;
    onClose: () => void;
}

export const GuideViewer: React.FC<GuideViewerProps> = ({ pdfUrl, onClose }) => {
    const [numPages, setNumPages] = useState<number | null>(null);
    const [pageNumber, setPageNumber] = useState(1);

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
    };

    const goToPrevPage = () => setPageNumber(prev => Math.max(prev - 1, 1));
    const goToNextPage = () => setPageNumber(prev => numPages ? Math.min(prev + 1, numPages) : prev);

    // Keyboard navigation
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') goToPrevPage();
            if (e.key === 'ArrowRight') goToNextPage();
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [pageNumber, numPages]);

    return (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col items-center justify-center p-4">
            {/* Header / Controls */}
            <div className="w-full max-w-5xl flex justify-between items-center mb-4 text-white">
                <h2 className="text-xl font-bold flex items-center gap-2">
                    <span className="bg-sky-600 p-1 rounded">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                    </span>
                    Worker Guide
                </h2>
                <div className="flex items-center gap-4 bg-slate-800 rounded-full px-4 py-2 border border-slate-600">
                    <button
                        onClick={goToPrevPage}
                        disabled={pageNumber <= 1}
                        className="p-1 hover:text-sky-400 disabled:opacity-30 transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    </button>
                    <span className="font-mono font-bold text-lg min-w-[3rem] text-center">
                        {pageNumber} <span className="text-slate-500 text-sm">/ {numPages || '--'}</span>
                    </span>
                    <button
                        onClick={goToNextPage}
                        disabled={numPages ? pageNumber >= numPages : true}
                        className="p-1 hover:text-sky-400 disabled:opacity-30 transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </button>
                </div>
                <button
                    onClick={onClose}
                    className="p-2 hover:bg-white/10 rounded-full transition-colors"
                    title="Close (Esc)"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
            </div>

            {/* PDF Canvas */}
            <div className="flex-1 w-full max-w-[95vw] flex items-center justify-center overflow-hidden relative shadow-2xl">
                <Document
                    file={pdfUrl}
                    onLoadSuccess={onDocumentLoadSuccess}
                    className="flex justify-center"
                    loading={
                        <div className="flex flex-col items-center gap-4 text-white">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div>
                            <p className="animate-pulse">Loading Guide...</p>
                        </div>
                    }
                    error={
                        <div className="text-center text-red-400 bg-slate-800 p-8 rounded-xl border border-red-500/30">
                            <p className="text-xl font-bold mb-2">Failed to load guide</p>
                            <p className="text-sm opacity-80">Please ensure 'Worker_Guide_v1.pdf' exists in 'public/guides/'</p>
                        </div>
                    }
                >
                    <Page
                        pageNumber={pageNumber}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        className="shadow-2xl rounded-lg overflow-hidden border border-slate-700"
                        height={window.innerHeight * 0.85}
                    />
                </Document>
            </div>

            <div className="text-slate-500 text-xs mt-4">
                Use <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">←</kbd> <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">→</kbd> arrows to navigate
            </div>
        </div>
    );
};

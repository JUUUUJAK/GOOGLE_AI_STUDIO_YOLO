import React, { useEffect } from 'react';

export interface FirstTimeGuideModalProps {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}

export const FirstTimeGuideModal: React.FC<FirstTimeGuideModalProps> = ({ title, onClose, children }) => {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
                <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-slate-700">
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                        <span className="bg-sky-600/80 p-1.5 rounded">
                            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                        </span>
                        {title}
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
                        title="닫기 (Esc)"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 text-slate-300 text-sm leading-relaxed space-y-4">
                    {children}
                </div>
                <div className="flex-shrink-0 px-6 py-4 border-t border-slate-700 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium transition-colors"
                    >
                        확인
                    </button>
                </div>
            </div>
        </div>
    );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <section>
        <h3 className="text-slate-100 font-semibold mb-2">{title}</h3>
        <div className="space-y-1.5">{children}</div>
    </section>
);

const Bullet: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="flex gap-2"><span className="text-sky-400">•</span><span>{children}</span></p>
);

export const AdminGuideContent: React.FC = () => (
    <>
        <p className="text-slate-400 text-xs mb-2">관리자 계정으로 처음 사용하시는 경우 아래 순서를 참고하세요.</p>
        <Section title="1. 프로젝트 생성">
            <Bullet>대시보드에서 <strong>프로젝트</strong> 탭으로 이동합니다.</Bullet>
            <Bullet>프로젝트 이름, 작업 방식(YOLO / VLM 검수)을 선택하고 생성합니다.</Bullet>
            <Bullet>VLM 검수 프로젝트인 경우 <strong>원본 JSON 파일</strong>을 선택해야 합니다.</Bullet>
        </Section>
        <Section title="2. 데이터 동기화 (YOLO 작업 시)">
            <Bullet>이미지·라벨은 <strong>프로젝트 폴더</strong> 중심으로 <strong>datasets</strong> 아래에 둡니다 (작업자명 상위 폴더에 의존하지 않음).</Bullet>
            <Bullet>디스크 → DB 반영은 <strong>프로젝트 상세</strong>에서 해당 프로젝트만 동기화하거나, 폴더 행의 동기화를 사용합니다.</Bullet>
            <Bullet>상단 <strong>DB 새로고침</strong>은 목록만 갱신합니다. 전체 디스크 스캔은 별도 버튼이며 느릴 수 있습니다.</Bullet>
        </Section>
        <Section title="3. 작업 배정">
            <Bullet><strong>YOLO</strong>: 프로젝트 상세 → 폴더 진행 현황에서 폴더별로 작업자를 배정합니다.</Bullet>
            <Bullet><strong>VLM</strong>: 프로젝트별로 <strong>VLM 배분</strong> 버튼으로 작업자에게 건수 단위 배분합니다.</Bullet>
        </Section>
        <Section title="4. 검수">
            <Bullet>VLM 프로젝트는 <strong>작업자별 진행 현황</strong>에서 각 작업자 행의 <strong>검수 (N)</strong> 버튼으로 제출된 작업을 검수합니다.</Bullet>
            <Bullet>수용/거절 선택 후 저장하면 해당 작업이 완료(또는 반려) 처리됩니다.</Bullet>
        </Section>
        <Section title="기타">
            <Bullet>상단 <strong>Guide</strong> 메뉴에서 프로젝트별 PDF 가이드를 볼 수 있습니다.</Bullet>
        </Section>
    </>
);

export const WorkerGuideContent: React.FC = () => (
    <>
        <p className="text-slate-400 text-xs mb-2">작업자 계정으로 처음 사용하시는 경우 아래 순서를 참고하세요.</p>
        <Section title="1. 작업 목록 확인">
            <Bullet>로그인 후 <strong>대시보드</strong>에서 자신에게 배정된 프로젝트·폴더를 확인합니다.</Bullet>
            <Bullet>프로젝트를 선택한 뒤, 작업할 폴더(또는 VLM 작업 목록)를 클릭합니다.</Bullet>
        </Section>
        <Section title="2. YOLO 작업 (바운딩 박스)">
            <Bullet>이미지를 클릭해 작업 화면으로 들어갑니다.</Bullet>
            <Bullet>클래스 선택 후 이미지 위에 박스를 그리거나, 기존 라벨을 수정합니다.</Bullet>
            <Bullet><strong>저장</strong>으로 진행 상황을 남기고, 모두 완료 후 <strong>제출</strong>합니다.</Bullet>
        </Section>
        <Section title="3. VLM 작업 (수용/거절 검수)">
            <Bullet>이미지와 GPT 응답을 확인한 뒤, <strong>수용</strong> 또는 <strong>수정 필요</strong> 등으로 판단합니다.</Bullet>
            <Bullet>수정이 필요한 경우 응답 수정란에 내용을 입력하고 저장합니다.</Bullet>
            <Bullet>작업이 끝나면 <strong>제출</strong>하여 검수 대기 상태로 올립니다.</Bullet>
        </Section>
        <Section title="기타">
            <Bullet>상단 <strong>Guide</strong> 메뉴에서 프로젝트별 PDF 가이드를 볼 수 있습니다.</Bullet>
        </Section>
    </>
);

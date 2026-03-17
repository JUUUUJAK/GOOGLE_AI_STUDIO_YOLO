import { PluginContract, PluginSourceType, Task, TaskStatus } from '../../types';

const nativeYoloContract: PluginContract = {
  task: {
    sourceType: 'native-yolo',
    toCommonStatus: (input: string | number) => {
      const normalized = String(input || '').toUpperCase();
      if (normalized === TaskStatus.IN_PROGRESS) return TaskStatus.IN_PROGRESS;
      if (normalized === TaskStatus.SUBMITTED) return TaskStatus.SUBMITTED;
      if (normalized === TaskStatus.APPROVED) return TaskStatus.APPROVED;
      if (normalized === TaskStatus.REJECTED) return TaskStatus.REJECTED;
      return TaskStatus.TODO;
    },
    toSourceStatus: (status: TaskStatus) => status
  },
  review: {
    sourceType: 'native-yolo',
    canReview: (_task: Task) => true,
    normalizeReviewerNote: (note: string) => String(note || '').trim()
  },
  report: {
    sourceType: 'native-yolo',
    includeInUnifiedReport: true
  }
};

const vlmReviewContract: PluginContract = {
  task: {
    sourceType: 'vlm-review',
    toCommonStatus: (input: string | number) => {
      const normalized = String(input || '').toLowerCase();
      if (normalized === 'validated' || normalized === '9' || normalized === '0') return TaskStatus.APPROVED;
      if (normalized === 'worked' || normalized === '8' || normalized === '1' || normalized === '2') return TaskStatus.SUBMITTED;
      if (normalized === 'assigned') return TaskStatus.IN_PROGRESS;
      return TaskStatus.TODO;
    },
    toSourceStatus: (status: TaskStatus) => {
      if (status === TaskStatus.APPROVED) return 'validated';
      if (status === TaskStatus.SUBMITTED || status === TaskStatus.REJECTED) return 'worked';
      if (status === TaskStatus.IN_PROGRESS) return 'assigned';
      return 'assigned';
    }
  },
  review: {
    sourceType: 'vlm-review',
    canReview: (_task: Task) => true,
    normalizeReviewerNote: (note: string) => String(note || '').trim()
  },
  report: {
    sourceType: 'vlm-review',
    includeInUnifiedReport: true
  }
};

const contractsBySourceType: Record<PluginSourceType, PluginContract> = {
  'native-yolo': nativeYoloContract,
  'vlm-review': vlmReviewContract
};

export const getPluginContract = (sourceType?: PluginSourceType): PluginContract => {
  const resolved = sourceType || 'native-yolo';
  return contractsBySourceType[resolved] || nativeYoloContract;
};

export const listPluginContracts = (): PluginContract[] => {
  return Object.values(contractsBySourceType);
};

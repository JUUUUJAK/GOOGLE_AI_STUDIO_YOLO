import { YoloClass } from './types';

// Standard Color Palette for auto-assigning colors to classes
export const COLOR_PALETTE = [
  '#3b82f6', // blue-500
  '#ef4444', // red-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#84cc16', // lime-500
  '#f43f5e', // rose-500
  '#6366f1', // indigo-500
  '#14b8a6', // teal-500
  '#d946ef', // fuchsia-500
  '#f97316', // orange-500
  '#a855f7', // purple-500
  '#0ea5e9', // sky-500
];

// Mocking the content of text files in a "classes/" folder
export const MOCK_LABEL_FILES: Record<string, string> = {
  'labels_default.txt': "person\ncar\nbicycle\ndog\ncat\ntraffic_light",
  'labels_construction.txt': "hard_hat\nsafety_vest\nboots\nheavy_machinery\nworker",
  'labels_traffic.txt': "car\nbus\ntruck\nmotorcycle\ntraffic_light\nstop_sign\nspeed_limit\ncrosswalk",
  'labels_fruits.txt': "apple\nbanana\norange\ngrape\npineapple"
};

export const YOLO_CLASSES: YoloClass[] = [
  { id: 0, name: 'person', color: '#3b82f6' }, 
  { id: 1, name: 'car', color: '#ef4444' }, 
  { id: 2, name: 'bicycle', color: '#10b981' }, 
  { id: 3, name: 'dog', color: '#f59e0b' }, 
  { id: 4, name: 'cat', color: '#8b5cf6' }, 
  { id: 5, name: 'traffic_light', color: '#ec4899' }, 
];

// Mock images simulating a mounted network drive
// Path convention: /mnt/data/dataset_v1/[folder]/[filename]
export const MOCK_TASKS_DATA = [
  {
    id: 'task_001',
    imageUrl: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=1000&q=80',
    name: 'street_01.jpg',
    folder: 'batch_2023_10_01',
  },
  {
    id: 'task_002',
    imageUrl: 'https://images.unsplash.com/photo-1541443131876-44b03de101c5?auto=format&fit=crop&w=1000&q=80',
    name: 'pedestrians_02.jpg',
    folder: 'batch_2023_10_01',
  },
  {
    id: 'task_003',
    imageUrl: 'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1000&q=80',
    name: 'cycling_03.jpg',
    folder: 'batch_2023_10_01',
  },
  {
    id: 'task_004',
    imageUrl: 'https://images.unsplash.com/photo-1534361960057-19889db9621e?auto=format&fit=crop&w=1000&q=80',
    name: 'puppy_dog.jpg',
    folder: 'batch_2023_10_02',
  },
  {
    id: 'task_005',
    imageUrl: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=1000&q=80',
    name: 'cat_indoor.jpg',
    folder: 'batch_2023_10_02',
  },
  {
    id: 'task_006',
    imageUrl: 'https://images.unsplash.com/photo-1570125909232-eb2be3b11374?auto=format&fit=crop&w=1000&q=80',
    name: 'misc_object.jpg',
    folder: 'batch_validation',
  },
];
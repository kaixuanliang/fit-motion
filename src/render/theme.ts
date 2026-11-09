export type ThemeId = 'bright' | 'night' | 'tech';
export type Rgb = [number, number, number];

export interface VideoTheme {
  id: ThemeId;
  label: string;
  stageBg: string;
  text: string;
  muted: string;
  faint: string;
  glass: string;
  glassStrong: string;
  border: string;
  shadow: string;
  accent: string;
  accent2: string;
  red: string;
  orange: string;
  blue: string;
  route: [string, string, string, string];
  ecg: string;
  grid: string;
  map: {
    background: Rgb;
    water: Rgb;
    park: Rgb;
    building: Rgb;
    roadEdge: Rgb;
    road: Rgb;
    transit: Rgb;
    /** Overview palette, kept in sync with NativeVectorMap's per-theme table. */
    roadMajor: Rgb;
    roadPrimary: Rgb;
    roadMinor: Rgb;
    national: Rgb;
    label: string;
    labelHalo: string;
  };
  art: {
    bg1: string;
    bg2: string;
    water: string;
    glow: string;
    grid: string;
    block: string;
    blockStroke: string;
    park: string;
    contour: string;
  };
}

export const THEMES: Record<ThemeId, VideoTheme> = {
  bright: {
    id: 'bright',
    label: '明亮',
    stageBg: '#eef2e8',
    text: '#122923',
    muted: 'rgba(19, 47, 41, 0.64)',
    faint: 'rgba(19, 47, 41, 0.38)',
    glass: 'rgba(255, 255, 255, 0.62)',
    glassStrong: 'rgba(255, 255, 255, 0.78)',
    border: 'rgba(255, 255, 255, 0.94)',
    shadow: 'rgba(24, 64, 55, 0.24)',
    accent: '#0f9f86',
    accent2: '#0c9caf',
    red: '#dc5555',
    orange: '#d9861b',
    blue: '#2f7fbf',
    route: ['#0b9db3', '#0f9273', '#d78b18', '#d94f4f'],
    ecg: '#22c993',
    grid: 'rgba(19, 47, 41, 0.12)',
    map: {
      background: [244, 242, 231],
      water: [148, 217, 234],
      park: [183, 228, 158],
      building: [232, 226, 210],
      roadEdge: [255, 255, 250],
      road: [152, 170, 162],
      transit: [104, 166, 202],
      roadMajor: [217, 159, 83],
      roadPrimary: [196, 169, 122],
      roadMinor: [176, 189, 182],
      national: [232, 148, 10],
      label: '#3f5a50',
      labelHalo: '#f8f5ea',
    },
    art: {
      bg1: '#faf8f0',
      bg2: '#e9f4ee',
      water: 'rgba(122, 208, 226, 0.48)',
      glow: 'rgba(155, 212, 186, 0.28)',
      grid: 'rgba(134, 163, 154, 0.2)',
      block: 'rgba(246, 224, 194, 0.58)',
      blockStroke: 'rgba(168, 144, 112, 0.18)',
      park: 'rgba(133, 205, 148, 0.32)',
      contour: 'rgba(86, 168, 145, 0.12)',
    },
  },
  night: {
    id: 'night',
    label: '夜间',
    stageBg: '#081224',
    text: '#eef6ff',
    muted: 'rgba(219, 235, 255, 0.66)',
    faint: 'rgba(219, 235, 255, 0.34)',
    glass: 'rgba(12, 27, 49, 0.58)',
    glassStrong: 'rgba(14, 31, 55, 0.76)',
    border: 'rgba(124, 197, 255, 0.42)',
    shadow: 'rgba(0, 5, 18, 0.48)',
    accent: '#4de3ff',
    accent2: '#4ef0b5',
    red: '#ff7080',
    orange: '#ffc857',
    blue: '#7daeff',
    route: ['#39ddff', '#4df0b0', '#ffc857', '#ff6b7a'],
    ecg: '#65e36e',
    grid: 'rgba(124, 197, 255, 0.16)',
    map: {
      background: [10, 20, 37],
      water: [18, 55, 79],
      park: [18, 56, 49],
      building: [24, 36, 55],
      roadEdge: [18, 33, 50],
      road: [150, 170, 195],
      transit: [82, 178, 255],
      roadMajor: [199, 180, 142],
      roadPrimary: [160, 143, 116],
      roadMinor: [100, 122, 144],
      national: [255, 193, 90],
      label: '#d8e8fa',
      labelHalo: '#0a1425',
    },
    art: {
      bg1: '#0a1426',
      bg2: '#0a1b2c',
      water: 'rgba(35, 111, 146, 0.42)',
      glow: 'rgba(46, 124, 168, 0.22)',
      grid: 'rgba(98, 160, 205, 0.15)',
      block: 'rgba(73, 126, 170, 0.22)',
      blockStroke: 'rgba(108, 170, 216, 0.22)',
      park: 'rgba(44, 129, 104, 0.3)',
      contour: 'rgba(74, 163, 176, 0.12)',
    },
  },
  tech: {
    id: 'tech',
    label: '科技',
    stageBg: '#041a22',
    text: '#eaffff',
    muted: 'rgba(190, 255, 245, 0.64)',
    faint: 'rgba(190, 255, 245, 0.34)',
    glass: 'rgba(5, 35, 42, 0.58)',
    glassStrong: 'rgba(6, 40, 48, 0.76)',
    border: 'rgba(0, 255, 210, 0.38)',
    shadow: 'rgba(0, 10, 14, 0.5)',
    accent: '#00f0d0',
    accent2: '#00c8ff',
    red: '#ff5c86',
    orange: '#ffd166',
    blue: '#65d9ff',
    route: ['#00e5ff', '#00ffa3', '#ffd166', '#ff5c86'],
    ecg: '#00f0d0',
    grid: 'rgba(0, 255, 210, 0.16)',
    map: {
      background: [5, 24, 32],
      water: [10, 55, 70],
      park: [12, 48, 44],
      building: [14, 38, 48],
      roadEdge: [4, 28, 36],
      road: [100, 180, 182],
      transit: [0, 220, 200],
      roadMajor: [194, 162, 108],
      roadPrimary: [156, 133, 96],
      roadMinor: [62, 116, 118],
      national: [255, 182, 72],
      label: '#d2f6ee',
      labelHalo: '#051820',
    },
    art: {
      bg1: '#061a22',
      bg2: '#08242a',
      water: 'rgba(18, 112, 128, 0.4)',
      glow: 'rgba(0, 180, 160, 0.14)',
      grid: 'rgba(0, 220, 200, 0.18)',
      block: 'rgba(0, 151, 151, 0.2)',
      blockStroke: 'rgba(0, 220, 200, 0.24)',
      park: 'rgba(22, 130, 92, 0.26)',
      contour: 'rgba(0, 200, 180, 0.12)',
    },
  },
};

export function isThemeId(value: string | null): value is ThemeId {
  return value === 'bright' || value === 'night' || value === 'tech';
}

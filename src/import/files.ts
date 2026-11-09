/**
 * 导入管线：把一个 File 变成可以入库的 ParsedFit。
 *
 * 三种设备文件（FIT / GPX / TCX）共用同一条归一化路径，之后的去重、
 * 缩略图、入库、备份都只看结果，不看来源。
 */

import { parseFit } from '../fit/parser';
import { parseGpx } from '../gpx/parser';
import { parseTcx } from '../tcx/parser';
import type { ParsedFit } from '../fit/types';
import type { SourceKind } from '../store/types';

export const MAX_FILE_BYTES = 80 * 1024 * 1024;

export function detectKind(fileName: string): SourceKind | null {
  if (/\.fit$/i.test(fileName)) return 'fit';
  if (/\.gpx$/i.test(fileName)) return 'gpx';
  if (/\.tcx$/i.test(fileName)) return 'tcx';
  if (/\.json$/i.test(fileName)) return 'huawei';
  return null;
}

export interface LoadedFile {
  parsed: ParsedFit;
  kind: SourceKind;
  bytes: ArrayBuffer;
}

export async function readActivityFile(file: File): Promise<LoadedFile> {
  if (file.size === 0) throw new Error('文件是空的，请选择有效的 FIT / GPX / TCX 文件');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 80 MB，暂不支持');
  const kind = detectKind(file.name);
  if (!kind) throw new Error('请选择扩展名为 .fit、.gpx 或 .tcx 的文件');

  if (kind === 'fit') {
    const bytes = await file.arrayBuffer();
    return { parsed: parseFit(bytes), kind, bytes };
  }
  if (kind === 'gpx') {
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(bytes);
    return { parsed: parseGpx(text, file.name), kind, bytes };
  }
  if (kind === 'tcx') {
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(bytes);
    return { parsed: parseTcx(text, file.name), kind, bytes };
  }
  throw new Error('JSON 需要用「华为运动健康」入口导入');
}

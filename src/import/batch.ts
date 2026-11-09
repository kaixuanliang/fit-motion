/**
 * 批量导入：把选中的文件/华为 JSON 变成一串 ImportResult。
 *
 * 一条失败不影响其余，导入过程中通过 onProgress 报进度——华为导出可能
 * 一次几百条运动，不能白屏等。
 *
 * 最小距离阈值在这里统一拦截：低于阈值的文件/活动不解析入库，
 * 免得几百条通勤把记录库塞满。
 */

import type { ImportResult } from '../store/types';
import { saveParsed } from '../store/repo';
import { hashBytes } from '../store/fingerprint';
import { readActivityFile } from './files';
import { parseHuaweiJson } from './huawei';

export interface ImportProgress {
  /** 已处理 / 总数 */
  done: number;
  total: number;
  label: string;
}

export interface ImportOptions {
  /** 小于这个距离（米）的记录不导入，0 表示不限制 */
  minDistanceM?: number;
}

export interface ImportOutcome {
  results: ImportResult[];
  added: number;
  duplicated: number;
  filtered: number;
  failed: number;
}

function tooShort(result: { name: string; distance?: number }, minDistanceM: number): ImportResult | null {
  if (minDistanceM <= 0) return null;
  const distance = result.distance ?? 0;
  if (!(distance > 0) || distance >= minDistanceM) return null;
  return {
    status: 'too-short',
    name: result.name,
    message: `距离 ${(distance / 1000).toFixed(2)} km，低于设定的 ${(minDistanceM / 1000).toFixed(1)} km`,
  };
}

export async function importFiles(
  files: File[],
  onProgress?: (progress: ImportProgress) => void,
  options: ImportOptions = {},
): Promise<ImportOutcome> {
  const minDistanceM = options.minDistanceM ?? 0;
  const results: ImportResult[] = [];
  let index = 0;
  for (const file of files) {
    index += 1;
    onProgress?.({ done: index - 1, total: files.length, label: file.name });
    try {
      if (/\.json$/i.test(file.name)) {
        const text = await file.text();
        const parsed = parseHuaweiJson(text);
        let sub = 0;
        for (const activity of parsed.activities) {
          sub += 1;
          onProgress?.({ done: index - 1, total: files.length, label: `华为 · 第 ${sub}/${parsed.activities.length} 条` });
          const skipped = tooShort(
            { name: activity.name || file.name, distance: activity.parsed.sessions[0]?.distance },
            minDistanceM,
          );
          if (skipped) {
            results.push(skipped);
            continue;
          }
          const key = `${file.name}|${activity.parsed.records[0]?.timestamp ?? 0}|${activity.parsed.records.length}|${Math.round(activity.parsed.sessions[0]?.distance ?? 0)}`;
          const hash = await hashBytes(new TextEncoder().encode(key).buffer as ArrayBuffer);
          const result = await saveParsed({
            parsed: activity.parsed,
            fileName: file.name,
            src: 'huawei',
            bytes: new ArrayBuffer(0),
            keepFile: false,
            hashOverride: hash,
            name: activity.name || undefined,
          });
          results.push(result);
        }
        if (!parsed.activities.length) {
          results.push({ status: 'no-gps', name: file.name, message: '没有找到可用的轨迹' });
        }
      } else {
        const loaded = await readActivityFile(file);
        const skipped = tooShort(
          { name: file.name, distance: loaded.parsed.sessions[0]?.distance },
          minDistanceM,
        );
        if (skipped) {
          results.push(skipped);
          continue;
        }
        results.push(await saveParsed({
          parsed: loaded.parsed,
          fileName: file.name,
          src: loaded.kind,
          bytes: loaded.bytes,
          keepFile: true,
        }));
      }
    } catch (error) {
      results.push({
        status: 'error',
        name: file.name,
        message: error instanceof Error ? error.message : '导入失败',
      });
    }
  }
  onProgress?.({ done: files.length, total: files.length, label: '完成' });

  return {
    results,
    added: results.filter((r) => r.status === 'added').length,
    duplicated: results.filter((r) => r.status === 'duplicate-file' || r.status === 'duplicate-motion').length,
    filtered: results.filter((r) => r.status === 'too-short').length,
    failed: results.filter((r) => r.status === 'error' || r.status === 'no-gps').length,
  };
}

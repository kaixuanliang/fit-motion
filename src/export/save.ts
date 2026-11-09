/**
 * 把 Blob 落到用户手里。
 *
 * 两条路：Android 里走原生 bridge（分块写进 MediaStore/下载目录），
 * 浏览器里没法自动下载大文件，弹一个「点一下保存」的卡片兜底。
 */

interface NativeSaveBridge {
  beginSave: (name: string, mime: string) => boolean;
  appendSave: (base64Chunk: string) => boolean;
  finishSave: () => string;
  cancelSave: () => void;
}

function nativeBridge(): NativeSaveBridge | null {
  const bridge = (window as unknown as { FitMotionAndroid?: NativeSaveBridge }).FitMotionAndroid;
  return bridge && typeof bridge.beginSave === 'function' ? bridge : null;
}

export async function saveBlob(blob: Blob, filename: string, mime: string): Promise<'saved' | 'picker' | 'manual'> {
  const bridge = nativeBridge();
  if (bridge) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
    }
    const base64 = btoa(binary);
    if (!bridge.beginSave(filename, mime)) throw new Error('无法创建文件');
    const chunkSize = 256 * 1024;
    for (let i = 0; i < base64.length; i += chunkSize) {
      if (!bridge.appendSave(base64.slice(i, i + chunkSize))) throw new Error('写入文件失败');
    }
    const path = bridge.finishSave();
    if (!path) throw new Error('保存失败');
    if (path === 'picker') return 'picker';
    return 'saved';
  }

  const url = URL.createObjectURL(blob);
  showBrowserSavePrompt(blob, url, filename, mime);
  return 'manual';
}

function showBrowserSavePrompt(blob: Blob, url: string, filename: string, mime: string): void {
  const existing = document.getElementById('browser-save-prompt');
  existing?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'browser-save-prompt';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(2,6,7,.78);backdrop-filter:blur(12px);';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(360px,calc(100vw - 40px));padding:24px;border:1px solid rgba(216,255,62,.3);border-radius:18px;background:#091311;color:#eef7e9;font-family:"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.55);';
  card.innerHTML = `<div style="font-size:13px;color:#8fa394;letter-spacing:.12em">EXPORT READY</div>
    <h3 style="margin:10px 0 8px;font-size:21px">文件已经生成</h3>
    <p style="margin:0 0 18px;color:#9fb1a5;font-size:12px;line-height:1.6">浏览器不会自动下载大文件，请点击下方按钮保存到手机。</p>`;
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '保存到手机';
  save.style.cssText = 'width:100%;min-height:44px;border:0;border-radius:10px;background:#d8ff3e;color:#102015;font-size:14px;font-weight:700;margin-bottom:9px;cursor:pointer;';
  const direct = document.createElement('a');
  direct.href = url;
  direct.download = filename;
  direct.textContent = '下载没有反应？点这里直接下载';
  direct.style.cssText = 'display:block;margin:8px 0 14px;color:#b9d86a;font-size:11px;text-decoration:underline;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.style.cssText = 'width:100%;min-height:36px;border:1px solid rgba(255,255,255,.15);border-radius:9px;background:transparent;color:#9fb1a5;font-size:12px;cursor:pointer;';
  card.append(save, direct, close);
  overlay.append(card);
  document.body.appendChild(overlay);
  const cleanup = (): void => {
    overlay.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  close.addEventListener('click', cleanup);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) cleanup(); });
  save.addEventListener('click', () => {
    void (async () => {
      try {
        const file = new File([blob], filename, { type: mime });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          cleanup();
          return;
        }
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (error) {
        // 卡片上的直链还在，用户可以手点
        console.error(error);
      }
    })();
  });
}

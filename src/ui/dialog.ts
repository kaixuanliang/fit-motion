/**
 * 应用内弹窗：底部抽屉式表单 + 居中提示卡。
 *
 * 之前 token 绑定走的是 window.prompt / alert —— Android WebView 里那是系统原生
 * 输入框，样式跟 App 完全两套，而且 prompt 在没实现 onJsPrompt 的 WebView 上
 * 直接返回 null。这里统一成自己画的弹层，跟三套主题共用 CSS 变量。
 */

export interface DialogField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** password 渲染成带遮罩的 text 输入框：type=password 会唤起 EMUI 安全键盘，
   *  长按粘贴被禁用；遮罩用 CSS 实现，附显示/隐藏切换。 */
  type?: 'text' | 'password';
  inputMode?: 'text' | 'numeric' | 'url';
  mono?: boolean;
}

export interface FormOptions {
  title: string;
  desc?: string;
  fields: DialogField[];
  confirmText?: string;
  cancelText?: string;
  /** 返回字符串表示校验失败，弹层不会关闭。 */
  validate?: (values: Record<string, string>) => string | null;
}

export interface AlertOptions {
  title?: string;
  tone?: 'info' | 'error' | 'ok';
  confirmText?: string;
}

const ICONS: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10.6v6"/><circle cx="12" cy="7.6" r="1.05" fill="currentColor" stroke="none"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.4v6.2"/><circle cx="12" cy="16.6" r="1.05" fill="currentColor" stroke="none"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.6"/>',
};

function host(): HTMLElement {
  let node = document.getElementById('fm-dialog-host');
  if (!node) {
    node = document.createElement('div');
    node.id = 'fm-dialog-host';
    node.className = 'fm-dialog-host';
    document.body.appendChild(node);
  }
  return node;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;'
      : ch === '"' ? '&quot;' : '&#39;'
  ));
}

function mount(html: string): { root: HTMLElement; close: () => void } {
  const root = document.createElement('div');
  root.className = 'fm-dialog';
  root.innerHTML = `<div class="fm-dialog-mask"></div>${html}`;
  host().appendChild(root);
  // 下一帧加 open，保证过渡动画生效
  requestAnimationFrame(() => root.classList.add('open'));
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.classList.remove('open');
    window.setTimeout(() => root.remove(), 220);
  };
  root.querySelector('.fm-dialog-mask')?.addEventListener('click', close);
  return { root, close };
}

/** 底部抽屉表单，取消返回 null。 */
export function showForm(options: FormOptions): Promise<Record<string, string> | null> {
  const fields = options.fields.map((field) => {
    const value = escapeHtml(field.value ?? '');
    if (field.type === 'password') {
      // text + CSS 遮罩（-webkit-text-security）：不触发华为安全键盘，长按粘贴可用
      return `<label class="fm-field">
        <span class="fm-field-label">${escapeHtml(field.label)}</span>
        <span class="fm-secret">
          <input class="fm-input fm-mono fm-secret-input fm-masked" type="text" data-key="${field.key}" value="${value}"
               placeholder="${escapeHtml(field.placeholder ?? '')}" inputmode="url" spellcheck="false"
               autocapitalize="off" autocomplete="off" autocorrect="off">
          <button class="fm-secret-toggle" type="button" data-secret-toggle>显示</button>
        </span>
        ${field.hint ? `<span class="fm-field-hint">${escapeHtml(field.hint)}</span>` : ''}
      </label>`;
    }
    const input = `<input class="fm-input${field.mono ? ' fm-mono' : ''}" type="text" data-key="${field.key}" value="${value}"
           placeholder="${escapeHtml(field.placeholder ?? '')}" inputmode="${field.inputMode ?? 'text'}"
           spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off">`;
    return `<label class="fm-field">
      <span class="fm-field-label">${escapeHtml(field.label)}</span>
      ${input}
      ${field.hint ? `<span class="fm-field-hint">${escapeHtml(field.hint)}</span>` : ''}
    </label>`;
  }).join('');

  const { root, close } = mount(`
    <form class="fm-dialog-card fm-sheet" autocomplete="off">
      <header class="fm-dialog-head">
        <h3>${escapeHtml(options.title)}</h3>
        ${options.desc ? `<p>${escapeHtml(options.desc)}</p>` : ''}
      </header>
      <div class="fm-dialog-body">${fields}</div>
      <p class="fm-dialog-error" role="alert" hidden></p>
      <footer class="fm-dialog-actions">
        <button type="button" class="fm-btn ghost" data-act="cancel">${escapeHtml(options.cancelText ?? '取消')}</button>
        <button type="submit" class="fm-btn primary">${escapeHtml(options.confirmText ?? '确定')}</button>
      </footer>
    </form>
  `);

  const form = root.querySelector('form') as HTMLFormElement;
  const errorBox = root.querySelector('.fm-dialog-error') as HTMLElement;
  const inputs = [...form.querySelectorAll<HTMLInputElement>('input[data-key]')];

  const read = (): Record<string, string> => {
    const values: Record<string, string> = {};
    inputs.forEach((input) => { values[input.dataset.key as string] = input.value.trim(); });
    return values;
  };

  const fail = (message: string): void => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  inputs.forEach((input) => input.addEventListener('input', () => { errorBox.hidden = true; }));

  // 密码遮罩切换：显示/隐藏 token，避免旁边有人时泄露
  form.querySelectorAll<HTMLButtonElement>('[data-secret-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.closest('.fm-field') as HTMLElement | null;
      const input = field?.querySelector<HTMLInputElement>('.fm-secret-input');
      if (!input) return;
      const masked = input.classList.toggle('fm-masked');
      button.textContent = masked ? '显示' : '隐藏';
    });
  });

  return new Promise((resolve) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = read();
      const problem = options.validate ? options.validate(values) : null;
      if (problem) { fail(problem); return; }
      close();
      resolve(values);
    });
    (form.querySelector('[data-act="cancel"]') as HTMLElement).addEventListener('click', () => {
      close();
      resolve(null);
    });
    window.setTimeout(() => inputs[0]?.focus({ preventScroll: true }), 260);
  });
}

/** 居中提示卡，只能确认。 */
export function showAlert(message: string, options: AlertOptions = {}): Promise<void> {
  const tone = options.tone ?? 'info';
  const { root, close } = mount(`
    <div class="fm-dialog-card fm-alert" role="alertdialog">
      <div class="fm-alert-icon tone-${tone}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round">${ICONS[tone] ?? ICONS.info}</svg>
      </div>
      <h3>${escapeHtml(options.title ?? (tone === 'error' ? '出错了' : '提示'))}</h3>
      <p>${escapeHtml(message)}</p>
      <button type="button" class="fm-btn primary" data-act="ok">${escapeHtml(options.confirmText ?? '知道了')}</button>
    </div>
  `);
  return new Promise((resolve) => {
    (root.querySelector('[data-act="ok"]') as HTMLElement).addEventListener('click', () => {
      close();
      resolve();
    });
  });
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** danger 会把确认按钮染成警示色，用于删除这类不可逆操作。 */
  tone?: 'info' | 'danger';
}

/** 两按钮确认卡，确认返回 true。 */
export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  const danger = options.tone === 'danger';
  const { root, close } = mount(`
    <div class="fm-dialog-card fm-alert${danger ? ' danger' : ''}" role="alertdialog">
      <div class="fm-alert-icon tone-${danger ? 'error' : 'info'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round">${danger ? ICONS.error : ICONS.info}</svg>
      </div>
      <h3>${escapeHtml(options.title)}</h3>
      <p>${escapeHtml(options.message)}</p>
      <div class="fm-dialog-actions">
        <button type="button" class="fm-btn ghost" data-act="cancel">${escapeHtml(options.cancelText ?? '取消')}</button>
        <button type="button" class="fm-btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(options.confirmText ?? '确定')}</button>
      </div>
    </div>
  `);
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      close();
      resolve(value);
    };
    (root.querySelector('[data-act="ok"]') as HTMLElement).addEventListener('click', () => finish(true));
    (root.querySelector('[data-act="cancel"]') as HTMLElement).addEventListener('click', () => finish(false));
    root.querySelector('.fm-dialog-mask')?.addEventListener('click', () => finish(false));
  });
}

export interface ActionItem {
  key: string;
  label: string;
  /** 副标题，说明这个动作会发生什么。 */
  note?: string;
  tone?: 'default' | 'danger';
}

/** 底部动作菜单，返回点击的 key（取消返回 null）。 */
export function showActionSheet(options: { title?: string; items: ActionItem[] }): Promise<string | null> {
  const buttons = options.items.map((item) => `<button type="button"
      class="fm-action${item.tone === 'danger' ? ' danger' : ''}" data-act="${escapeHtml(item.key)}">
      <span class="fm-action-label">${escapeHtml(item.label)}</span>
      ${item.note ? `<span class="fm-action-note">${escapeHtml(item.note)}</span>` : ''}
    </button>`).join('');
  const { root, close } = mount(`
    <div class="fm-dialog-card fm-action-sheet" role="dialog">
      ${options.title ? `<p class="fm-action-title">${escapeHtml(options.title)}</p>` : ''}
      <div class="fm-action-list">${buttons}</div>
      <button type="button" class="fm-action cancel" data-act="__cancel">取消</button>
    </div>
  `);
  return new Promise((resolve) => {
    const done = (value: string | null): void => {
      close();
      resolve(value);
    };
    root.querySelectorAll<HTMLElement>('[data-act]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.act ?? '';
        done(key === '__cancel' ? null : key);
      });
    });
    root.querySelector('.fm-dialog-mask')?.addEventListener('click', () => done(null));
  });
}

/** 长文本查看 + 一键复制（替代 prompt 的只读场景）。 */
export function showText(options: { title: string; text: string; confirmText?: string }): Promise<void> {
  const { root, close } = mount(`
    <div class="fm-dialog-card fm-text-card">
      <header class="fm-dialog-head">
        <h3>${escapeHtml(options.title)}</h3>
      </header>
      <pre class="fm-text-body">${escapeHtml(options.text)}</pre>
      <footer class="fm-dialog-actions">
        <button type="button" class="fm-btn ghost" data-act="copy">复制全文</button>
        <button type="button" class="fm-btn primary" data-act="ok">${escapeHtml(options.confirmText ?? '关闭')}</button>
      </footer>
    </div>
  `);
  return new Promise((resolve) => {
    const copy = root.querySelector('[data-act="copy"]') as HTMLButtonElement;
    copy.addEventListener('click', () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(options.text);
          copy.textContent = '已复制';
        } catch {
          copy.textContent = '请长按选择';
        }
        window.setTimeout(() => { copy.textContent = '复制全文'; }, 1800);
      })();
    });
    (root.querySelector('[data-act="ok"]') as HTMLElement).addEventListener('click', () => {
      close();
      resolve();
    });
  });
}

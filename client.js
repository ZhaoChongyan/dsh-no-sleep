/**
 * no-sleep, browser half.
 *
 * One preference row in Settings → General. The Host half answers at
 * `/no-sleep/api` and owns the wake request; this module only renders the row
 * and writes the preference back, so the UI shows what the Host reports rather
 * than what the page intends.
 */
window.__ModuleLoader__.load({
  id: '@local/no-sleep',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'no-sleep';
    const ENDPOINT = '/no-sleep/api';
    const POLL_MS = 4000;

    const zh = {
      'title': '阻止电脑睡眠',
      'description': 'DSH 运行时让电脑保持唤醒，长时间任务不会因息屏或待机中断。',
      'hint': '唤醒请求由 DSH 应用进程持有的一个辅助进程完成：退出 DSH、关掉此开关或辅助进程意外退出时，请求都会立即释放。',
      'label.on': '开',
      'label.off': '关',
      'status.checking': '正在读取状态…',
      'status.saving': '正在保存…',
      'status.off': '已关闭，电脑按电源计划正常睡眠',
      'status.holding': '保持唤醒中',
      'status.starting': '正在启动唤醒辅助进程…',
      'status.error': '无法保持唤醒',
      'status.unavailable': '当前是 {platform} 环境：本插件目前只支持 Windows。',
      'mode.legend': '保持唤醒范围',
      'mode.display': '屏幕与系统都不睡眠',
      'mode.displayHint': '任务结束后屏幕也不会自动熄灭，会一直亮着；耗电明显增加。',
      'mode.system': '只阻止系统睡眠',
      'mode.systemHint': '屏幕按你的电源设置正常熄灭，后台任务继续运行；更省电。',
      'detail.pid': '辅助进程',
      'detail.process': '进程',
      'secondary.desktop': '桌面端：请求挂在应用进程之下，退出应用即释放。',
      'secondary.web': '当前的 Web 页面看不到桌面窗口，无法判断窗口是否可见。',
      'save.failed': '保存失败：{message}',
    };

    const en = {
      'title': 'Prevent sleep',
      'description': 'Keep this computer awake while DeepSeek Harness runs, so long tasks are not cut off by screen-off or sleep.',
      'hint': 'The request is held by a helper process owned by DeepSeek Harness: quitting the app, turning this switch off, or a helper crash all release it immediately.',
      'label.on': 'On',
      'label.off': 'Off',
      'status.checking': 'Reading status…',
      'status.saving': 'Saving…',
      'status.off': 'Off — the computer sleeps per your power plan',
      'status.holding': 'Holding the computer awake',
      'status.starting': 'Starting the wake helper…',
      'status.error': 'Could not hold the computer awake',
      'status.unavailable': 'This is a {platform} host: the plugin supports Windows only.',
      'mode.legend': 'Keep awake',
      'mode.display': 'Screen and system',
      'mode.displayHint': 'The screen also stays on after the task; costs noticeably more power.',
      'mode.system': 'System only',
      'mode.systemHint': 'The screen turns off per your power plan while work continues; the power-friendly choice.',
      'detail.pid': 'Helper',
      'detail.process': 'process',
      'secondary.desktop': 'Desktop app: the request lives under the app process and ends with it.',
      'secondary.web': 'A Web page cannot see the desktop window, so window visibility is unknowable here.',
      'save.failed': 'Could not save: {message}',
    };

    const CSS = `
.nslp-row{display:flex;flex-direction:column;gap:10px;padding:4px 0}
.nslp-head{display:flex;align-items:flex-start;gap:12px}
.nslp-text{flex:1;min-width:0}
.nslp-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nslp-desc{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.nslp-switch{position:relative;flex:none;width:36px;height:20px;border:none;border-radius:999px;padding:0;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover,#80808029);transition:background .15s ease}
.nslp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4f6ef7)}
.nslp-switch:disabled{opacity:.55;cursor:default}
.nslp-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s ease}
.nslp-switch[aria-checked="true"]::after{transform:translateX(16px)}
.nslp-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:2px}
.nslp-status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.nslp-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8b93a1)}
.nslp-dot[data-verdict="holding"]{background:var(--dsw-alias-state-success-primary,#16a34a)}
.nslp-dot[data-verdict="starting"]{background:var(--dsw-alias-state-warn-primary,#b8860b)}
.nslp-dot[data-verdict="error"]{background:var(--dsw-alias-state-danger-primary,#d1242f)}
.nslp-detail{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.nslp-fieldset{display:grid;gap:8px;margin:0;padding:0;border:none}
.nslp-legend{padding:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.nslp-option{display:grid;grid-template-columns:16px 1fr;gap:4px 8px;align-items:start;cursor:pointer}
.nslp-option input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4f6ef7)}
.nslp-option-label{font-size:13px;color:var(--dsw-alias-label-primary)}
.nslp-option-hint{grid-column:2;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.nslp-note{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.nslp-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.nslp-error{margin:0;font-size:12px;color:var(--dsw-alias-state-danger-primary,#d1242f)}
`;

    function ensureStyles() {
      const tagId = '@local/no-sleep/row.css';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return null;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/no-sleep';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return tag;
    }

    /** Substitute the host platform into a dictionary's `{platform}` entries. */
    function withPlatform(dict, platformLabel) {
      const next = {};
      for (const key of Object.keys(dict)) {
        next[key] = String(dict[key]).split('{platform}').join(platformLabel);
      }
      return next;
    }

    async function request(method, body) {
      const init = { method, cache: 'no-store' };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await fetch(ENDPOINT, init);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((data && (data.error || (data.status && data.status.error))) || 'HTTP ' + response.status);
      }
      return data;
    }

    function Switch({ checked, disabled, label, onToggle }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'nslp-switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: label,
        disabled: disabled === true ? true : undefined,
        onClick: onToggle,
      });
    }

    function Option({ name, value, checked, disabled, label, hint, onChange }) {
      return h('label', { className: 'nslp-option' }, [
        h('input', {
          key: 'input',
          type: 'radio',
          name,
          value,
          checked,
          disabled,
          onChange,
        }),
        h('span', { key: 'label', className: 'nslp-option-label' }, label),
        h('span', { key: 'hint', className: 'nslp-option-hint' }, hint),
      ]);
    }

    /** "holding" / "starting" / "error" / "off", from the Host's report. */
    function verdictOf(status) {
      if (status === null) return 'unknown';
      if (status.supported !== true) return 'unavailable';
      const settings = status.settings;
      if (settings === null || settings === undefined || settings.enabled !== true) return 'off';
      const hold = status.hold;
      if (status.error !== null && status.error !== undefined) return 'error';
      if (hold === null || hold === undefined) return 'starting';
      if (hold.confirmed === true) return 'holding';
      if (hold.holding === true) return 'starting';
      return 'error';
    }

    /** The General preference row. */
    function NoSleepRow({ t }) {
      const [status, setStatus] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        let timer = null;
        const load = async () => {
          try {
            const next = await request('GET');
            if (alive.current) {
              setStatus(next);
              setFailure(null);
            }
          } catch (error) {
            if (alive.current) setFailure(error.message);
          }
          if (alive.current) timer = window.setTimeout(load, POLL_MS);
        };
        void load();
        return () => {
          alive.current = false;
          if (timer !== null) window.clearTimeout(timer);
        };
      }, []);

      const save = React.useCallback(async (patch) => {
        setBusy(true);
        try {
          const next = await request('POST', patch);
          if (alive.current) {
            setStatus(next);
            setFailure(null);
          }
        } catch (error) {
          if (alive.current) setFailure(error.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      }, []);

      const settings = status === null ? null : status.settings;
      const enabled = settings !== null && settings !== undefined && settings.enabled === true;
      const verdict = verdictOf(status);
      const unsupported = verdict === 'unavailable';

      const statusText = () => {
        if (status === null) return failure === null ? t('status.checking') : t('status.error');
        if (unsupported) return t('status.unavailable', { platform: status.platform });
        if (verdict === 'off') return t('status.off');
        if (verdict === 'holding') return t('status.holding');
        if (verdict === 'starting') return t('status.starting');
        return status.error === null || status.error === undefined ? t('status.error') : status.error;
      };

      const details = [];
      if (verdict === 'holding') {
        details.push(`${t('detail.pid')} ${status.hold.processId}`);
      }

      return h('div', { className: 'nslp-row' }, [
        h('div', { key: 'head', className: 'nslp-head' }, [
          h('div', { key: 'text', className: 'nslp-text' }, [
            h('p', { key: 'title', className: 'nslp-title' }, t('title')),
            h('p', { key: 'desc', className: 'nslp-desc' }, t('description')),
          ]),
          h(Switch, {
            key: 'switch',
            checked: enabled,
            disabled: busy || status === null || unsupported,
            label: enabled ? t('label.on') : t('label.off'),
            onToggle: () => { void save({ enabled: !enabled }); },
          }),
        ]),
        h('div', { key: 'status', className: 'nslp-status' }, [
          h('span', { key: 'dot', className: 'nslp-dot', 'data-verdict': verdict }),
          h('span', { key: 'text' }, busy ? t('status.saving') : statusText()),
        ]),
        details.length > 0 ? h('p', { key: 'detail', className: 'nslp-detail' }, details.join(' · ')) : null,
        h('p', { key: 'hint', className: 'nslp-hint' }, t('hint')),
        settings !== null && settings !== undefined && !unsupported
          ? h('fieldset', { key: 'mode', className: 'nslp-fieldset' }, [
              h('legend', { key: 'legend', className: 'nslp-legend' }, t('mode.legend')),
              h(Option, {
                key: 'display',
                name: 'nslp-mode',
                value: 'display',
                checked: settings.mode === 'display',
                disabled: busy,
                label: t('mode.display'),
                hint: t('mode.displayHint'),
                onChange: () => { void save({ mode: 'display' }); },
              }),
              h(Option, {
                key: 'system',
                name: 'nslp-mode',
                value: 'system',
                checked: settings.mode === 'system',
                disabled: busy,
                label: t('mode.system'),
                hint: t('mode.systemHint'),
                onChange: () => { void save({ mode: 'system' }); },
              }),
            ])
          : null,
        failure === null ? null : h('p', { key: 'failure', className: 'nslp-error' }, t('save.failed', { message: failure })),
      ]);
    }

    function apply(ctx) {
      const platform = typeof navigator === 'object' && navigator ? String(navigator.platform || '') : '';
      const platformLabel = platform.toLowerCase().includes('win') ? 'Windows' : platform || 'unknown';

      ctx.effect(() => {
        const tag = ensureStyles();
        return () => {
          if (tag !== null) tag.remove();
        };
      }, 'no-sleep: styles');

      ctx.effect(() => ctx.locale.register(NS, {
        zh: withPlatform(zh, platformLabel),
        en: withPlatform(en, platformLabel),
      }), 'no-sleep: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: NS,
        order: 40,
        locale: NS,
        inject: () => ({ t }),
      }, NoSleepRow));
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});

// GitHub Rich View Switcher
//
// PR / commit / compare の差分ページで、ユーザーがあるファイルの
// 「Display the rich diff」/「Display the source diff」を押したら、
// ページ内で切り替え可能な他のファイルもすべて同じ表示に揃える。
// 後から読み込まれたファイル（遅延ロード・仮想スクロール）にも同じ表示を適用する。
//
// 対応している DOM は 2 種類:
//   classic: 旧来の Files changed（Rails + 素の JS）
//     <div class="file js-file js-details-container ... [display-rich-diff]">
//       <form class="js-prose-diff-toggle-form"><button class="js-source [selected]">
//       <form class="js-prose-diff-toggle-form"><button class="js-rendered [selected]">
//     ファイルの状態はコンテナの display-rich-diff クラスが正。
//     GitHub 側のクリックハンドラはページ内の全トグルの selected を外してしまうため、
//     ボタンの selected は信用できない（同期し直す）。
//   react: 新しい Files changed（React + Primer SegmentedControl）
//     <ul data-component="SegmentedControl" aria-label="File view">
//       <li><button aria-pressed="true|false" aria-labelledby="(tooltip)">
//     ボタン自体に aria-label は無く、ラベルは Tooltip 経由（aria-labelledby）。
//     状態は aria-pressed が正。
(() => {
  'use strict';

  const LABEL_RICH = 'display the rich diff';
  const LABEL_SOURCE = 'display the source diff';
  const MAX_IN_FLIGHT = 4; // 旧 UI はファイルごとに fetch が走るので同時実行数を絞る
  const PENDING_TIMEOUT_MS = 15000;
  const DEBUG = false;

  const log = (...args) => DEBUG && console.debug('[rich-view-switcher]', ...args);

  /** @type {'rich' | 'source' | null} このページでユーザーが最後に選んだ表示 */
  let desiredMode = null;
  let desiredModeKey = null;

  /** 切り替え要求を出したがまだ反映されていない対象。key -> 期限 */
  const pending = new Map();
  /** 反映待ちの数を数えるため、key とその対象の現在状態取得関数を持つ */
  const pendingTargets = new Map();

  // PR 内でタブ（/files ⇔ /changes 等）を移動しても同じ設定を使い、
  // 別の PR やページに移ったらリセットする。
  function pageKey() {
    const m = location.pathname.match(/^\/[^/]+\/[^/]+\/pull\/\d+/);
    return m ? m[0] : location.pathname;
  }

  function currentDesiredMode() {
    if (desiredModeKey !== pageKey()) {
      desiredMode = null;
      desiredModeKey = pageKey();
    }
    return desiredMode;
  }

  // ---------------------------------------------------------------------------
  // classic UI
  // ---------------------------------------------------------------------------

  const classic = {
    targetOf(button) {
      const container = button.closest('.js-prose-diff-toggle-form') && button.closest('.js-details-container');
      return container ? this.targets().find((t) => t.key === container) ?? null : null;
    },

    modeOf(button) {
      if (!button.closest('.js-prose-diff-toggle-form')) return null;
      if (button.classList.contains('js-rendered')) return 'rich';
      if (button.classList.contains('js-source')) return 'source';
      return null;
    },

    containers() {
      const set = new Set();
      for (const btn of document.querySelectorAll('.js-prose-diff-toggle-form button.js-rendered')) {
        const c = btn.closest('.js-details-container');
        if (c) set.add(c);
      }
      return set;
    },

    buttonOf(container, mode) {
      const cls = mode === 'rich' ? 'js-rendered' : 'js-source';
      for (const btn of container.querySelectorAll(`.js-prose-diff-toggle-form button.${cls}`)) {
        if (btn.closest('.js-details-container') === container) return btn;
      }
      return null;
    },

    stateOf(container) {
      return container.classList.contains('display-rich-diff') ? 'rich' : 'source';
    },

    targets() {
      return [...this.containers()].map((container) => ({
        key: container,
        current: () => this.stateOf(container),
        button: (mode) => this.buttonOf(container, mode),
        beforeClick: (btn) => {
          // GitHub のハンドラは selected が付いたボタンのクリックを無視するので外しておく
          btn.classList.remove('selected');
          btn.removeAttribute('aria-current');
        },
      }));
    },

    // GitHub のハンドラが他ファイルの selected を外してしまうので、実際の状態に合わせ直す。
    // これをしないと、表示と selected がずれたファイルで再クリック時に表示が反転してしまう。
    syncSelection() {
      for (const container of this.containers()) {
        if (pending.has(container)) continue; // 通信中は GitHub 側の表示に任せる
        const state = this.stateOf(container);
        for (const mode of ['rich', 'source']) {
          const btn = this.buttonOf(container, mode);
          if (!btn || btn.disabled) continue;
          const on = mode === state;
          if (btn.classList.contains('selected') !== on) btn.classList.toggle('selected', on);
          if (on && btn.getAttribute('aria-current') !== 'true') btn.setAttribute('aria-current', 'true');
          if (!on && btn.hasAttribute('aria-current')) btn.removeAttribute('aria-current');
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // React UI
  // ---------------------------------------------------------------------------

  function accessibleLabel(el) {
    const direct = el.getAttribute('aria-label');
    if (direct) return direct;
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    return '';
  }

  function modeFromLabel(label) {
    const l = label.toLowerCase();
    if (l.includes(LABEL_RICH)) return 'rich';
    if (l.includes(LABEL_SOURCE)) return 'source';
    return null;
  }

  const react = {
    controls() {
      return document.querySelectorAll('ul[data-component="SegmentedControl"]');
    },

    // SegmentedControl 内のボタンを { rich, source } に対応付ける。
    // ラベルで判定し、取れない場合は aria-label="File view" のときだけ並び順（source, rich）で判定する。
    buttonsOf(ul) {
      const buttons = [...ul.querySelectorAll(':scope > li > button')];
      const map = {};
      for (const btn of buttons) {
        const mode = modeFromLabel(accessibleLabel(btn));
        if (mode) map[mode] = btn;
      }
      if ((!map.rich || !map.source) && ul.getAttribute('aria-label') === 'File view' && buttons.length === 2) {
        map.source = buttons[0];
        map.rich = buttons[1];
      }
      return map.rich && map.source ? map : null;
    },

    targetOf(button) {
      const ul = button.closest('ul[data-component="SegmentedControl"]');
      return ul ? this.targets().find((t) => t.key === ul) ?? null : null;
    },

    modeOf(button) {
      const ul = button.closest('ul[data-component="SegmentedControl"]');
      if (!ul) return null;
      const map = this.buttonsOf(ul);
      if (!map) return null;
      if (map.rich === button) return 'rich';
      if (map.source === button) return 'source';
      return null;
    },

    targets() {
      const out = [];
      for (const ul of this.controls()) {
        const map = this.buttonsOf(ul);
        if (!map) continue;
        out.push({
          key: ul,
          current: () => {
            const m = this.buttonsOf(ul);
            if (!m) return null;
            return m.rich.getAttribute('aria-pressed') === 'true' ? 'rich' : 'source';
          },
          button: (mode) => this.buttonsOf(ul)?.[mode] ?? null,
          beforeClick: () => {},
        });
      }
      return out;
    },
  };

  const adapters = [classic, react];

  function classifyButton(button) {
    for (const a of adapters) {
      const mode = a.modeOf(button);
      if (mode) return { mode, target: a.targetOf(button) };
    }
    return null;
  }

  function markPending(target, wanted) {
    pending.set(target.key, Date.now() + PENDING_TIMEOUT_MS);
    pendingTargets.set(target.key, { key: target.key, current: target.current, wanted });
  }

  // ---------------------------------------------------------------------------
  // 適用
  // ---------------------------------------------------------------------------

  function cleanupPending() {
    const now = Date.now();
    for (const [key, expires] of pending) {
      const target = pendingTargets.get(key);
      const done = target && !target.key.isConnected;
      const reached = target && target.current() === target.wanted;
      if (done || reached || now > expires) {
        pending.delete(key);
        pendingTargets.delete(key);
      }
    }
  }

  function applyDesiredMode() {
    const mode = currentDesiredMode();
    cleanupPending();
    if (!mode) return;

    const savedUrl = location.href;
    let clicked = 0;

    for (const a of adapters) {
      for (const t of a.targets()) {
        if (pending.size >= MAX_IN_FLIGHT) break;
        if (pending.has(t.key)) continue;
        if (t.current() === mode) continue;
        const btn = t.button(mode);
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;

        markPending(t, mode);
        t.beforeClick(btn);
        log('switch', mode, btn);
        btn.click(); // isTrusted=false になるので自分のリスナーでは無視される
        clicked++;
      }
    }

    if (clicked > 0) {
      // 旧 UI はクリックのたびに URL（short_path とハッシュ）を書き換えるので、
      // ユーザーがクリックした時点の URL に戻す
      if (location.href !== savedUrl) history.replaceState(history.state, '', savedUrl);
      classic.syncSelection();
    }
  }

  // ユーザー自身のクリック（キーボード操作による click も含む）だけを拾う
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const hit = classifyButton(button);
      if (!hit) return;
      const { mode, target } = hit;

      currentDesiredMode(); // ページが変わっていればキーをリセット
      desiredMode = mode;
      // クリックされたファイル自体は GitHub が切り替えるので、反映されるまで触らない
      if (target && target.current() !== mode) markPending(target, mode);
      log('user selected', mode);
      // GitHub 側のハンドラが先に処理を終えてから他のファイルに適用する
      setTimeout(applyDesiredMode, 0);
    },
    true,
  );

  // 遅延ロード・仮想スクロールで出てきたファイルや、
  // 切り替え完了（クラス変化）に追従するための監視
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      cleanupPending();
      if (currentDesiredMode()) classic.syncSelection();
      applyDesiredMode();
    }, 100);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-pressed'],
  });

  // 保留中の切り替えがタイムアウトした場合でも再評価されるように
  setInterval(() => {
    if (pending.size > 0) schedule();
  }, 1000);
})();

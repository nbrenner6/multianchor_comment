/**
 * Multi-Anchor Comment Plugin for Gerrit
 *
 * Extends Gerrit's code-review UI to support comments anchored to multiple
 * non-adjacent line ranges in a single diff.  Standard Gerrit only allows a
 * comment on one contiguous range; this plugin lets reviewers reference
 * scattered-but-related lines (e.g. a renamed variable and all its call sites)
 * in one comment thread.
 *
 */
Gerrit.install(plugin => {

  // ── REST helper ────────────────────────────────────────────────────────────
  const restApi = plugin.restApi();

  // ── In-memory store ────────────────────────────────────────────────────────
  const savedComments = new Map();

  // ── URL helpers ────────────────────────────────────────────────────────────
  function getChangeNumber() {
    const m = window.location.pathname.match(/\/c\/[^/]+\/\+\/(\d+)/);
    return m ? m[1] : null;
  }
  function getPatchSetNumber() {
    const m = window.location.pathname.match(/\/c\/[^/]+\/\+\/\d+\/(\d+)/);
    return m ? m[1] : 'current';
  }
  function getFilePath() {
    const m = window.location.pathname.match(/\/c\/[^/]+\/\+\/\d+\/\d+\/(.+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── Prompt history (localStorage) ─────────────────────────────────────────
  const HISTORY_KEY = 'ma-plugin:prompt-history';
  const MAX_HISTORY = 5;
  function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
  function pushHistory(prompt) {
    if (!prompt.trim()) return;
    const h = [prompt, ...loadHistory().filter(p => p !== prompt)].slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  }

  // ── Shadow-DOM traversal ───────────────────────────────────────────────────
  function getDiffElement() {
    try {
      return document.querySelector('gr-app').shadowRoot
        .querySelector('gr-app-element').shadowRoot
        .querySelector('gr-diff-view').shadowRoot
        .querySelector('gr-diff-host').shadowRoot
        .querySelector('gr-diff').shadowRoot
        .querySelector('gr-diff-element');
    } catch { return null; }
  }
  function getGrDiffHost() {
    try {
      return document.querySelector('gr-app').shadowRoot
        .querySelector('gr-app-element').shadowRoot
        .querySelector('gr-diff-view').shadowRoot
        .querySelector('gr-diff-host');
    } catch { return null; }
  }

  // ── REST: Gerrit drafts ────────────────────────────────────────────────────
  async function createDraft(changeNum, patchSet, path, range, message, unresolved) {
    const body = { path, line: range.end_line, message, unresolved };
    return restApi.put(`/changes/${changeNum}/revisions/${patchSet}/drafts`, body);
  }

  async function updateDraft(changeNum, patchSet, draftId, message, unresolved) {
    const existing = await restApi.get(
      `/changes/${changeNum}/revisions/${patchSet}/drafts/${draftId}`
    );
    const body = { ...existing, message, unresolved };
    return restApi.put(
      `/changes/${changeNum}/revisions/${patchSet}/drafts/${draftId}`, body
    );
  }

  async function deleteDraft(changeNum, patchSet, draftId) {
    return restApi.delete(`/changes/${changeNum}/revisions/${patchSet}/drafts/${draftId}`);
  }

  // ── REST: Plugin multi-anchor storage ─────────────────────────────────────
  async function saveAdditionalRanges(changeNum, commentUuid, ranges) {
    return restApi.put(`/changes/${changeNum}/multianchor-ranges/${commentUuid}`, { ranges });
  }
  async function deleteAdditionalRanges(changeNum, commentUuid) {
    return restApi.delete(`/changes/${changeNum}/multianchor-ranges/${commentUuid}`);
  }
  async function getAllAdditionalRanges(changeNum) {
    return restApi.get(`/changes/${changeNum}/multianchor-ranges`);
  }

  // ── Load multi-anchor comments from backend ────────────────────────────────
  const AI_PREFIX = '🤖 AI Review:';

  async function loadMultiAnchorComments(changeNum, patchSet) {
    try {
      const [drafts, additionalRanges] = await Promise.all([
        restApi.get(`/changes/${changeNum}/revisions/${patchSet}/drafts`),
        getAllAdditionalRanges(changeNum),
      ]);

      savedComments.clear();

      for (let [path, comments] of Object.entries(drafts || {})) {
        path = path.replace(/^\[(.+?)\]\(.+?\)$/, '$1');
        for (const comment of comments) {
          const uuid        = comment.id;
          const extraRanges = additionalRanges[uuid] || [];
          const isAiComment = comment.message?.startsWith(AI_PREFIX);

          if (extraRanges.length === 0 && !isAiComment) continue;

          const primaryRange = comment.range ||
            (comment.line
              ? { start_line: comment.line, start_character: 0, end_line: comment.line, end_character: 0 }
              : null);
          const allRanges = primaryRange ? [primaryRange, ...extraRanges] : extraRanges;

          const lines = allRanges.flatMap(r => {
            const start = r.start_line ?? r.startLine;
            const end   = r.end_line   ?? r.endLine;
            if (start == null || end == null) return [];
            const keys = [];
            for (let l = start; l <= end; l++) keys.push(`right-${l}`);
            return keys;
          });

          if (lines.length === 0) continue;

          savedComments.set(uuid, {
            id: uuid,
            path,
            lines,
            text:             comment.message,
            resolved:         comment.unresolved === false,
            isDraft:          true,
            primaryRange,
            additionalRanges: extraRanges,
          });
        }
      }
      return savedComments;
    } catch (e) {
      return savedComments;
    }
  }

  // ── Line-key helpers ───────────────────────────────────────────────────────
  function lineKeysToRanges(lineKeys, side) {
    const nums = [...lineKeys]
      .filter(k => k.startsWith(side))
      .map(k => parseInt(k.split('-')[1], 10))
      .sort((a, b) => a - b);
    if (!nums.length) return [];
    const ranges = [];
    let s = nums[0], e = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === e + 1) { e = nums[i]; }
      else { ranges.push({ start_line: s, start_character: 0, end_line: e, end_character: 0 }); s = e = nums[i]; }
    }
    ranges.push({ start_line: s, start_character: 0, end_line: e, end_character: 0 });
    return ranges;
  }

  // ── Create / delete multi-anchor comments ─────────────────────────────────
  async function createMultiAnchorComment(selectedLines, message, resolved) {
    const changeNum = getChangeNumber();
    const patchSet  = getPatchSetNumber();
    const path      = getFilePath();
    if (!changeNum || !path) return null;

    const rightLines = [...selectedLines].filter(k => k.startsWith('right'));
    const leftLines  = [...selectedLines].filter(k => k.startsWith('left'));
    const side       = rightLines.length >= leftLines.length ? 'right' : 'left';
    const allRanges  = lineKeysToRanges(selectedLines, side);
    if (!allRanges.length) return null;

    try {
      const draft = await createDraft(changeNum, patchSet, path, allRanges[0], message, !resolved);
      if (allRanges.length > 1) {
        await saveAdditionalRanges(changeNum, draft.id, allRanges.slice(1));
      }
      savedComments.set(draft.id, {
        id: draft.id, path, lines: [...selectedLines], text: message,
        resolved, isDraft: true,
        primaryRange:     allRanges[0],
        additionalRanges: allRanges.slice(1),
      });
      return draft;
    } catch { return null; }
  }

  async function deleteMultiAnchorComment(commentId) {
    const changeNum = getChangeNumber();
    const patchSet  = getPatchSetNumber();
    if (!changeNum) return false;
    try {
      await deleteDraft(changeNum, patchSet, commentId);
      await deleteAdditionalRanges(changeNum, commentId);
      savedComments.delete(commentId);
      return true;
    } catch { return false; }
  }

  // ── Global styles ─────────────────────────────────────────────────────────
  function injectStyles(diffElement) {
    const existing = diffElement.querySelector('#ma-styles');
    if (existing) existing.remove();
    const s = document.createElement('style');
    s.id = 'ma-styles';
    s.textContent = `
      /* Selected lines (Ctrl+click) */
      td.multi-anchor-selected div.contentText      { background: rgba(255,200,0,.30) !important; }
      td.multi-anchor-selected button.lineNumButton { background: rgba(255,200,0,.30) !important; }

      /* Anchored lines (saved comment) */
      td.multi-anchor-existing div.contentText      { border-left:3px solid #1967d2 !important; background:rgba(66,133,244,.12) !important; }
      td.multi-anchor-existing button.lineNumButton { background:rgba(66,133,244,.15) !important; }

      /* Hover / click highlight */
      td.multi-anchor-highlighted div.contentText      { background:rgba(66,133,244,.30) !important; border-left:3px solid #1967d2 !important; }
      td.multi-anchor-highlighted button.lineNumButton { background:rgba(66,133,244,.30) !important; }

      /* Range badge pill */
      .ma-range-badge {
        display:inline-block; margin-left:4px; padding:1px 5px;
        background:#1967d2; color:#fff; border-radius:10px;
        font-size:10px; font-weight:600; line-height:1.4; vertical-align:middle;
        pointer-events:none;
      }

      .multi-anchor-thread { cursor: pointer; }

      /* ── Shared card chrome ── */
      .ma-card {
        background: rgb(254,247,224);
        font-family: var(--font-family), 'Roboto', Arial, sans-serif;
        font-size: var(--font-size-normal, 13px);
        color: var(--primary-text-color, #202124);
        overflow: hidden;
        word-wrap: break-word;
      }
      .ma-card.resolved { background: rgb(232,245,233); }

      /* Header row */
      .ma-card-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: var(--spacing-m) var(--spacing-m) var(--spacing-s);
        border-bottom: 1px solid rgba(0,0,0,.07);
      }
      .ma-card-header-icon {
        font-size: 15px;
        line-height: 1;
        flex-shrink: 0;
      }
      .ma-card-header-title {
        font-weight: 600;
        font-size: var(--font-size-normal, 13px);
        letter-spacing: .01em;
      }
      .ma-card-header-meta {
        font-size: 11px;
        color: var(--deemphasized-text-color, #80868b);
        font-weight: 400;
        margin-left: 2px;
      }
      .ma-card-header-tag {
        display: inline-flex;
        align-items: center;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .04em;
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: 3px;
        margin-left: 2px;
      }
      .ma-card-header-tag.ai   { background: #e8f0fe; color: #1967d2; }
      .ma-card-header-tag.draft { background: rgba(0,0,0,.06); color: #5f6368; }
      .ma-card-header-right {
        margin-left: auto;
        font-size: 11px;
        color: var(--deemphasized-text-color, #80868b);
        white-space: nowrap;
      }

      /* Body */
      .ma-card-body {
        padding: var(--spacing-m);
        white-space: pre-wrap;
        line-height: 1.55;
        font-size: var(--font-size-normal, 13px);
        border-bottom: 1px solid rgba(0,0,0,.07);
      }

      /* Edit area */
      .ma-card-edit {
        display: none;
        padding: var(--spacing-m);
        border-bottom: 1px solid rgba(0,0,0,.07);
      }
      .ma-card-edit textarea {
        display: block;
        width: 100%;
        box-sizing: border-box;
        min-height: 80px;
        resize: vertical;
        font: inherit;
        font-size: var(--font-size-normal, 13px);
        padding: var(--spacing-s);
        background: #fff;
        border: 1px solid var(--border-color, #dadce0);
        border-radius: 4px;
        color: var(--primary-text-color, #202124);
        outline: none;
        transition: border-color .15s;
      }
      .ma-card-edit textarea:focus { border-color: #1967d2; }
      .ma-card-edit-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-s);
        margin-top: var(--spacing-s);
      }

      /* Footer */
      .ma-card-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-s) var(--spacing-m);
      }
      .ma-resolved-label {
        display: flex;
        align-items: center;
        gap: var(--spacing-s);
        font-size: var(--font-size-normal, 13px);
        color: var(--primary-text-color, #202124);
        cursor: pointer;
        user-select: none;
      }
      .ma-resolved-label input[type="checkbox"] {
        width: 14px; height: 14px;
        cursor: pointer;
        accent-color: #1967d2;
        margin: 0;
      }
      .ma-card-actions {
        display: flex;
        gap: 2px;
        align-items: center;
      }

      /* Buttons */
      .ma-btn {
        background: none;
        border: none;
        cursor: pointer;
        font: inherit;
        font-size: var(--font-size-normal, 13px);
        font-weight: 500;
        padding: 3px 6px;
        border-radius: 3px;
        color: var(--link-color, #1967d2);
        transition: background .12s;
        line-height: 1.4;
      }
      .ma-btn:hover { background: rgba(25,103,210,.1); }
      .ma-btn:disabled { opacity: .5; cursor: default; }
      .ma-btn.danger { color: rgb(217,48,37); }
      .ma-btn.danger:hover { background: rgba(217,48,37,.08); }
      .ma-btn.muted  { color: var(--deemphasized-text-color, #80868b); }
      .ma-btn.muted:hover { background: rgba(0,0,0,.06); }
    `;
    diffElement.appendChild(s);
  }

  // ── FAB + AI panel ────────────────────────────────────────────────────────
  let fabEl  = null;
  let panelEl = null;
  let logEl   = null;

  function injectAiPanel() {
    if (document.getElementById('ma-ai-fab')) return;

    // FAB
    const fab = document.createElement('button');
    fab.id = 'ma-ai-fab';
    fab.innerHTML = '🤖';
    fab.title = 'AI Code Review (Ctrl+Shift+A)';
    Object.assign(fab.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '9999',
      width: '56px', height: '56px', borderRadius: '50%',
      background: '#1a73e8', color: '#fff', border: 'none',
      cursor: 'pointer', fontSize: '22px',
      boxShadow: '0 4px 12px rgba(0,0,0,.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'transform .15s',
    });
    fab.addEventListener('mouseenter', () => fab.style.transform = 'scale(1.08)');
    fab.addEventListener('mouseleave', () => fab.style.transform = '');
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);
    fabEl = fab;

    // Panel
    const panel = document.createElement('div');
    panel.id = 'ma-ai-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '88px', right: '24px', zIndex: '9999',
      width: '360px', background: '#fff', borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,.22)',
      display: 'none', flexDirection: 'column', overflow: 'hidden',
      fontFamily: "var(--font-family),'Roboto',Arial,sans-serif",
    });

    panel.innerHTML = `
      <div style="background:#1a73e8;color:#fff;padding:14px 16px 10px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:18px;">🤖</span>
        <span style="flex:1;font-size:15px;font-weight:500;">AI Code Review</span>
        <button id="ma-panel-close" style="background:none;border:none;color:rgba(255,255,255,.8);cursor:pointer;font-size:20px;line-height:1;padding:0;" title="Close">×</button>
      </div>
      <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
        <div>
          <label style="font-size:11px;color:#5f6368;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Focus area (optional)</label>
          <textarea id="ma-prompt-input" rows="3" placeholder="e.g. Focus on null safety and error handling…"
            style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dadce0;border-radius:6px;font:inherit;font-size:13px;resize:vertical;transition:border-color .2s;outline:none;"></textarea>
        </div>
        <div id="ma-history-row" style="display:none;">
          <label style="font-size:11px;color:#5f6368;display:block;margin-bottom:3px;">Recent prompts</label>
          <select id="ma-history-select" style="width:100%;padding:5px 8px;border:1px solid #dadce0;border-radius:6px;font-size:12px;color:#444;background:#fafafa;">
            <option value="">— select a previous prompt —</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="ma-review-btn" style="flex:1;padding:9px 0;background:#1a73e8;color:#fff;border:none;border-radius:6px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .2s;">
            Run AI Review
          </button>
          <button id="ma-clear-btn" title="Clear history" style="padding:9px 12px;background:#f1f3f4;color:#5f6368;border:none;border-radius:6px;font:inherit;font-size:12px;cursor:pointer;">🗑</button>
        </div>
        <div id="ma-log" style="display:none;background:#f8f9fa;border-radius:6px;padding:10px;font-size:12px;color:#3c4043;max-height:160px;overflow-y:auto;line-height:1.6;font-family:monospace;"></div>
      </div>
    `;

    document.body.appendChild(panel);
    panelEl = panel;
    logEl   = panel.querySelector('#ma-log');

    panel.querySelector('#ma-panel-close').addEventListener('click', closePanel);
    panel.querySelector('#ma-review-btn').addEventListener('click', runAiReview);
    panel.querySelector('#ma-clear-btn').addEventListener('click', () => {
      localStorage.removeItem(HISTORY_KEY);
      refreshHistoryDropdown();
    });
    panel.querySelector('#ma-prompt-input').addEventListener('focus', e => e.target.style.borderColor = '#1a73e8');
    panel.querySelector('#ma-prompt-input').addEventListener('blur',  e => e.target.style.borderColor = '#dadce0');
    panel.querySelector('#ma-history-select').addEventListener('change', e => {
      if (e.target.value) panel.querySelector('#ma-prompt-input').value = e.target.value;
    });

    refreshHistoryDropdown();
  }

  function refreshHistoryDropdown() {
    if (!panelEl) return;
    const sel  = panelEl.querySelector('#ma-history-select');
    const row  = panelEl.querySelector('#ma-history-row');
    const hist = loadHistory();
    if (!hist.length) { row.style.display = 'none'; return; }
    row.style.display = 'block';
    sel.innerHTML = '<option value="">— select a previous prompt —</option>' +
      hist.map(p => `<option value="${escHtml(p)}">${escHtml(p.slice(0,60))}${p.length>60?'…':''}</option>`).join('');
  }

  function togglePanel() {
    if (!panelEl) return;
    const open = panelEl.style.display !== 'none';
    panelEl.style.display = open ? 'none' : 'flex';
    if (!open) panelEl.querySelector('#ma-prompt-input').focus();
  }
  function closePanel() { if (panelEl) panelEl.style.display = 'none'; }

  function logMsg(msg, type = 'info') {
    if (!logEl) return;
    logEl.style.display = 'block';
    const colors   = { info:'#3c4043', ok:'#2e7d32', err:'#c62828', muted:'#80868b' };
    const prefixes = { info:'▸ ', ok:'✓ ', err:'✗ ', muted:'  ' };
    const line = document.createElement('div');
    line.style.color = colors[type] || colors.info;
    line.textContent = (prefixes[type]||'') + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function clearLog() { if (logEl) { logEl.innerHTML = ''; logEl.style.display = 'none'; } }

  // ── Run AI review ─────────────────────────────────────────────────────────
  async function runAiReview() {
    const changeNum = getChangeNumber();
    const patchSet  = getPatchSetNumber();
    if (!changeNum) { logMsg('Cannot detect change number from URL', 'err'); return; }

    const btn    = panelEl.querySelector('#ma-review-btn');
    const prompt = panelEl.querySelector('#ma-prompt-input').value.trim();

    btn.disabled    = true;
    btn.textContent = 'Reviewing…';
    clearLog();
    logMsg('Sending diff to AI…');

    try {
      pushHistory(prompt);
      refreshHistoryDropdown();

      const result = await restApi.post(
        `/changes/${changeNum}/revisions/${patchSet}/ai-review`,
        { prompt }
      );

      logMsg(typeof result === 'string' ? result : 'AI review complete.', 'ok');
      logMsg('Loading comment data…', 'muted');

      await loadMultiAnchorComments(changeNum, patchSet);
      setupNativeThreadHider();

      logMsg('Refreshing diff view…', 'muted');

      const grDiffHost = getGrDiffHost();
      if (grDiffHost) {
        grDiffHost.dispatchEvent(new CustomEvent('reload', {
          bubbles: true, composed: true, detail: { clearPatchset: false }
        }));
      }

      let diffElement = null;
      let table = null;
      for (let i = 0; i < 30; i++) {
        await delay(150);
        diffElement = getDiffElement();
        table = diffElement?.querySelector('table#diffTable');
        if (table) break;
      }
      if (diffElement) injectStyles(diffElement);
      if (table) displaySavedComments(table);

      updateFabBadge();
      logMsg('Done — AI drafts are now visible below the diff.', 'ok');

      btn.textContent = '✓ Done';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Run AI Review'; }, 3000);

    } catch (err) {
      logMsg('Error: ' + (err.message || String(err)), 'err');
      btn.disabled    = false;
      btn.textContent = 'Run AI Review';
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── FAB badge ─────────────────────────────────────────────────────────────
  function updateFabBadge() {
    if (!fabEl) return;
    fabEl.querySelector('.ma-fab-badge')?.remove();
    const n = savedComments.size;
    if (!n) return;
    const badge = document.createElement('span');
    badge.className = 'ma-fab-badge';
    Object.assign(badge.style, {
      position:'absolute', top:'6px', right:'6px',
      background:'#ea4335', color:'#fff',
      borderRadius:'8px', fontSize:'10px', fontWeight:'700',
      padding:'1px 5px', lineHeight:'1.4', pointerEvents:'none',
    });
    badge.textContent = n;
    fabEl.style.position = 'relative';
    fabEl.appendChild(badge);
  }

  // ── Keyboard shortcut ─────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') { e.preventDefault(); togglePanel(); }
  });

  // ── Native-thread hider ────────────────────────────────────────────────────
  let nativeObserver = null;
  let hidePoller     = null;

  function setupNativeThreadHider() {
    const grDiffHost = getGrDiffHost();
    if (!grDiffHost?.shadowRoot) return;
    if (nativeObserver) nativeObserver.disconnect();
    clearInterval(hidePoller);
    const root = grDiffHost.shadowRoot;

    injectHiderStyle(root);

    const hideAll = () => {
      root.querySelectorAll('gr-comment-thread').forEach(el => {
        try {
          if (el.dataset.maHidden) return;
          let shouldHide = false;

          const thread = el.thread;
          if (thread) {
            const rootId   = thread.rootId || thread.comments?.[0]?.id;
            const firstMsg = thread.comments?.[0]?.message || '';
            shouldHide = (rootId && savedComments.has(rootId)) || firstMsg.startsWith(AI_PREFIX);
          }
          if (!shouldHide && (el.innerText || '').includes('🤖 AI Review:')) shouldHide = true;
          if (!shouldHide && el.shadowRoot?.innerHTML.includes('🤖 AI Review:')) shouldHide = true;

          if (shouldHide) {
            el.dataset.maHidden = '1';
            el.style.display = 'none';
            const tr = el.closest('tr');
            if (tr) tr.style.display = 'none';
          }
        } catch { /* element mid-upgrade */ }
      });
    };

    nativeObserver = new MutationObserver(() => {
      hideAll();
      setTimeout(hideAll, 50);
      setTimeout(hideAll, 150);
      setTimeout(hideAll, 400);
    });
    nativeObserver.observe(root, { childList: true, subtree: true });

    let pollCount = 0;
    hidePoller = setInterval(() => {
      hideAll();
      if (++pollCount >= 40) clearInterval(hidePoller);
    }, 100);
  }

  function injectHiderStyle(shadowRoot) {
    if (shadowRoot.querySelector('#ma-hider-style')) return;
    const s = document.createElement('style');
    s.id = 'ma-hider-style';
    s.textContent = `
      gr-comment-thread[data-ma-hidden="1"] { display: none !important; }
      tr:has(gr-comment-thread[data-ma-hidden="1"]) { display: none !important; }
    `;
    shadowRoot.appendChild(s);
  }

  // ── Diff table helpers ────────────────────────────────────────────────────
  function escHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  function markAnchoredLines(table, lines) {
    lines.forEach(key => {
      const [side, num] = key.split('-');
      table.querySelector(`td.${side}.lineNum[data-value="${num}"]`)
        ?.closest('tr')
        ?.querySelectorAll(`td.${side}`)
        .forEach(td => td.classList.add('multi-anchor-existing'));
    });
  }

  function addRangeBadge(table, lines) {
    const first = lines[0];
    if (!first) return;
    const [side, num] = first.split('-');
    const btn = table.querySelector(`td.${side}.lineNum[data-value="${num}"] button.lineNumButton`);
    if (!btn || btn.querySelector('.ma-range-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'ma-range-badge';
    badge.title = `Multi-anchor: ${lines.length} line ranges`;
    badge.textContent = `×${lines.length}`;
    btn.appendChild(badge);
  }

  function highlightLines(table, lines, on) {
    lines.forEach(key => {
      const [side, num] = key.split('-');
      table.querySelector(`td.${side}.lineNum[data-value="${num}"]`)
        ?.closest('tr')
        ?.querySelectorAll(`td.${side}`)
        .forEach(td => td.classList.toggle('multi-anchor-highlighted', on));
    });
  }

  // ── Display saved comments ─────────────────────────────────────────────────
  function displaySavedComments(table) {
    const diffElement = getDiffElement();
    if (diffElement) injectStyles(diffElement);

    table.querySelectorAll('.multi-anchor-thread').forEach(el => el.remove());
    table.querySelectorAll('td.multi-anchor-existing, td.multi-anchor-highlighted').forEach(td => {
      td.classList.remove('multi-anchor-existing', 'multi-anchor-highlighted');
    });
    table.querySelectorAll('.ma-range-badge').forEach(b => b.remove());

    savedComments.forEach((comment, commentId) => {
      const { lines, text, resolved } = comment;
      const isAi = text.startsWith('🤖 AI Review:');

      markAnchoredLines(table, lines);
      addRangeBadge(table, lines);

      const lineLabel = lines.map(k => {
        const [s, n] = k.split('-');
        return `${s === 'left' ? 'L' : 'R'}${n}`;
      }).join(', ');

      const displayText = isAi ? text.replace(/^🤖 AI Review:\n\n/, '') : text;

      const tr = document.createElement('tr');
      tr.className = 'multi-anchor-thread';
      tr.dataset.commentId = commentId;

      // ── Card HTML ──────────────────────────────────────────────────────
      // colspan="3" + single <td> matches the native thread column width
      tr.innerHTML = `
        <td colspan="3"></td>
        <td style="padding:0; border-top:1px solid var(--border-color); overflow:hidden;">
          <div class="ma-card${resolved ? ' resolved' : ''}">

            <div class="ma-card-header">
              <span class="ma-card-header-icon">${isAi ? '🤖' : '✏️'}</span>
              <span class="ma-card-header-title">${isAi ? 'AI Review' : 'Draft'}</span>
              <span class="ma-card-header-tag ${isAi ? 'ai' : 'draft'}">${isAi ? 'AI' : 'Draft'}</span>
              <span class="ma-card-header-meta">· ${escHtml(lineLabel)}</span>
              <span class="ma-card-header-right">${new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span>
            </div>

            <div class="ma-card-body">${escHtml(displayText)}</div>

            <div class="ma-card-edit">
              <textarea class="ma-edit-textarea">${escHtml(displayText)}</textarea>
              <div class="ma-card-edit-actions">
                <button class="ma-btn muted ma-edit-cancel">Cancel</button>
                <button class="ma-btn ma-edit-save">Save draft</button>
              </div>
            </div>

            <div class="ma-card-footer">
              <label class="ma-resolved-label">
                <input type="checkbox" class="ma-resolve-checkbox" ${resolved ? 'checked' : ''}>
                Resolved
              </label>
              <div class="ma-card-actions">
                <button class="ma-btn ma-edit-btn">Edit</button>
                <button class="ma-btn danger ma-discard-btn">Discard</button>
              </div>
            </div>

          </div>
        </td>
      `;

      // ── Wire up ────────────────────────────────────────────────────────
      const card     = tr.querySelector('.ma-card');
      const body     = tr.querySelector('.ma-card-body');
      const editArea = tr.querySelector('.ma-card-edit');
      const textarea = tr.querySelector('.ma-edit-textarea');

      tr.querySelector('.ma-resolve-checkbox').addEventListener('change', async ev => {
        ev.stopPropagation();
        comment.resolved = ev.target.checked;
        card.classList.toggle('resolved', comment.resolved);
        try {
          await updateDraft(
            getChangeNumber(), getPatchSetNumber(), commentId,
            isAi ? '🤖 AI Review:\n\n' + displayText : displayText,
            !comment.resolved
          );
        } catch { /* non-critical */ }
        displaySavedComments(table);
      });

      tr.querySelector('.ma-edit-btn').addEventListener('click', ev => {
        ev.stopPropagation();
        body.style.display     = 'none';
        editArea.style.display = 'block';
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });

      tr.querySelector('.ma-edit-cancel').addEventListener('click', ev => {
        ev.stopPropagation();
        body.style.display     = '';
        editArea.style.display = 'none';
      });

      tr.querySelector('.ma-edit-save').addEventListener('click', async ev => {
        ev.stopPropagation();
        const newText = textarea.value.trim();
        if (!newText) return;
        const btn = tr.querySelector('.ma-edit-save');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          const storageText = isAi ? '🤖 AI Review:\n\n' + newText : newText;
          await updateDraft(getChangeNumber(), getPatchSetNumber(), commentId, storageText, !comment.resolved);
          comment.text = storageText;
          displaySavedComments(table);
        } catch {
          btn.disabled = false; btn.textContent = 'Save draft';
        }
      });

      tr.querySelector('.ma-discard-btn').addEventListener('click', async ev => {
        ev.stopPropagation();
        const btn = tr.querySelector('.ma-discard-btn');
        btn.disabled = true; btn.textContent = 'Deleting…';
        const ok = await deleteMultiAnchorComment(commentId);
        if (ok) { displaySavedComments(table); updateFabBadge(); }
        else    { btn.disabled = false; btn.textContent = 'Discard'; }
      });

      tr.addEventListener('mouseenter', () => highlightLines(table, lines, true));
      tr.addEventListener('mouseleave', () => {
        if (!tr.classList.contains('ma-active')) highlightLines(table, lines, false);
      });
      tr.addEventListener('click', () => {
        const on = tr.classList.toggle('ma-active');
        highlightLines(table, lines, on);
      });

      const lastKey = lines[lines.length - 1];
      const lastRow = lastKey
        ? (() => {
            const [s, n] = lastKey.split('-');
            return table.querySelector(`td.${s}.lineNum[data-value="${n}"]`)?.closest('tr');
          })()
        : null;
      (lastRow || table).insertAdjacentElement('afterend', tr);
    });

    updateFabBadge();
  }

  // ── Manual multi-anchor selection ─────────────────────────────────────────
  const selectedLines = new Set();

  function toggleLine(key, side, row) {
    if (selectedLines.has(key)) {
      selectedLines.delete(key);
      row.querySelectorAll(`td.${side}`).forEach(td => td.classList.remove('multi-anchor-selected'));
    } else {
      selectedLines.add(key);
      row.querySelectorAll(`td.${side}`).forEach(td => td.classList.add('multi-anchor-selected'));
    }
  }

  function clearSelection(table) {
    selectedLines.clear();
    table.querySelectorAll('td.multi-anchor-selected').forEach(td => td.classList.remove('multi-anchor-selected'));
  }

  // ── Comment-draft box ─────────────────────────────────────────────────────
  function showCommentBox(table, lines) {
    table.querySelector('tr.multi-anchor-comment-row')?.remove();

    const lineLabel = [...lines].map(k => {
      const [s, n] = k.split('-');
      return `${s === 'left' ? 'L' : 'R'}${n}`;
    }).join(', ');

    const tr = document.createElement('tr');
    tr.className = 'multi-anchor-comment-row';

    // Same colspan="3" + single td as saved comments for consistent width
    tr.innerHTML = `
      <td colspan="3"></td>
      <td style="padding:0; border-top:1px solid var(--border-color); overflow:hidden;">
        <div class="ma-card">
          <div class="ma-card-header">
            <span class="ma-card-header-icon">✏️</span>
            <span class="ma-card-header-title">New draft</span>
            <span class="ma-card-header-tag draft">Draft</span>
            <span class="ma-card-header-meta">· ${escHtml(lineLabel)}</span>
          </div>
          <div style="padding: var(--spacing-m);">
            <textarea class="ma-new-textarea" rows="4" placeholder="Write a review comment…" style="
              display:block; width:100%; box-sizing:border-box; font:inherit;
              font-size:var(--font-size-normal,13px);
              padding: var(--spacing-s);
              background:#fff; border:1px solid var(--border-color,#dadce0);
              border-radius:4px; resize:vertical; color:var(--primary-text-color,#202124);
              outline:none; transition:border-color .15s;
            "></textarea>
          </div>
          <div class="ma-card-footer">
            <label class="ma-resolved-label">
              <input type="checkbox" class="ma-new-resolved">
              Mark as resolved
            </label>
            <div class="ma-card-actions">
              <button class="ma-btn muted ma-new-cancel">Cancel</button>
              <button class="ma-btn ma-new-save">Save draft</button>
            </div>
          </div>
        </div>
      </td>
    `;

    const lastKey = [...lines][lines.size - 1];
    const [lastSide, lastNum] = lastKey.split('-');
    const lastRow = table.querySelector(`td.${lastSide}.lineNum[data-value="${lastNum}"]`)?.closest('tr');
    (lastRow || table).insertAdjacentElement('afterend', tr);

    const textarea = tr.querySelector('.ma-new-textarea');
    textarea.focus();
    textarea.addEventListener('focus', () => textarea.style.borderColor = '#1967d2');
    textarea.addEventListener('blur',  () => textarea.style.borderColor = 'var(--border-color,#dadce0)');

    tr.querySelector('.ma-new-cancel').addEventListener('click', () => {
      tr.remove(); clearSelection(table);
    });

    tr.querySelector('.ma-new-save').addEventListener('click', async () => {
      const text     = textarea.value.trim();
      const resolved = tr.querySelector('.ma-new-resolved').checked;
      if (!text) return;
      const saveBtn = tr.querySelector('.ma-new-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      const draft = await createMultiAnchorComment(lines, text, resolved);
      if (draft) {
        tr.remove(); clearSelection(table);
        displaySavedComments(table);
      } else {
        saveBtn.disabled = false; saveBtn.textContent = 'Save draft';
      }
    });
  }

  // ── Attach everything to the diff table ──────────────────────────────────
  function attachListeners() {
    const diffElement = getDiffElement();
    if (!diffElement) { setTimeout(attachListeners, 500); return; }

    injectStyles(diffElement);
    injectAiPanel();

    const table = diffElement.querySelector('table#diffTable');
    if (!table) { setTimeout(attachListeners, 500); return; }

    setupNativeThreadHider();

    const changeNum = getChangeNumber();
    const patchSet  = getPatchSetNumber();
    if (changeNum) {
      loadMultiAnchorComments(changeNum, patchSet).then(() => {
        displaySavedComments(table);
        setupNativeThreadHider();
      });
    }

    table.addEventListener('click', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      const row = e.target.closest('tr');
      if (!row) return;
      const isRight = !!e.target.closest('td.right');
      const isLeft  = !!e.target.closest('td.left');
      if (!isRight && !isLeft) return;
      const side = isRight ? 'right' : 'left';
      const cell = row.querySelector(`td.${side}.lineNum`);
      const num  = cell?.dataset.value;
      if (!num || num === 'LOST' || num === 'FILE') return;
      toggleLine(`${side}-${num}`, side, row);
      e.preventDefault(); e.stopPropagation();
    });

    document.addEventListener('keydown', e => {
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'c' && selectedLines.size > 0) {
        if (table.querySelector('tr.multi-anchor-comment-row')) return;
        e.stopImmediatePropagation(); e.preventDefault();
        showCommentBox(table, selectedLines);
      }
      if (e.key === 'Escape') {
        table.querySelector('tr.multi-anchor-comment-row')?.remove();
        clearSelection(table);
      }
    }, true);
  }

  setTimeout(attachListeners, 1000);
});

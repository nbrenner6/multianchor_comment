/**
 * Multi-Anchor Comment Plugin for Gerrit
 *
 * Extends Gerrit's code-review UI to support comments anchored to multiple
 * non-adjacent line ranges across multiple files in a single diff. Standard
 * Gerrit only allows a comment on one contiguous range; this plugin lets
 * reviewers reference scattered-but-related lines (e.g. a renamed variable
 * and all its call sites, or a call site and its definition in another file)
 * in one comment thread.
 *
 */
Gerrit.install(plugin => {

  // ── User-testing logger ────────────────────────────────────────────────────
  /**
   * Structured logger for user-testing analytics.
   *
   * Every event is written to:
   *   1. console.log  – standard DevTools console (filterable by "[MA]")
   *   2. sessionStorage["ma_plugin_log"] – JSON array persisted for the tab
   *      (survives page reloads within the same tab session; copy via
   *       JSON.parse(sessionStorage.getItem('ma_plugin_log')) in DevTools)
   *
   * Event schema:
   *   { ts, isoTs, event, category, data }
   *
   * Categories: session | anchor | comment | ai | ui | error
   */
  const MALog = (() => {
    const SESSION_KEY = 'ma_plugin_log';
    const SESSION_ID  = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    function _persist(entry) {
      try {
        const raw  = sessionStorage.getItem(SESSION_KEY);
        const arr  = raw ? JSON.parse(raw) : [];
        arr.push(entry);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(arr));
      } catch (e) {
        // sessionStorage full or unavailable – silent fail
      }
    }

    function _emit(category, event, data = {}) {
      const now   = Date.now();
      const entry = {
        ts:       now,
        isoTs:    new Date(now).toISOString(),
        sessionId: SESSION_ID,
        category,
        event,
        data,
      };
      console.log(`[MA] [${category.toUpperCase()}] ${event}`, data);
      _persist(entry);
      return entry;
    }

    return {
      sessionId: SESSION_ID,
      session(event, data)  { return _emit('session',  event, data); },
      anchor(event, data)   { return _emit('anchor',   event, data); },
      comment(event, data)  { return _emit('comment',  event, data); },
      ai(event, data)       { return _emit('ai',       event, data); },
      ui(event, data)       { return _emit('ui',       event, data); },
      error(event, data)    { return _emit('error',    event, data); },
      export() {
        try {
          return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]');
        } catch { return []; }
      },
      clear() {
        sessionStorage.removeItem(SESSION_KEY);
        console.log('[MA] Log cleared.');
      },
    };
  })();

  window.MALog = MALog;

  MALog.session('plugin_init', {
    url:       window.location.href,
    userAgent: navigator.userAgent,
  });

  // ── REST helper ────────────────────────────────────────────────────────────
  const restApi = plugin.restApi();

  // ── In-memory store ────────────────────────────────────────────────────────
  const savedComments = new Map();
  const managedGerritIds = new Set();
  let activeEditState = null;
  let editingCommentId = null;

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
  function toPluginUrlId(rawGerritId, patchSet) {
    return `${patchSet}~${rawGerritId}`;
  }
  function toPluginStorageKey(rawGerritId, patchSet) {
    if (!rawGerritId) return rawGerritId;
    return `${patchSet}/${rawGerritId}`;
  }
  function toGerritDraftId(storageKey) {
    return storageKey.includes('/') ? storageKey.split('/').slice(1).join('/') : storageKey;
  }

  function snapshotActiveEditState() {
    let openEdit = null;
    walkShadowTree(document.body, node => {
      if (openEdit || node.nodeType !== 1 || !node.matches) return;
      if (node.matches('.ma-card-edit') && node.style.display === 'block') {
        openEdit = node;
      }
    });
    if (!openEdit) {
      activeEditState = null;
      return;
    }
    const thread = openEdit.closest('tr.multi-anchor-thread');
    const textarea = openEdit.querySelector('.ma-edit-textarea');
    if (!thread || !textarea) return;
    activeEditState = {
      commentId: thread.dataset.commentId,
      text: textarea.value,
    };
  }

  function isEditSessionActive() {
    if (editingCommentId) return true;
    if (!activeEditState?.commentId) return false;
    let found = false;
    walkShadowTree(document.body, node => {
      if (found || node.nodeType !== 1 || !node.matches) return;
      if (!node.matches('tr.multi-anchor-thread')) return;
      if (node.dataset.commentId !== activeEditState.commentId) return;
      const editArea = node.querySelector('.ma-card-edit');
      if (editArea?.style?.display === 'block') found = true;
    });
    return found;
  }

  // ── Effective patchset resolution ──────────────────────────────────────────
  let effectivePatchSetCache = { changeNum: null, urlToken: null, resolved: null };

  async function getEffectivePatchSetNumber(changeNum) {
    const urlToken = getPatchSetNumber();
    if (urlToken !== 'current') {
      return urlToken;
    }
    if (
      effectivePatchSetCache.changeNum === changeNum &&
      effectivePatchSetCache.urlToken === urlToken &&
      effectivePatchSetCache.resolved != null
    ) {
      return effectivePatchSetCache.resolved;
    }
    try {
      const detail = await restApi.get(`/changes/${changeNum}/detail`);
      const rev = detail.revisions[detail.current_revision];
      const resolved = String(rev._number);
      effectivePatchSetCache = { changeNum, urlToken, resolved };
      return resolved;
    } catch (e) {
      console.error('[MA] getEffectivePatchSetNumber failed — falling back to "current":', e);
      MALog.error('patchset_resolve_failed', {
        changeNum,
        error: e?.message || String(e),
      });
      return 'current';
    }
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

  // ── Multi-file anchor key helpers ──────────────────────────────────────────
  function makeAnchorKey(filePath, side, lineNum) {
    return JSON.stringify({ p: filePath, s: side, n: String(lineNum) });
  }

  function parseAnchorKey(key) {
    try {
      const o = JSON.parse(key);
      if (o && o.p != null && o.s && o.n != null) {
        return { path: o.p, side: o.s, lineNum: o.n };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function formatAnchorLabel(key) {
    const a = parseAnchorKey(key);
    if (!a) return key;
    const base = (a.path && a.path.includes('/')) ? a.path.split('/').pop() : a.path;
    const lr = a.side === 'left' ? 'L' : 'R';
    return a.path ? `${base}:${lr}${a.lineNum}` : `${lr}${a.lineNum}`;
  }

  function formatGroupedAnchorLabels(keys) {
    const byPath = new Map();
    keys.forEach(key => {
      const a = parseAnchorKey(key);
      if (!a) return;
      const base = (a.path && a.path.includes('/')) ? a.path.split('/').pop() : a.path;
      const fileLabel = base || a.path || 'unknown-file';
      const lineLabel = `${a.side === 'left' ? 'L' : 'R'}${a.lineNum}`;
      if (!byPath.has(fileLabel)) byPath.set(fileLabel, []);
      byPath.get(fileLabel).push(lineLabel);
    });
    if (byPath.size === 0) return keys.map(formatAnchorLabel).join(', ');
    return [...byPath.entries()]
      .map(([fileLabel, lines]) => `${fileLabel}: ${lines.join(', ')}`)
      .join('; ');
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

  function getGrDiffHostFromNode(node) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.tagName === 'GR-DIFF-HOST') {
        return n;
      }
      const root = n.getRootNode();
      if (root && root.host) {
        n = root.host;
      } else {
        n = n.parentElement;
      }
    }
    return null;
  }

  function getFilePathForDiffContext(node) {
    const host = getGrDiffHostFromNode(node);
    if (!host) return '';
    return host.path || host.getAttribute?.('path') || '';
  }

  function getTablePathPair(diffElement) {
    if (!diffElement) return { table: null, filePath: '' };
    const table =
      (diffElement.shadowRoot && diffElement.shadowRoot.querySelector('table#diffTable')) ||
      diffElement.querySelector('table#diffTable');
    const filePath = getFilePathForDiffContext(diffElement);
    return { table, filePath };
  }

  function getLastAnchorKeyForFile(keys, currentPath) {
    for (let i = keys.length - 1; i >= 0; i--) {
      const a = parseAnchorKey(keys[i]);
      if (a && a.path === currentPath) return keys[i];
    }
    return null;
  }

  function findRowForAnchor(table, anchor) {
    if (!table || !anchor) return null;
    return table.querySelector(`td.${anchor.side}.lineNum[data-value="${anchor.lineNum}"]`)?.closest('tr') || null;
  }

  function walkShadowTree(node, callback) {
    if (!node) return;
    callback(node);
    if (node.shadowRoot) walkShadowTree(node.shadowRoot, callback);
    const ch = node.children;
    if (ch) {
      for (let i = 0; i < ch.length; i++) walkShadowTree(ch[i], callback);
    }
  }

  // ── REST: Gerrit drafts ────────────────────────────────────────────────────
  async function createDraft(changeNum, patchSet, path, range, message, unresolved) {
    const body = { path, line: range.end_line, message, unresolved };
    return restApi.put(`/changes/${changeNum}/revisions/${patchSet}/drafts`, body);
  }

  async function updateDraft(changeNum, patchSet, draftId, message, unresolved) {
    console.log(`[MA] updateDraft: change=${changeNum} ps=${patchSet} id=${draftId}`);
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
  async function saveAdditionalRanges(changeNum, urlId, ranges) {
    return restApi.put(`/changes/${changeNum}/multianchor-ranges/${urlId}`, { ranges });
  }
  async function deleteAdditionalRanges(changeNum, urlId) {
    return restApi.delete(`/changes/${changeNum}/multianchor-ranges/${urlId}`);
  }
  async function getAllAdditionalRanges(changeNum) {
    return restApi.get(`/changes/${changeNum}/multianchor-ranges`);
  }

  // ── Convert anchor keys to/from REST range objects ─────────────────────────
  function anchorKeysToRanges(lineKeys, side) {
    const nums = [...lineKeys]
      .map(k => parseAnchorKey(k))
      .filter(a => a && a.side === side)
      .map(a => parseInt(a.lineNum, 10))
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

  // ── Load multi-anchor comments from backend ────────────────────────────────
  const AI_PREFIX = '🤖 AI Review:';
  let commentsLoading = false;
  let commentsLoaded  = false;

  async function loadMultiAnchorComments(changeNum, patchSet) {
    commentsLoading = true;
    commentsLoaded  = false;
    MALog.session('load_comments_start', { changeNum, patchSet });
    try {
      const [drafts, additionalRanges] = await Promise.all([
        restApi.get(`/changes/${changeNum}/revisions/${patchSet}/drafts`),
        getAllAdditionalRanges(changeNum),
      ]);

      savedComments.clear();
      managedGerritIds.clear();

      let loadedCount = 0;
      let aiCount     = 0;
      let multiCount  = 0;

      for (let [path, comments] of Object.entries(drafts || {})) {
        path = path.replace(/^\[(.+?)\]\(.+?\)$/, '$1');
        for (const comment of comments) {
          const storageKey = toPluginStorageKey(comment.id, patchSet);
          const extraRanges = additionalRanges[storageKey] || [];
          const isAiComment = comment.message?.startsWith(AI_PREFIX);
          const isPluginManaged = storageKey in (additionalRanges || {});
          if (!isPluginManaged && !isAiComment) continue;

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
            for (let l = start; l <= end; l++) keys.push(makeAnchorKey(path, 'right', String(l)));
            return keys;
          });

          if (lines.length === 0) continue;

          savedComments.set(storageKey, {
            id: storageKey,
            path,
            patchSet,
            lines,
            text: comment.message,
            resolved: comment.unresolved === false,
            isDraft: true,
            primaryRange,
            additionalRanges: extraRanges,
          });

          managedGerritIds.add(comment.id);

          loadedCount++;
          if (isAiComment) aiCount++;
          if (extraRanges.length > 0) multiCount++;
        }
      }

      MALog.session('load_comments_complete', {
        changeNum,
        patchSet,
        totalLoaded:    loadedCount,
        aiComments:     aiCount,
        multiAnchorComments: multiCount,
      });

      lastLoadTs = Date.now();
      return savedComments;
    } catch (e) {
      MALog.error('load_comments_failed', {
        changeNum,
        patchSet,
        error: e?.message || String(e),
      });
      return savedComments;
    } finally {
      commentsLoading = false;
      commentsLoaded  = true;
    }
  }

  // ── Create / delete multi-anchor comments ─────────────────────────────────
  async function createMultiAnchorComment(selectedLines, message, resolved) {
    const changeNum = getChangeNumber();
    const patchSet  = await getEffectivePatchSetNumber(changeNum);
    if (!changeNum) return null;

    let rightCount = 0, leftCount = 0;
    selectedLines.forEach(k => {
      const a = parseAnchorKey(k);
      if (a?.side === 'right') rightCount++;
      else if (a?.side === 'left') leftCount++;
    });
    const side = rightCount >= leftCount ? 'right' : 'left';

    const firstAnchor = parseAnchorKey([...selectedLines][0]);
    const path = firstAnchor?.path || getFilePath();
    if (!path) return null;

    const allRanges = anchorKeysToRanges(selectedLines, side);
    if (!allRanges.length) return null;

    const anchorsByFile = {};
    selectedLines.forEach(k => {
      const a = parseAnchorKey(k);
      if (!a) return;
      if (!anchorsByFile[a.path]) anchorsByFile[a.path] = [];
      anchorsByFile[a.path].push({ side: a.side, line: a.lineNum });
    });
    const isMultiFile  = Object.keys(anchorsByFile).length > 1;
    const isMultiRange = allRanges.length > 1;

    MALog.comment('create_start', {
      changeNum,
      patchSet,
      primaryPath:    path,
      anchorCount:    selectedLines.size,
      fileCount:      Object.keys(anchorsByFile).length,
      isMultiFile,
      isMultiRange,
      rangeCount:     allRanges.length,
      resolved,
      messageLength:  message.length,
      anchorsByFile,
    });

    let draft = null;
    let fullDraftId = null;
    try {
      draft = await createDraft(changeNum, patchSet, path, allRanges[0], message, !resolved);

      fullDraftId = toPluginStorageKey(draft.id, patchSet);
      const urlId = toPluginUrlId(draft.id, patchSet);

      const additionalRanges = allRanges.slice(1);
      try {
        await saveAdditionalRanges(changeNum, urlId, additionalRanges);
      } catch (rangeError) {
        console.error('Failed to save additional ranges, compensating by deleting draft:', rangeError);
        MALog.error('create_additional_ranges_failed', {
          commentId: draft.id,
          changeNum,
          patchSet,
          error: rangeError?.message || String(rangeError),
          compensating: true,
        });
        try {
          await deleteDraft(changeNum, patchSet, draft.id);
        } catch (deleteError) {
          console.error('Compensation delete failed:', deleteError);
          MALog.error('create_compensation_delete_failed', {
            commentId: draft.id,
            error: deleteError?.message || String(deleteError),
          });
        }
        throw rangeError;
      }

      savedComments.set(fullDraftId, {
        id:               fullDraftId,
        path,
        patchSet,
        lines:            [...selectedLines],
        text:             message,
        resolved,
        isDraft:          true,
        primaryRange:     allRanges[0],
        additionalRanges: allRanges.slice(1),
      });

      managedGerritIds.add(draft.id);

      lastLoadTs = Date.now();

      MALog.comment('create_success', {
        commentId:      draft.id,
        changeNum,
        patchSet,
        primaryPath:    path,
        anchorCount:    selectedLines.size,
        fileCount:      Object.keys(anchorsByFile).length,
        isMultiFile,
        isMultiRange,
        rangeCount:     allRanges.length,
        resolved,
        messageLength:  message.length,
        messagePreview: message.slice(0, 80),
        anchorsByFile,
      });

      return { draft, error: null };
    } catch (error) {
      console.error('[MA] createMultiAnchorComment failed:', error);
      MALog.error('create_failed', {
        changeNum,
        patchSet,
        primaryPath: path,
        error: error?.message || String(error),
      });
      return { draft: null, error };
    }
  }

  async function deleteMultiAnchorComment(commentId) {
    const changeNum = getChangeNumber();
    const commentMeta = savedComments.get(commentId);
    const patchSet =
      commentMeta?.patchSet != null
        ? String(commentMeta.patchSet)
        : await getEffectivePatchSetNumber(changeNum);
    if (!changeNum) return false;

    MALog.comment('delete_start', {
      commentId,
      changeNum,
      patchSet,
      path:        commentMeta?.path,
      anchorCount: commentMeta?.lines?.length,
      isAi:        commentMeta?.text?.startsWith(AI_PREFIX),
    });

    try {
      const rawGerritId = commentId.includes('/') ? commentId.split('/').slice(1).join('/') : commentId;
      const urlId = toPluginUrlId(rawGerritId, patchSet);
      const gerritId = rawGerritId;

      await deleteDraft(changeNum, patchSet, gerritId);

      let rangeDeleteSuccess = false;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await deleteAdditionalRanges(changeNum, urlId);
          rangeDeleteSuccess = true;
          break;
        } catch (rangeError) {
          lastError = rangeError;
          console.warn(`Attempt ${attempt + 1} to delete additional ranges failed:`, rangeError);
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          }
        }
      }

      if (!rangeDeleteSuccess) {
        console.error('Partial delete: draft deleted but additional ranges remain:', lastError);
        MALog.error('delete_partial_ranges_orphaned', {
          commentId,
          changeNum,
          patchSet,
          error: lastError?.message || String(lastError),
        });
      }

      savedComments.delete(commentId);
      managedGerritIds.delete(toGerritDraftId(commentId));

      MALog.comment('delete_success', {
        commentId,
        changeNum,
        patchSet,
        rangesAlsoDeleted: rangeDeleteSuccess,
      });

      return true;
    } catch (error) {
      console.error('Failed to delete multi-anchor comment:', error);
      MALog.error('delete_failed', {
        commentId,
        changeNum,
        patchSet,
        error: error?.message || String(error),
      });
      return false;
    }
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

      /* Edit area — hidden by default via inline style, not CSS class */
      .ma-card-edit {
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
        position: relative;
        z-index: 3;
        pointer-events: auto;
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

  function ensureStylesInjected(diffElement) {
    if (!diffElement) return;
    if (!diffElement.dataset.multianchorStylesInjected) {
      diffElement.dataset.multianchorStylesInjected = '1';
      injectStyles(diffElement);
    }
  }

  // ── FAB + AI panel ────────────────────────────────────────────────────────
  let fabEl   = null;
  let panelEl = null;
  let logEl   = null;

  /* istanbul ignore start */
  function injectAiPanel() {
    if (document.getElementById('ma-ai-fab-wrapper')) return;
    if (document.getElementById('ma-ai-fab')) return;

    const fabWrapper = document.createElement('div');
    fabWrapper.id = 'ma-ai-fab-wrapper';
    Object.assign(fabWrapper.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      width: '56px',
      height: '56px',
      zIndex: '99999',
      transform: 'none',
      filter: 'none',
      contain: 'none',
    });

    const fab = document.createElement('button');
    fab.id = 'ma-ai-fab';
    fab.innerHTML = '🤖';
    fab.title = 'AI Code Review (Ctrl+Shift+A)';
    Object.assign(fab.style, {
      width: '56px', height: '56px', borderRadius: '50%',
      background: '#1a73e8', color: '#fff', border: 'none',
      cursor: 'pointer', fontSize: '22px',
      boxShadow: '0 4px 12px rgba(0,0,0,.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'transform .15s',
    });
    fab.addEventListener('mouseenter', () => fab.style.transform = 'scale(1.08)');
    fab.addEventListener('mouseleave', () => fab.style.transform = '');
    fab.addEventListener('click', () => {
      MALog.ui('fab_clicked', { currentPanelOpen: panelEl?.style.display !== 'none' });
      togglePanel();
    });
    fabWrapper.appendChild(fab);
    document.documentElement.appendChild(fabWrapper);
    fabEl = fab;

    const panel = document.createElement('div');
    panel.id = 'ma-ai-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      bottom: '88px',
      right: '24px',
      zIndex: '99999',
      width: '360px',
      background: '#fff',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,.22)',
      display: 'none',
      flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: "var(--font-family),'Roboto',Arial,sans-serif",
      transform: 'none',
      filter: 'none',
      contain: 'none',
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

    document.documentElement.appendChild(panel);
    panelEl = panel;
    logEl = panel.querySelector('#ma-log');

    panel.querySelector('#ma-panel-close').addEventListener('click', () => {
      MALog.ui('ai_panel_closed', { via: 'close_button' });
      closePanel();
    });
    panel.querySelector('#ma-review-btn').addEventListener('click', runAiReview);
    panel.querySelector('#ma-clear-btn').addEventListener('click', () => {
      MALog.ui('prompt_history_cleared', {});
      localStorage.removeItem(HISTORY_KEY);
      refreshHistoryDropdown();
    });
    panel.querySelector('#ma-prompt-input').addEventListener('focus', e => e.target.style.borderColor = '#1a73e8');
    panel.querySelector('#ma-prompt-input').addEventListener('blur',  e => e.target.style.borderColor = '#dadce0');
    panel.querySelector('#ma-history-select').addEventListener('change', e => {
      if (e.target.value) {
        MALog.ui('prompt_history_selected', { prompt: e.target.value });
        panel.querySelector('#ma-prompt-input').value = e.target.value;
      }
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
    MALog.ui(open ? 'ai_panel_closed' : 'ai_panel_opened', { via: 'toggle' });
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
    const patchSet = await getEffectivePatchSetNumber(changeNum);
    if (!changeNum) {
      logMsg('Cannot detect change number from URL', 'err');
      MALog.error('ai_review_no_change_number', { url: window.location.href });
      return;
    }

    const btn    = panelEl.querySelector('#ma-review-btn');
    const prompt = panelEl.querySelector('#ma-prompt-input').value.trim();

    btn.disabled    = true;
    btn.textContent = 'Reviewing…';
    clearLog();
    logMsg('Sending diff to AI…');

    const reviewStartTs = Date.now();
    MALog.ai('review_requested', {
      changeNum,
      patchSet,
      promptLength:  prompt.length,
      promptPreview: prompt.slice(0, 120),
      hasPrompt:     prompt.length > 0,
      filePath:      getFilePath(),
    });

    try {
      pushHistory(prompt);
      refreshHistoryDropdown();

      const result = await restApi.post(
        `/changes/${changeNum}/revisions/${patchSet}/ai-review`,
        { prompt }
      );

      const durationMs = Date.now() - reviewStartTs;
      MALog.ai('review_complete', {
        changeNum,
        patchSet,
        durationMs,
        resultType: typeof result,
        resultPreview: (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 120),
      });

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
        const pair = getTablePathPair(diffElement);
        table = pair.table;
        if (table) break;
      }
      if (diffElement) ensureStylesInjected(diffElement);
      if (table) refreshCurrentDiffView();

      updateFabBadge();
      logMsg('Done — AI drafts are now visible below the diff.', 'ok');

      btn.textContent = '✓ Done';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Run AI Review'; }, 3000);

    } catch (err) {
      const durationMs = Date.now() - reviewStartTs;
      logMsg('Error: ' + (err.message || String(err)), 'err');
      MALog.error('ai_review_failed', {
        changeNum,
        patchSet,
        durationMs,
        error: err?.message || String(err),
      });
      btn.disabled    = false;
      btn.textContent = 'Run AI Review';
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  /* istanbul ignore end */

  // ── FAB badge ─────────────────────────────────────────────────────────────
  function updateFabBadge() {
    if (!fabEl) return;
    const wrapper = document.getElementById('ma-ai-fab-wrapper');
    if (!wrapper) return;
    wrapper.querySelector('.ma-fab-badge')?.remove();
    const n = savedComments.size;
    if (!n) return;
    const badge = document.createElement('span');
    badge.className = 'ma-fab-badge';
    Object.assign(badge.style, {
      position: 'absolute', top: '6px', right: '6px',
      background: '#ea4335', color: '#fff',
      borderRadius: '8px', fontSize: '10px', fontWeight: '700',
      padding: '1px 5px', lineHeight: '1.4', pointerEvents: 'none',
    });
    badge.textContent = n;
    wrapper.appendChild(badge);
  }

  // ── Keyboard shortcut ─────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      MALog.ui('keyboard_shortcut', { shortcut: 'Ctrl+Shift+A', action: 'toggle_ai_panel' });
      togglePanel();
    }
  });

  // ── Native-thread hider ────────────────────────────────────────────────────
  let nativeObserver = null;
  let hidePoller     = null;

  /* istanbul ignore start */
  function setupNativeThreadHider() {
    const grDiffHost = getGrDiffHost();
    if (!grDiffHost?.shadowRoot) return;
    if (nativeObserver) nativeObserver.disconnect();
    clearInterval(hidePoller);
    const root = grDiffHost.shadowRoot;

    injectHiderStyle(root);

    const hideAll = () => {
      walkShadowTree(root, treeNode => {
        if (treeNode.nodeType !== 1 || !treeNode.querySelectorAll) return;
        treeNode.querySelectorAll('gr-comment-thread').forEach(el => {
        try {
          if (el.dataset.maHidden) return;
          let shouldHide = false;

          const thread = el.thread;
          if (thread) {
            const rawId   = thread.rootId || thread.comments?.[0]?.id || '';
            const firstMsg = thread.comments?.[0]?.message || '';
            shouldHide = managedGerritIds.has(rawId) || firstMsg.startsWith(AI_PREFIX);
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
      if (++pollCount >= 180) clearInterval(hidePoller);
    }, 50);
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
  /* istanbul ignore end */

  // ── Diff table helpers ────────────────────────────────────────────────────
  function escHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  function markAnchoredLines(table, filePath, lines) {
    lines.forEach(lineKey => {
      const a = parseAnchorKey(lineKey);
      if (!a || a.path !== filePath) return;
      const row = findRowForAnchor(table, a);
      if (row) {
        row.querySelectorAll(`td.${a.side}`).forEach(td => td.classList.add('multi-anchor-existing'));
      }
    });
  }

  function addRangeBadge(table, filePath, lines) {
    let firstKey = null;
    for (const k of lines) {
      const a = parseAnchorKey(k);
      if (a && a.path === filePath) { firstKey = k; break; }
    }
    if (!firstKey) return;
    const a = parseAnchorKey(firstKey);
    const btn = findRowForAnchor(table, a)
      ?.querySelector(`td.${a.side}.lineNum button.lineNumButton`);
    if (!btn || btn.querySelector('.ma-range-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'ma-range-badge';
    badge.title = `Multi-anchor: ${lines.length} line(s) across all files`;
    badge.textContent = `×${lines.length}`;
    btn.appendChild(badge);
  }

  function highlightLines(table, filePath, lines, on) {
    lines.forEach(lineKey => {
      const a = parseAnchorKey(lineKey);
      if (!a || a.path !== filePath) return;
      const row = findRowForAnchor(table, a);
      if (row) {
        row.querySelectorAll(`td.${a.side}`).forEach(td =>
          td.classList.toggle('multi-anchor-highlighted', on));
      }
    });
  }

  // ── Pending selection helpers ──────────────────────────────────────────────
  function getPendingAnchorStats() {
    const files = new Set();
    selectedLines.forEach(key => {
      const a = parseAnchorKey(key);
      if (a && a.path) files.add(a.path);
    });
    return { anchorCount: selectedLines.size, fileCount: files.size };
  }

  function hasPendingAnchorsForFile(filePath) {
    for (const key of selectedLines) {
      const a = parseAnchorKey(key);
      if (a && a.path === filePath) return true;
    }
    return false;
  }

  function applyPendingSelectionToTable(table, filePath) {
    if (!table || !filePath) return 0;
    let count = 0;
    selectedLines.forEach(key => {
      const a = parseAnchorKey(key);
      if (!a || a.path !== filePath) return;
      const row = findRowForAnchor(table, a);
      if (row) { setSelectedVisual(row, a.side, true); count++; }
    });
    return count;
  }

  function schedulePendingSelectionReapply(filePath, attempt) {
    if (attempt >= 5) return;
    setTimeout(() => {
      const diffElement = getDiffElement();
      const { table, filePath: currentPath } = getTablePathPair(diffElement);
      if (!table || currentPath !== filePath) return;
      const applied = applyPendingSelectionToTable(table, filePath);
      if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
        schedulePendingSelectionReapply(filePath, attempt + 1);
      }
    }, 140);
  }

  // ── Display saved comments ─────────────────────────────────────────────────
  /**
   * Renders all saved comment threads that touch filePath into the diff table.
   * Multi-file comments appear once per file (under the last anchor in that file).
   *
   * FIX: Edit area is hidden via inline style (not CSS class) so JS can reliably
   * toggle it. Textarea value is set via .value (not innerHTML) to avoid double-
   * escaping. Resolved checkbox save no longer triggers a full re-render that
   * would destroy open edit state.
   *
   * FIX: Row insertion falls back to table.appendChild() when no anchor row is
   * found, keeping the row inside the table element.
   *
   * @param {HTMLTableElement} table
   * @param {string} filePath
   */
  function displaySavedComments(table, filePath, options = {}) {
    const { preserveOpenEdit = true } = options;
    const diffElement = getDiffElement();
    if (diffElement) ensureStylesInjected(diffElement);

    // Clear existing plugin rows and markers
    if (preserveOpenEdit) {
      snapshotActiveEditState();
    } else {
      activeEditState = null;
      editingCommentId = null;
    }
    table.querySelectorAll('.multi-anchor-thread').forEach(el => el.remove());
    table.querySelectorAll('td.multi-anchor-existing, td.multi-anchor-highlighted').forEach(td => {
      td.classList.remove('multi-anchor-existing', 'multi-anchor-highlighted');
    });
    table.querySelectorAll('.ma-range-badge').forEach(b => b.remove());

    savedComments.forEach((comment, commentId) => {
      const { lines, text, resolved } = comment;

      const hasAnchorHere = lines.some(lk => parseAnchorKey(lk)?.path === filePath);
      if (!hasAnchorHere) return;

      const isAi = text.startsWith(AI_PREFIX);

      markAnchoredLines(table, filePath, lines);
      addRangeBadge(table, filePath, lines);

      const lineLabel = formatGroupedAnchorLabels(lines);
      // Strip the AI prefix for display; keep raw text for edit textarea
      const displayText = isAi ? text.replace(/^🤖 AI Review:\n\n/, '') : text;

      const tr = document.createElement('tr');
      tr.className = 'multi-anchor-thread';
      tr.dataset.commentId = commentId;

      // Build card HTML — edit area starts hidden via inline style, NOT a CSS
      // display:none rule, so JS can reliably override it without specificity fights.
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

            <div class="ma-card-edit" style="display:none;">
              <textarea class="ma-edit-textarea" rows="5"></textarea>
              <div class="ma-card-edit-actions">
                <button type="button" class="ma-btn muted ma-edit-cancel">Cancel</button>
                <button type="button" class="ma-btn ma-edit-save">Save draft</button>
              </div>
            </div>

            <div class="ma-card-footer">
              <label class="ma-resolved-label">
                <input type="checkbox" class="ma-resolve-checkbox" ${resolved ? 'checked' : ''}>
                Resolved
              </label>
              <div class="ma-card-actions">
                <button type="button" class="ma-btn ma-edit-btn">Edit</button>
                <button type="button" class="ma-btn danger ma-discard-btn">Discard</button>
              </div>
            </div>

          </div>
        </td>
      `;

      // ── Wire up interactions ───────────────────────────────────────────
      const card     = tr.querySelector('.ma-card');
      const body     = tr.querySelector('.ma-card-body');
      const editArea = tr.querySelector('.ma-card-edit');
      editArea.addEventListener('click', ev => ev.stopPropagation());
      editArea.addEventListener('mousedown', ev => ev.stopPropagation());
      editArea.addEventListener('pointerdown', ev => ev.stopPropagation());
      // FIX: set textarea value via .value, not innerHTML, to avoid double-escaping
      const textarea = tr.querySelector('.ma-edit-textarea');
      const isEditingThisComment = activeEditState?.commentId === commentId;
      textarea.value = isEditingThisComment ? activeEditState.text : displayText;
      if (isEditingThisComment) {
        body.style.display = 'none';
        editArea.style.display = 'block';
      }
      textarea.addEventListener('input', () => {
        if (activeEditState?.commentId === commentId) {
          activeEditState.text = textarea.value;
        }
      });

      // ── Resolve checkbox ───────────────────────────────────────────────
      // FIX: update in-memory state and DOM only — no full re-render — so an
      // open edit panel isn't destroyed when the checkbox is toggled.
      tr.querySelector('.ma-resolve-checkbox').addEventListener('change', async ev => {
        ev.stopPropagation();
        const newResolved = ev.target.checked;
        MALog.comment('resolve_toggled', {
          commentId,
          resolved: newResolved,
          isAi,
          path: filePath,
        });
        comment.resolved = newResolved;
        card.classList.toggle('resolved', newResolved);
        try {
          const changeNum = getChangeNumber();
          const patchSet =
            comment.patchSet != null
              ? String(comment.patchSet)
              : await getEffectivePatchSetNumber(changeNum);
          const storageText = isAi ? AI_PREFIX + '\n\n' + displayText : displayText;
          await updateDraft(changeNum, patchSet, toGerritDraftId(commentId), storageText, !newResolved);
          MALog.comment('resolve_saved', { commentId, resolved: newResolved });
        } catch (err) {
          // Roll back the checkbox on failure
          ev.target.checked = !newResolved;
          comment.resolved = !newResolved;
          card.classList.toggle('resolved', !newResolved);
          MALog.error('resolve_save_failed', {
            commentId,
            error: err?.message || String(err),
          });
        }
      });

      // ── Edit button ────────────────────────────────────────────────────
      tr.querySelector('.ma-edit-btn').addEventListener('click', ev => {
        ev.stopPropagation();
        MALog.comment('edit_opened', {
          commentId,
          isAi,
          path: filePath,
          currentLength: displayText.length,
        });
        editingCommentId = commentId;
        activeEditState = { commentId, text: textarea.value };
        body.style.display     = 'none';
        editArea.style.display = 'block';
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });

      // ── Edit cancel ────────────────────────────────────────────────────
      tr.querySelector('.ma-edit-cancel').addEventListener('click', ev => {
        ev.stopPropagation();
        MALog.comment('edit_cancelled', { commentId, isAi });
        // Restore textarea to current display text in case user typed something
        textarea.value = displayText;
        editingCommentId = null;
        activeEditState = null;
        body.style.display     = '';
        editArea.style.display = 'none';
      });

      // ── Edit save ──────────────────────────────────────────────────────
      const saveBtn = tr.querySelector('.ma-edit-save');
      saveBtn.addEventListener('mousedown', ev => ev.stopPropagation());
      saveBtn.addEventListener('pointerdown', ev => ev.stopPropagation());
      saveBtn.addEventListener('click', async ev => {
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        MALog.comment('edit_save_clicked', { commentId, path: filePath, isAi });
        const newText = textarea.value.trim();
        tr.querySelector('.ma-save-err')?.remove();
        if (!newText) {
          saveBtn.insertAdjacentHTML('afterend',
            `<span style="color:#c62828;font-size:11px;margin-left:6px;" class="ma-save-err">⚠ Draft text cannot be empty.</span>`
          );
          return;
        }
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        saveBtn.insertAdjacentHTML('afterend',
          `<span style="color:#5f6368;font-size:11px;margin-left:6px;" class="ma-save-err">Saving...</span>`
        );

        MALog.comment('edit_save_start', {
          commentId,
          isAi,
          path: filePath,
          oldLength: displayText.length,
          newLength: newText.length,
          changed: newText !== displayText,
        });

        try {
          const storageText = isAi ? AI_PREFIX + '\n\n' + newText : newText;
          const changeNum = getChangeNumber();
          const patchSet =
            comment.patchSet != null
              ? String(comment.patchSet)
              : await getEffectivePatchSetNumber(changeNum);
          tr.querySelector('.ma-save-err')?.remove();
          saveBtn.insertAdjacentHTML('afterend',
            `<span style="color:#5f6368;font-size:11px;margin-left:6px;" class="ma-save-err">Sending update...</span>`
          );
          await Promise.race([
            updateDraft(changeNum, patchSet, toGerritDraftId(commentId), storageText, !comment.resolved),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Saving draft timed out. Please retry.')), 12000)
            ),
          ]);
          // Update in-memory comment text so subsequent re-renders show the new value
          comment.text = storageText;
          MALog.comment('edit_save_success', {
            commentId,
            isAi,
            newLength: newText.length,
            messagePreview: newText.slice(0, 80),
          });
          editingCommentId = null;
          activeEditState = null;
          // Re-render to show updated body text cleanly
          displaySavedComments(table, filePath, { preserveOpenEdit: false });
        } catch (err) {
          MALog.error('edit_save_failed', {
            commentId,
            error: err?.message || String(err),
          });
          saveBtn.disabled = false; saveBtn.textContent = 'Save draft';
          const msg = err?.message || String(err) || 'Unknown error';
          saveBtn.insertAdjacentHTML('afterend',
            `<span style="color:#c62828;font-size:11px;margin-left:6px;" class="ma-save-err">⚠ ${escHtml(msg)}</span>`
          );
          // Keep edit session locked open so background refresh cannot interrupt retry.
          editingCommentId = commentId;
        }
      });

      // ── Discard button ─────────────────────────────────────────────────
      tr.querySelector('.ma-discard-btn').addEventListener('click', async ev => {
        ev.stopPropagation();
        MALog.comment('discard_clicked', {
          commentId,
          isAi,
          path: filePath,
          anchorCount: lines.length,
        });
        const btn = tr.querySelector('.ma-discard-btn');
        btn.disabled = true; btn.textContent = 'Deleting…';
        const ok = await deleteMultiAnchorComment(commentId);
        if (ok) { displaySavedComments(table, filePath); updateFabBadge(); }
        else    { btn.disabled = false; btn.textContent = 'Discard'; }
      });

      // ── Hover highlight ────────────────────────────────────────────────
      tr.addEventListener('mouseenter', () => highlightLines(table, filePath, lines, true));
      tr.addEventListener('mouseleave', () => {
        if (!tr.classList.contains('ma-active')) highlightLines(table, filePath, lines, false);
      });
      // ── Click to persistently toggle highlight ─────────────────────────
      tr.addEventListener('click', () => {
        const active = document.activeElement;
        if (active && ['TEXTAREA', 'INPUT', 'BUTTON'].includes(active.tagName)) return;
        const on = tr.classList.toggle('ma-active');
        MALog.ui('comment_highlight_toggled', {
          commentId,
          on,
          isAi,
          path: filePath,
        });
        highlightLines(table, filePath, lines, on);
      });

      // ── Insert row into table ──────────────────────────────────────────
      // FIX: fall back to table.appendChild() so the row stays inside the
      // <table>. The original code called insertAdjacentElement('afterend') on
      // the table itself when no anchor row was found, which inserts the <tr>
      // *outside* the table — invisible and invalid HTML.
      const lastKeyHere = getLastAnchorKeyForFile(lines, filePath);
      const lastAnchor  = lastKeyHere ? parseAnchorKey(lastKeyHere) : null;
      const lastRow     = findRowForAnchor(table, lastAnchor);
      if (lastRow) {
        lastRow.insertAdjacentElement('afterend', tr);
      } else {
        table.appendChild(tr);
      }
    });

    updateFabBadge();
  }

  // ── Refresh visible diff ───────────────────────────────────────────────────
  function refreshCurrentDiffView() {
    if (isEditSessionActive()) return;
    const diffElement = getDiffElement();
    const { table, filePath } = getTablePathPair(diffElement);
    if (!table || !filePath) return;
    if (diffObserver) diffObserver.disconnect();
    try {
      displaySavedComments(table, filePath);
      const applied = applyPendingSelectionToTable(table, filePath);
      if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
        schedulePendingSelectionReapply(filePath, 0);
      }
    } finally {
      if (diffElement.shadowRoot && diffObserver) {
        diffObserver.observe(diffElement.shadowRoot, { childList: true, subtree: true });
      }
    }
  }

  // ── Manual multi-anchor selection ─────────────────────────────────────────
  /** @type {Set<string>} JSON anchor keys including file path */
  const selectedLines = new Set();

  function setSelectedVisual(row, side, selected) {
    row.querySelectorAll(`td.${side}`).forEach(td => {
      td.classList.toggle('multi-anchor-selected', selected);
    });
    row.querySelectorAll(`td.${side} div.contentText`).forEach(el => {
      el.style.backgroundColor = selected ? 'rgba(255, 200, 0, 0.3)' : '';
    });
    row.querySelectorAll(`td.${side} button.lineNumButton`).forEach(el => {
      el.style.backgroundColor = selected ? 'rgba(255, 200, 0, 0.3)' : '';
    });
  }

  function toggleLine(lineKey, side, row) {
    const wasSelected = selectedLines.has(lineKey);
    if (wasSelected) {
      selectedLines.delete(lineKey);
      setSelectedVisual(row, side, false);
    } else {
      selectedLines.add(lineKey);
      setSelectedVisual(row, side, true);
    }

    const anchor = parseAnchorKey(lineKey);
    const stats  = getPendingAnchorStats();
    MALog.anchor(wasSelected ? 'line_deselected' : 'line_selected', {
      path:        anchor?.path,
      side:        anchor?.side,
      lineNum:     anchor?.lineNum,
      totalSelected:  stats.anchorCount,
      filesInvolved:  stats.fileCount,
    });
  }

  function clearSelectionDeep() {
    const prevCount = selectedLines.size;
    selectedLines.clear();
    walkShadowTree(document.body, node => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      node.querySelectorAll('td.multi-anchor-selected').forEach(td => {
        td.classList.remove('multi-anchor-selected');
        td.querySelectorAll('div.contentText').forEach(el => { el.style.backgroundColor = ''; });
        td.querySelectorAll('button.lineNumButton').forEach(el => { el.style.backgroundColor = ''; });
      });
    });
    if (prevCount > 0) {
      MALog.anchor('selection_cleared', { clearedCount: prevCount });
    }
  }

  // ── Comment-draft box ─────────────────────────────────────────────────────
  function removeDraftRowsDeep() {
    walkShadowTree(document.body, node => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      node.querySelectorAll('tr.multi-anchor-comment-row').forEach(tr => tr.remove());
    });
  }

  function hasDraftRowDeep() {
    let found = false;
    walkShadowTree(document.body, node => {
      if (found) return;
      if (node.nodeType === 1 && node.matches && node.matches('tr.multi-anchor-comment-row')) found = true;
    });
    return found;
  }

  function showCommentBox(table, filePath) {
    removeDraftRowsDeep();

    const keys = [...selectedLines];
    const positionKey = getLastAnchorKeyForFile(keys, filePath);
    if (!positionKey) {
      console.warn('[multianchor-comment] Open a file where you selected lines to compose the draft.');
      MALog.ui('comment_box_no_anchor', { filePath });
      return;
    }

    const stats = getPendingAnchorStats();
    MALog.ui('comment_box_opened', {
      filePath,
      anchorCount: stats.anchorCount,
      fileCount:   stats.fileCount,
      isMultiFile: stats.fileCount > 1,
      anchors: keys.map(k => {
        const a = parseAnchorKey(k);
        return a ? { path: a.path, side: a.side, line: a.lineNum } : k;
      }),
    });

    const lineLabels = formatGroupedAnchorLabels(keys);
    const pendingHint = stats.fileCount > 1
      ? ` · ${stats.anchorCount} anchors across ${stats.fileCount} files`
      : '';

    const tr = document.createElement('tr');
    tr.className = 'multi-anchor-comment-row';

    tr.innerHTML = `
      <td colspan="3"></td>
      <td style="padding:0; border-top:1px solid var(--border-color); overflow:hidden;">
        <div class="ma-card">
          <div class="ma-card-header">
            <span class="ma-card-header-icon">✏️</span>
            <span class="ma-card-header-title">New draft</span>
            <span class="ma-card-header-tag draft">Draft</span>
            <span class="ma-card-header-meta">· ${escHtml(lineLabels)}${escHtml(pendingHint)}</span>
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

    // FIX: fall back to table.appendChild() instead of inserting outside the table
    const pos = parseAnchorKey(positionKey);
    const lastRow = findRowForAnchor(table, pos);
    if (lastRow) {
      lastRow.insertAdjacentElement('afterend', tr);
    } else {
      table.appendChild(tr);
    }

    const textarea = tr.querySelector('.ma-new-textarea');
    textarea.focus();
    textarea.addEventListener('focus', () => textarea.style.borderColor = '#1967d2');
    textarea.addEventListener('blur',  () => textarea.style.borderColor = 'var(--border-color,#dadce0)');

    tr.querySelector('.ma-new-cancel').addEventListener('click', () => {
      MALog.ui('comment_box_cancelled', {
        filePath,
        anchorCount: keys.length,
      });
      tr.remove(); clearSelectionDeep();
    });

    tr.querySelector('.ma-new-save').addEventListener('click', async () => {
      const text     = textarea.value.trim();
      const resolved = tr.querySelector('.ma-new-resolved').checked;
      if (!text) return;
      const saveBtn = tr.querySelector('.ma-new-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      // Clear any previous error
      tr.querySelector('.ma-save-err')?.remove();

      MALog.comment('new_draft_save_start', {
        filePath,
        anchorCount:   keys.length,
        fileCount:     stats.fileCount,
        isMultiFile:   stats.fileCount > 1,
        resolved,
        messageLength: text.length,
        messagePreview: text.slice(0, 80),
      });

      const { draft, error } = await createMultiAnchorComment(selectedLines, text, resolved);
      if (draft) {
        tr.remove(); clearSelectionDeep();
        displaySavedComments(table, filePath);
        MALog.comment('new_draft_saved', {
          commentId:  draft.id,
          filePath,
          anchorCount: keys.length,
          resolved,
        });
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save draft';
        const msg = error?.message || String(error) || 'Unknown error';
        saveBtn.insertAdjacentHTML('afterend',
          `<span style="color:#c62828;font-size:11px;margin-left:6px;" class="ma-save-err">⚠ ${escHtml(msg)}</span>`
        );
        MALog.error('new_draft_save_failed', { filePath, error: msg });
      }
    });
  }

  // ── Document-level click & keyboard listeners (multi-file safe) ───────────
  let documentHooksInstalled = false;

  function findPathElement(e, selector) {
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : [e.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (node.matches && node.matches(selector)) return node;
      if (node.closest) {
        const match = node.closest(selector);
        if (match) return match;
      }
    }
    return null;
  }

  function onDocumentClickCapture(e) {
    if (e.button !== 0) return;

    const t = e.target;
    if (t && t.nodeType === 1) {
      if (t.closest(
        'gr-comment-thread, gr-dialog, .multi-anchor-thread, .multi-anchor-comment-row, ' +
        '#ma-ai-panel, #ma-ai-fab-wrapper, textarea, input, select'
      )) {
        return;
      }
    }

    const currentDiffElement = findPathElement(e, 'gr-diff-element') || getDiffElement();
    ensureStylesInjected(currentDiffElement);

    const table = findPathElement(e, 'table#diffTable');
    if (!table) return;

    const contextNode = findPathElement(e, 'td.left, td.right') || table;
    const filePath = getFilePathForDiffContext(contextNode);
    if (!filePath) return;

    const row = findPathElement(e, 'tr');
    if (!row) return;

    const sideCell = findPathElement(e, 'td.right, td.left');
    if (!sideCell) return;
    const side = sideCell.classList.contains('right') ? 'right' : 'left';

    const lineNumCell = row.querySelector(`td.${side}.lineNum`);
    if (!lineNumCell) return;
    const lineNum = lineNumCell.dataset.value;
    if (!lineNum || lineNum === 'LOST' || lineNum === 'FILE') return;

    const lineKey = makeAnchorKey(filePath, side, lineNum);
    const modifier = e.ctrlKey || e.metaKey;

    if (!modifier) {
      // File-explorer style: plain click starts a new single-line anchor; further lines
      // are added with Ctrl/Cmd+click.
      clearSelectionDeep();
      toggleLine(lineKey, side, row);
      MALog.anchor('anchor_line_plain_click', {
        path: filePath,
        side,
        lineNum,
      });
    } else {
      toggleLine(lineKey, side, row);
    }

    e.preventDefault();
    e.stopPropagation();
  }

  function onDocumentKeydownCapture(e) {
    const tag = e.target.tagName;
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'INPUT') return;

    if (e.ctrlKey && e.shiftKey && e.key === 'A') return;

    if (e.key === 'c' && hasDraftRowDeep()) return;

    if (e.key === 'c' && selectedLines.size > 0) {
      const diffElement = getDiffElement();
      const { table, filePath } = getTablePathPair(diffElement);
      if (table && filePath) {
        e.stopImmediatePropagation();
        e.preventDefault();
        MALog.ui('keyboard_shortcut', {
          shortcut: 'c',
          action: 'open_comment_box',
          anchorCount: selectedLines.size,
          filePath,
        });
        showCommentBox(table, filePath);
      }
    }

    if (e.key === 'Escape' && hasDraftRowDeep()) {
      MALog.ui('keyboard_shortcut', {
        shortcut: 'Escape',
        action: 'dismiss_comment_box',
      });
      removeDraftRowsDeep();
      clearSelectionDeep();
    }
  }

  // ── Attach everything to the diff ─────────────────────────────────────────
  let diffObserver         = null;
  let observedDiffRoot     = null;
  let attachPollInstalled  = false;
  let lastLoadTs = 0;

  /* istanbul ignore start */
  async function attachListeners() {
    const diffElement = getDiffElement();
    if (!diffElement) { setTimeout(attachListeners, 500); return; }

    ensureStylesInjected(diffElement);
    injectAiPanel();

    const { table, filePath } = getTablePathPair(diffElement);
    if (!table || !filePath) { setTimeout(attachListeners, 500); return; }

    setupNativeThreadHider();

    if (!documentHooksInstalled) {
      documentHooksInstalled = true;
      document.addEventListener('click', onDocumentClickCapture, true);
      document.addEventListener('keydown', onDocumentKeydownCapture, true);
      MALog.session('document_hooks_installed', { filePath });
    }

    const changeNum = getChangeNumber();
    const patchSet  = await getEffectivePatchSetNumber(changeNum);

    if (!attachPollInstalled) {
      attachPollInstalled = true;
      effectivePatchSetCache = { changeNum: null, urlToken: null, resolved: null };
      if (changeNum) {
        // Phase 1: pre-populate managedGerritIds so the hider works immediately
        Promise.all([
          getAllAdditionalRanges(changeNum).catch(() => ({})),
          restApi.get(`/changes/${changeNum}/revisions/${patchSet}/drafts`).catch(() => ({})),
        ]).then(([additionalRanges, drafts]) => {
          Object.keys(additionalRanges || {}).forEach(storageKey => {
            managedGerritIds.add(toGerritDraftId(storageKey));
          });
          for (const comments of Object.values(drafts || {})) {
            for (const comment of comments || []) {
              if (comment?.message?.startsWith(AI_PREFIX)) {
                managedGerritIds.add(comment.id);
              }
            }
          }
          setupNativeThreadHider();
        }).catch(() => {});

        // Phase 2: full load, then render plugin UI
        loadMultiAnchorComments(changeNum, patchSet).then(() => {
          setupNativeThreadHider();
          displaySavedComments(table, filePath);
        });
      }
      setInterval(attachListeners, 700);
    }

    if (!commentsLoaded) return;
    if (isEditSessionActive()) return;

    displaySavedComments(table, filePath);
    const applied = applyPendingSelectionToTable(table, filePath);
    if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
      schedulePendingSelectionReapply(filePath, 0);
    }

    // MutationObserver on the diff shadow root to catch Gerrit re-renders
    if (diffElement.shadowRoot && observedDiffRoot !== diffElement.shadowRoot) {
      observedDiffRoot = diffElement.shadowRoot;
      if (diffObserver) diffObserver.disconnect();
      diffObserver = new MutationObserver(() => {
        clearTimeout(attachListeners._debounce);
        attachListeners._debounce = setTimeout(() => refreshCurrentDiffView(), 150);
      });
      diffObserver.observe(diffElement.shadowRoot, { childList: true, subtree: true });
    }
  }

  if (typeof window !== 'undefined' && window.__MULTIANCHOR_TEST__) {
    window.__multianchorTestApi = {
      AI_PREFIX,
      makeAnchorKey,
      parseAnchorKey,
      formatAnchorLabel,
      formatGroupedAnchorLabels,
      toPluginUrlId,
      toPluginStorageKey,
      toGerritDraftId,
      getChangeNumber,
      getPatchSetNumber,
      getFilePath,
      loadHistory,
      pushHistory,
      getPendingAnchorStats,
      hasPendingAnchorsForFile,
      applyPendingSelectionToTable,
      schedulePendingSelectionReapply,
      markAnchoredLines,
      addRangeBadge,
      highlightLines,
      setSelectedVisual,
      toggleLine,
      clearSelectionDeep,
      removeDraftRowsDeep,
      hasDraftRowDeep,
      showCommentBox,
      refreshCurrentDiffView,
      ensureStylesInjected,
      injectStyles,
      injectAiPanel,
      refreshHistoryDropdown,
      togglePanel,
      closePanel,
      logMsg,
      clearLog,
      updateFabBadge,
      setupNativeThreadHider,
      injectHiderStyle,
      findPathElement,
      onDocumentClickCapture,
      onDocumentKeydownCapture,
      walkShadowTree,
      getTablePathPair,
      getFilePathForDiffContext,
      getDiffElement,
      getGrDiffHost,
      displaySavedComments,
      loadMultiAnchorComments,
      createMultiAnchorComment,
      deleteMultiAnchorComment,
      createDraft,
      updateDraft,
      deleteDraft,
      saveAdditionalRanges,
      deleteAdditionalRanges,
      getAllAdditionalRanges,
      anchorKeysToRanges,
      getLastAnchorKeyForFile,
      findRowForAnchor,
      escHtml,
      isEditSessionActive,
      getActiveEditState: () => activeEditState,
      setActiveEditState: value => { activeEditState = value; },
      getEditingCommentId: () => editingCommentId,
      setEditingCommentId: value => { editingCommentId = value; },
      getSavedCommentsSnapshot: () => Array.from(savedComments.entries()),
      setSavedComment: (key, value) => savedComments.set(key, value),
      clearSavedComments: () => savedComments.clear(),
      getManagedIds: () => Array.from(managedGerritIds.values()),
      clearManagedIds: () => managedGerritIds.clear(),
      getSelectedLines: () => Array.from(selectedLines.values()),
      clearSelectedLines: () => selectedLines.clear(),
      MALog,
    };
  } else {
    setTimeout(attachListeners, 1000);
  }
  /* istanbul ignore end */
});

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
      // Console output: easy to grep with "[MA]" in DevTools
      console.log(`[MA] [${category.toUpperCase()}] ${event}`, data);
      _persist(entry);
      return entry;
    }

    return {
      sessionId: SESSION_ID,

      // ── Session events ─────────────────────────────────────────────────
      session(event, data)  { return _emit('session',  event, data); },

      // ── Anchor-selection events ────────────────────────────────────────
      anchor(event, data)   { return _emit('anchor',   event, data); },

      // ── Comment lifecycle events ───────────────────────────────────────
      comment(event, data)  { return _emit('comment',  event, data); },

      // ── AI-review events ───────────────────────────────────────────────
      ai(event, data)       { return _emit('ai',       event, data); },

      // ── UI / navigation events ─────────────────────────────────────────
      ui(event, data)       { return _emit('ui',       event, data); },

      // ── Error events ───────────────────────────────────────────────────
      error(event, data)    { return _emit('error',    event, data); },

      /**
       * Returns a copy of the full log array from sessionStorage.
       * Useful for exporting during/after a test session.
       */
      export() {
        try {
          return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]');
        } catch { return []; }
      },

      /**
       * Clears the persisted log (e.g. between test runs).
       */
      clear() {
        sessionStorage.removeItem(SESSION_KEY);
        console.log('[MA] Log cleared.');
      },
    };
  })();

  // Expose on window so testers can call MALog.export() / MALog.clear() in DevTools
  window.MALog = MALog;

  MALog.session('plugin_init', {
    url:       window.location.href,
    userAgent: navigator.userAgent,
  });

  // ── REST helper ────────────────────────────────────────────────────────────
  const restApi = plugin.restApi();

  // ── In-memory store ────────────────────────────────────────────────────────
  const savedComments = new Map();
  const managedGerritIds = new Set(); // raw Gerrit draft IDs, e.g. "30cf37cd_63ac1f2c"

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
    // rawGerritId is the full Gerrit draft ID, e.g. "57c51203_e734edd9"
    // The backend splits on '~' to get patchSet and commentUuid
    return `${patchSet}~${rawGerritId}`;
  }

  // Storage key for looking up in getAllAdditionalRanges response: {patchSet}/{rawGerritDraftId}
  function toPluginStorageKey(rawGerritId, patchSet) {
    if (!rawGerritId) return rawGerritId;
    return `${patchSet}/${rawGerritId}`;
  }

  function toGerritDraftId(storageKey) {
    // Storage key is "1/57c51203_e734edd9" — Gerrit wants "57c51203_e734edd9"
    return storageKey.includes('/') ? storageKey.split('/').slice(1).join('/') : storageKey;
  }

  // ── Effective patchset resolution ──────────────────────────────────────────
  /**
   * Cache so we do not refetch change detail on every operation while the URL
   * still implies "current".
   */
  let effectivePatchSetCache = { changeNum: null, urlToken: null, resolved: null };

  /**
   * Returns the numeric patchset string to use for APIs and storage keys.
   * When the URL omits a revision, Gerrit uses "current" for draft endpoints,
   * but plugin storage keys need numeric patchset numbers; this resolves
   * "current" via change detail.
   * @param {string} changeNum
   * @returns {Promise<string>}
   */
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
      return 'current'; // Gerrit draft endpoints accept "current" as a fallback
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
  /**
   * @param {string} filePath - repo path for this diff (from gr-diff-host)
   * @param {"left" | "right"} side
   * @param {string} lineNum
   * @returns {string}
   */
  function makeAnchorKey(filePath, side, lineNum) {
    return JSON.stringify({ p: filePath, s: side, n: String(lineNum) });
  }

  /**
   * @param {string} key
   * @returns {{ path: string, side: string, lineNum: string } | null}
   */
  function parseAnchorKey(key) {
    try {
      const o = JSON.parse(key);
      if (o && o.p != null && o.s && o.n != null) {
        return { path: o.p, side: o.s, lineNum: o.n };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  function formatAnchorLabel(key) {
    const a = parseAnchorKey(key);
    if (!a) return key;
    const base = (a.path && a.path.includes('/')) ? a.path.split('/').pop() : a.path;
    const lr = a.side === 'left' ? 'L' : 'R';
    return a.path ? `${base}:${lr}${a.lineNum}` : `${lr}${a.lineNum}`;
  }

  /**
   * Formats anchors as grouped-by-file labels, e.g. "foo.js: R2, R4; bar.js: L10".
   * @param {string[]} keys
   * @returns {string}
   */
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

  /**
   * Walks composed ancestors and shadow hosts to find gr-diff-host (holds .path).
   * @param {Node | null} node
   * @returns {HTMLElement | null}
   */
  function getGrDiffHostFromNode(node) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.tagName === 'GR-DIFF-HOST') {
        return /** @type {HTMLElement} */ (n);
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

  /**
   * @param {Node | null} node
   * @returns {string}
   */
  function getFilePathForDiffContext(node) {
    const host = getGrDiffHostFromNode(node);
    if (!host) return '';
    return host.path || host.getAttribute?.('path') || '';
  }

  /**
   * @param {HTMLElement | null} diffElement - gr-diff-element
   * @returns {{ table: HTMLTableElement | null, filePath: string }}
   */
  function getTablePathPair(diffElement) {
    if (!diffElement) return { table: null, filePath: '' };
    const table =
      (diffElement.shadowRoot && diffElement.shadowRoot.querySelector('table#diffTable')) ||
      diffElement.querySelector('table#diffTable');
    const filePath = getFilePathForDiffContext(diffElement);
    return { table, filePath };
  }

  /**
   * Last anchor in insertion order that belongs to currentPath (for draft placement).
   * @param {string[]} keys
   * @param {string} currentPath
   * @returns {string | null}
   */
  function getLastAnchorKeyForFile(keys, currentPath) {
    for (let i = keys.length - 1; i >= 0; i--) {
      const a = parseAnchorKey(keys[i]);
      if (a && a.path === currentPath) return keys[i];
    }
    return null;
  }

  /**
   * @param {HTMLTableElement} table
   * @param {{ path: string, side: string, lineNum: string } | null} anchor
   * @returns {HTMLTableRowElement | null}
   */
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
  /**
   * Converts a Set of anchor keys (JSON with path/side/lineNum) into REST range
   * objects grouped by side, for use in createDraft / saveAdditionalRanges.
   * Only lines matching `side` are included.
   * @param {Set<string>} lineKeys
   * @param {"left"|"right"} side
   * @returns {{ start_line: number, start_character: number, end_line: number, end_character: number }[]}
   */
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

          // Convert REST ranges → multifile anchor keys so the rest of the
          // plugin can treat backend-loaded comments the same as locally-created ones.
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
  /**
   * Creates a multi-anchor comment (draft + additional ranges).
   * Implements compensation logic for atomicity: if saveAdditionalRanges fails,
   * the draft is deleted to avoid inconsistent state.
   */
  async function createMultiAnchorComment(selectedLines, message, resolved) {
    const changeNum = getChangeNumber();
    const patchSet  = await getEffectivePatchSetNumber(changeNum);
    if (!changeNum) return null;

    // Determine dominant side among selected anchors
    let rightCount = 0, leftCount = 0;
    selectedLines.forEach(k => {
      const a = parseAnchorKey(k);
      if (a?.side === 'right') rightCount++;
      else if (a?.side === 'left') leftCount++;
    });
    const side = rightCount >= leftCount ? 'right' : 'left';

    // Derive the file path from the first anchor (primary draft must have a path)
    const firstAnchor = parseAnchorKey([...selectedLines][0]);
    const path = firstAnchor?.path || getFilePath();
    if (!path) return null;

    const allRanges = anchorKeysToRanges(selectedLines, side);
    if (!allRanges.length) return null;

    // Compute per-file anchor breakdown for logging
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
      // 1. Create draft with primary (first) range via Gerrit API
      draft = await createDraft(changeNum, patchSet, path, allRanges[0], message, !resolved);

      fullDraftId = toPluginStorageKey(draft.id, patchSet);
      const urlId = toPluginUrlId(draft.id, patchSet);

      // 2. If there are additional ranges, save them via plugin API
      const additionalRanges = allRanges.slice(1);
      try {
        await saveAdditionalRanges(changeNum, urlId, additionalRanges);
      } catch (rangeError) {
        // Compensation: delete the draft to maintain consistency
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

      // 3. Add to local cache
      savedComments.set(fullDraftId, {
        id:               fullDraftId,
        path,
        lines:            [...selectedLines],
        text:             message,
        resolved,
        isDraft:          true,
        primaryRange:     allRanges[0],
        additionalRanges: allRanges.slice(1),
      });

      managedGerritIds.add(draft.id);

      lastLoadTs = Date.now(); // suppress poll reload until backend is consistent

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

  /**
   * Deletes a multi-anchor comment (draft + additional ranges).
   * Implements retry logic for atomicity: if deleteAdditionalRanges fails,
   * retries with backoff and logs the partial failure.
   */
  async function deleteMultiAnchorComment(commentId) {
    const changeNum = getChangeNumber();
    const patchSet  = await getEffectivePatchSetNumber(changeNum);
    if (!changeNum) return false;

    const commentMeta = savedComments.get(commentId);
    MALog.comment('delete_start', {
      commentId,
      changeNum,
      patchSet,
      path:        commentMeta?.path,
      anchorCount: commentMeta?.lines?.length,
      isAi:        commentMeta?.text?.startsWith(AI_PREFIX),
    });

    try {
      // 1. Delete draft from Gerrit first
      const rawGerritId = commentId.includes('/') ? commentId.split('/').slice(1).join('/') : commentId;
      const urlId = toPluginUrlId(rawGerritId, patchSet);
      const gerritId = rawGerritId; // Gerrit draft endpoint wants the raw ID as-is

      await deleteDraft(changeNum, patchSet, gerritId);

      // 2. Delete additional ranges from plugin storage with retry
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
            // Exponential backoff: 100ms, 200ms
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          }
        }
      }

      if (!rangeDeleteSuccess) {
        // Log partial failure — draft deleted but ranges remain (orphaned).
        // Still treat as success for the user since the draft is gone; the
        // orphaned range data is harmless (references a non-existent comment).
        console.error('Partial delete: draft deleted but additional ranges remain:', lastError);
        MALog.error('delete_partial_ranges_orphaned', {
          commentId,
          changeNum,
          patchSet,
          error: lastError?.message || String(lastError),
        });
      }

      // 3. Remove from local cache
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

  function injectAiPanel() {
    if (document.getElementById('ma-ai-fab-wrapper')) return;
    if (document.getElementById('ma-ai-fab')) return;

    // FAB
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

    // Panel
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
    // ← removed wrapper.style.position = 'relative'
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
            const rawId   = thread.rootId || thread.comments?.[0]?.id || '';
            const firstMsg = thread.comments?.[0]?.message || '';
            // Match by raw Gerrit ID (no patchset prefix) or AI prefix
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
      if (++pollCount >= 80) clearInterval(hidePoller);
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

  /**
   * Marks lines associated with a multi-anchor comment in the visible table.
   * Only anchors belonging to filePath are marked (multi-file safe).
   * @param {HTMLTableElement} table
   * @param {string} filePath
   * @param {string[]} lines - anchor keys
   */
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
    // Find first anchor visible in this file for badge placement
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
  /**
   * @returns {{ anchorCount: number, fileCount: number }}
   */
  function getPendingAnchorStats() {
    const files = new Set();
    selectedLines.forEach(key => {
      const a = parseAnchorKey(key);
      if (a && a.path) files.add(a.path);
    });
    return { anchorCount: selectedLines.size, fileCount: files.size };
  }

  /**
   * @param {string} filePath
   * @returns {boolean}
   */
  function hasPendingAnchorsForFile(filePath) {
    for (const key of selectedLines) {
      const a = parseAnchorKey(key);
      if (a && a.path === filePath) return true;
    }
    return false;
  }

  /**
   * Re-applies yellow selection styling to lines visible in this table.
   * @param {HTMLTableElement} table
   * @param {string} filePath
   * @returns {number} number of anchors re-highlighted
   */
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
   * Uses the ai_review card style for all comments.
   *
   * @param {HTMLTableElement} table
   * @param {string} filePath
   */
  function displaySavedComments(table, filePath) {
    const diffElement = getDiffElement();
    if (diffElement) ensureStylesInjected(diffElement);

    // Clear existing plugin rows and markers
    table.querySelectorAll('.multi-anchor-thread').forEach(el => el.remove());
    table.querySelectorAll('td.multi-anchor-existing, td.multi-anchor-highlighted').forEach(td => {
      td.classList.remove('multi-anchor-existing', 'multi-anchor-highlighted');
    });
    table.querySelectorAll('.ma-range-badge').forEach(b => b.remove());

    savedComments.forEach((comment, commentId) => {
      const { lines, text, resolved } = comment;

      // Only render if this comment has at least one anchor in the current file
      const hasAnchorHere = lines.some(lk => parseAnchorKey(lk)?.path === filePath);
      if (!hasAnchorHere) return;

      const isAi = text.startsWith(AI_PREFIX);

      markAnchoredLines(table, filePath, lines);
      addRangeBadge(table, filePath, lines);

      const lineLabel = formatGroupedAnchorLabels(lines);
      const displayText = isAi ? text.replace(/^🤖 AI Review:\n\n/, '') : text;

      const tr = document.createElement('tr');
      tr.className = 'multi-anchor-thread';
      tr.dataset.commentId = commentId;

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

      // ── Wire up interactions ───────────────────────────────────────────
      const card     = tr.querySelector('.ma-card');
      const body     = tr.querySelector('.ma-card-body');
      const editArea = tr.querySelector('.ma-card-edit');
      const textarea = tr.querySelector('.ma-edit-textarea');

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
        card.classList.toggle('resolved', comment.resolved);
        try {
          const changeNum = getChangeNumber();
          const patchSet = await getEffectivePatchSetNumber(changeNum);
          await updateDraft(changeNum, patchSet, toGerritDraftId(commentId),
            isAi ? AI_PREFIX + '\n\n' + displayText : displayText,
            !comment.resolved
          );
          MALog.comment('resolve_saved', { commentId, resolved: newResolved });
        } catch (err) {
          MALog.error('resolve_save_failed', {
            commentId,
            error: err?.message || String(err),
          });
        }
        displaySavedComments(table, filePath);
      });

      tr.querySelector('.ma-edit-btn').addEventListener('click', ev => {
        ev.stopPropagation();
        MALog.comment('edit_opened', {
          commentId,
          isAi,
          path: filePath,
          currentLength: displayText.length,
        });
        body.style.display     = 'none';
        editArea.style.display = 'block';
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });

      tr.querySelector('.ma-edit-cancel').addEventListener('click', ev => {
        ev.stopPropagation();
        MALog.comment('edit_cancelled', { commentId, isAi });
        body.style.display     = '';
        editArea.style.display = 'none';
      });

      tr.querySelector('.ma-edit-save').addEventListener('click', async ev => {
        ev.stopPropagation();
        const newText = textarea.value.trim();
        if (!newText) return;
        const btn = tr.querySelector('.ma-edit-save');
        btn.disabled = true; btn.textContent = 'Saving…';

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
          const patchSet = await getEffectivePatchSetNumber(changeNum);
          await updateDraft(changeNum, patchSet, toGerritDraftId(commentId), storageText, !comment.resolved);
          comment.text = storageText;
          MALog.comment('edit_save_success', {
            commentId,
            isAi,
            newLength: newText.length,
            messagePreview: newText.slice(0, 80),
          });
          displaySavedComments(table, filePath);
        } catch (err) {
          MALog.error('edit_save_failed', {
            commentId,
            error: err?.message || String(err),
          });
          btn.disabled = false; btn.textContent = 'Save draft';
        }
      });

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

      // AC2: Hover highlight (respects persistent toggle)
      tr.addEventListener('mouseenter', () => highlightLines(table, filePath, lines, true));
      tr.addEventListener('mouseleave', () => {
        if (!tr.classList.contains('ma-active')) highlightLines(table, filePath, lines, false);
      });
      // AC3: Click to persistently toggle highlight
      tr.addEventListener('click', () => {
        const on = tr.classList.toggle('ma-active');
        MALog.ui('comment_highlight_toggled', {
          commentId,
          on,
          isAi,
          path: filePath,
        });
        highlightLines(table, filePath, lines, on);
      });

      // Insert after last anchor in this file
      const lastKeyHere = getLastAnchorKeyForFile(lines, filePath);
      const lastAnchor  = lastKeyHere ? parseAnchorKey(lastKeyHere) : null;
      const lastRow     = findRowForAnchor(table, lastAnchor);
      (lastRow || table).insertAdjacentElement('afterend', tr);
    });

    updateFabBadge();
  }

  // ── Refresh visible diff ───────────────────────────────────────────────────
  function refreshCurrentDiffView() {
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

  /**
   * Applies/removes yellow selected styling directly on row cells.
   * @param {HTMLTableRowElement} row
   * @param {"left"|"right"} side
   * @param {boolean} selected
   */
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

  /**
   * Creates and inserts a new draft comment box, using the ai_review card style.
   * Placed below the last selected anchor in the currently visible file.
   *
   * @param {HTMLTableElement} table
   * @param {string} filePath
   */
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

    const pos = parseAnchorKey(positionKey);
    const lastRow = findRowForAnchor(table, pos);
    (lastRow || table).insertAdjacentElement('afterend', tr);

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

  /**
   * Finds the first element in composedPath() matching a selector.
   * @param {Event} e
   * @param {string} selector
   * @returns {Element | null}
   */
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

  /**
   * Ctrl/Cmd+click on any diff line toggles it as a pending anchor.
   * Works across file navigations because it reads the file path from gr-diff-host.
   */
  function onDocumentClickCapture(e) {
    if (!e.ctrlKey && !e.metaKey) return;

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
    toggleLine(lineKey, side, row);

    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * 'c' opens a comment box for the pending selection; Escape dismisses it.
   * Uses capture phase to intercept before Gerrit's own 'c' shortcut.
   */
  function onDocumentKeydownCapture(e) {
    const tag = e.target.tagName;
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'INPUT') return;

    // Ctrl+Shift+A is handled by the global listener for the AI panel
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

  async function attachListeners() {
    const diffElement = getDiffElement();
    if (!diffElement) { setTimeout(attachListeners, 500); return; }

    ensureStylesInjected(diffElement);
    injectAiPanel();

    const { table, filePath } = getTablePathPair(diffElement);
    if (!table || !filePath) { setTimeout(attachListeners, 500); return; }

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
        // ── Phase 1: pre-populate managedGerritIds ASAP so the hider works
        //    before the full load completes. getAllAdditionalRanges is cheap
        //    (one Git read) and returns the keys we need to suppress threads.
        getAllAdditionalRanges(changeNum).then(additionalRanges => {
          if (!additionalRanges) return;
          Object.keys(additionalRanges).forEach(storageKey => {
            // storageKey is "{patchSet}/{rawGerritId}" — extract the raw ID
            const rawId = storageKey.includes('/')
              ? storageKey.split('/').slice(1).join('/')
              : storageKey;
            managedGerritIds.add(rawId);
          });
          setupNativeThreadHider(); // restart hider with pre-populated IDs
        }).catch(() => {});

        // ── Phase 2: full load (drafts + ranges), then render plugin UI
        loadMultiAnchorComments(changeNum, patchSet).then(() => {
          setupNativeThreadHider();
          displaySavedComments(table, filePath);
        });
      }
      setInterval(attachListeners, 700);
    }

    setupNativeThreadHider();

    if (!commentsLoaded) return;

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

  setTimeout(attachListeners, 1000);
});

/**
 * Multi-Anchor Comment Plugin for Gerrit
 */
Gerrit.install(plugin => {

  // ── User-testing logger ────────────────────────────────────────────────────
  const MALog = (() => {
    const SESSION_KEY = 'ma_plugin_log';
    const SESSION_ID  = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    function _persist(entry) {
      try {
        const raw  = sessionStorage.getItem(SESSION_KEY);
        const arr  = raw ? JSON.parse(raw) : [];
        arr.push(entry);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(arr));
      } catch (e) { }
    }

    function _emit(category, event, data = {}) {
      const now   = Date.now();
      const entry = { ts: now, isoTs: new Date(now).toISOString(), sessionId: SESSION_ID, category, event, data };
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
      export() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]'); } catch { return []; } },
      clear() { sessionStorage.removeItem(SESSION_KEY); console.log('[MA] Log cleared.'); },
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

  // ── Robust URL Parsers ─────────────────────────────────────────────────────
  function getGerritContext() {
    const path = window.location.pathname;
    const match = path.match(/\/c\/[^/]+\/\+\/(\d+)\/?((?:\d+\.\.)?\d+)?\/?(.*)?/);
    if (!match) return { changeNum: null, basePs: null, patchSet: 'current', filePath: null };
    
    const changeNum = match[1];
    const psToken = match[2] || 'current';
    const filePath = match[3] ? decodeURIComponent(match[3]) : null;
    
    let basePs = null;
    let patchSet = psToken;
    if (psToken.includes('..')) {
      const parts = psToken.split('..');
      basePs = parts[0];
      patchSet = parts[1];
    }
    
    return { changeNum, basePs, patchSet, filePath };
  }

  function getChangeNumber() { return getGerritContext().changeNum; }
  function getPatchSetNumber() { return getGerritContext().patchSet; }
  function getFilePath() { return getGerritContext().filePath; }

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

  function parseStorageKey(key) {
    if (!key) return null;
    const idx = key.indexOf('/');
    if (idx <= 0) return null;
    const ps = key.slice(0, idx);
    if (!/^[0-9]+$/.test(ps)) return null;
    return { patchSet: ps, commentId: key.slice(idx + 1) };
  }

  function findAdditionalRangesForComment(additionalRanges, commentId, viewPatchSetNum) {
    if (!additionalRanges || !commentId) return null;
    
    let best = null;
    const targetPsNum = Number(viewPatchSetNum);

    for (const key of Object.keys(additionalRanges)) {
      const parsed = parseStorageKey(key);
      if (!parsed || parsed.commentId !== commentId) continue;
      
      const psNum = Number(parsed.patchSet);
      
      // Find the highest patchset where this comment was saved, up to the one we are viewing
      if (Number.isFinite(psNum) && Number.isFinite(targetPsNum) && psNum <= targetPsNum) {
        if (!best || psNum > Number(best.patchSet)) {
          best = { patchSet: parsed.patchSet, storageKey: key };
        }
      }
    }

    if (!best) return null;
    return { 
      ranges: additionalRanges[best.storageKey] || [], 
      storageKey: best.storageKey,
      originalPatchSet: best.patchSet 
    };
  }

  const diffLineMapCache = new Map();

  function buildLineMapFromDiff(diff) {
    const map = new Map();
    if (!diff || !Array.isArray(diff.content)) return map;
    let aLine = 1;
    let bLine = 1;

    diff.content.forEach(chunk => {
      if (chunk.skip) {
        for (let i = 0; i < chunk.skip; i++) map.set(aLine + i, bLine + i);
        aLine += chunk.skip;
        bLine += chunk.skip;
      } else if (chunk.ab) {
        for (let i = 0; i < chunk.ab.length; i++) map.set(aLine + i, bLine + i);
        aLine += chunk.ab.length;
        bLine += chunk.ab.length;
      } else {
        // FIX: Handle modified and deleted lines smoothly
        const aLen = chunk.a ? chunk.a.length : 0;
        const bLen = chunk.b ? chunk.b.length : 0;
        
        if (aLen > 0) {
          for (let i = 0; i < aLen; i++) {
            if (bLen > 0) {
              // Proportional binding for modified chunks
              const bOffset = Math.min(i, bLen - 1);
              map.set(aLine + i, bLine + bOffset);
            } else {
              // Deleted chunk: snap to the line just after the deletion
              map.set(aLine + i, bLine);
            }
          }
        }
        aLine += aLen;
        bLine += bLen;
      }
    });

    return map;
  }

  async function getDiffLineMap(changeNum, fromPatchSet, toPatchSet, filePath) {
    const cacheKey = `${changeNum}|${fromPatchSet}|${toPatchSet}|${filePath}`;
    if (diffLineMapCache.has(cacheKey)) return diffLineMapCache.get(cacheKey);

    const encodedPath = encodeURIComponent(filePath);
    try {
      const diff = await restApi.get(
        `/changes/${changeNum}/revisions/${toPatchSet}/files/${encodedPath}/diff?base=${fromPatchSet}`
      );
      const map = buildLineMapFromDiff(diff);
      diffLineMapCache.set(cacheKey, map);
      return map;
    } catch (e) {
      return null;
    }
  }

  async function mapLineNumbers(changeNum, fromPatchSet, toPatchSet, filePath, lineNums) {
    if (!lineNums.length || String(fromPatchSet) === String(toPatchSet)) return lineNums;

    const map = await getDiffLineMap(changeNum, fromPatchSet, toPatchSet, filePath);
    if (!map) return [];

    const mapped = new Set();
    lineNums.forEach(lineNum => {
      const mappedLine = map.get(lineNum);
      if (mappedLine != null) mapped.add(mappedLine);
    });

    return [...mapped].sort((a, b) => a - b);
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
  async function getEffectivePatchSetNumber(changeNum) {
    const urlToken = getPatchSetNumber();
    if (urlToken !== 'current') return urlToken;
    try {
      const detail = await restApi.get(`/changes/${changeNum}/detail`);
      const rev = detail.revisions[detail.current_revision];
      return String(rev._number);
    } catch (e) {
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
      if (n.nodeType === 1 && n.tagName === 'GR-DIFF-HOST') return n;
      const root = n.getRootNode();
      if (root && root.host) n = root.host;
      else n = n.parentElement;
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
  const MA_MARKER_RE = /\n?\[MA-ID:([^\]]+)\]\s*$/;

  function extractMarkerId(text) {
    if (!text) return null;
    const match = text.match(MA_MARKER_RE);
    return match ? match[1] : null;
  }

  function stripMarker(text) {
    if (!text) return text;
    return text.replace(MA_MARKER_RE, '').trimEnd();
  }

  function appendMarker(text, markerId) {
    if (!markerId) return text;
    const base = stripMarker(text || '');
    return `${base}\n[MA-ID:${markerId}]`;
  }
  
  let commentsLoading = false;
  let commentsLoaded  = false;

  async function loadMultiAnchorComments(changeNum, patchSet) {
    commentsLoading = true;
    commentsLoaded  = false;
    try {
      const additionalRanges = await getAllAdditionalRanges(changeNum);
      const viewPatchSetNum = Number(patchSet);

      let allDrafts = {};
      try {
        allDrafts = await restApi.get(`/changes/${changeNum}/drafts`);
      } catch (e) {
        allDrafts = await restApi.get(`/changes/${changeNum}/revisions/${patchSet}/drafts`).catch(() => ({}));
      }

      savedComments.clear();
      managedGerritIds.clear();

      for (let [path, comments] of Object.entries(allDrafts || {})) {
        path = path.replace(/^\[(.+?)\]\(.+?\)$/, '$1');
        for (const comment of comments) {
          const commentPatchSet = String(comment.patch_set || comment.patchSet || patchSet);
          const markerId = extractMarkerId(comment.message);
          const lookupId = markerId || comment.id;

          const rangeMatch = findAdditionalRangesForComment(
            additionalRanges,
            lookupId,
            viewPatchSetNum
          );
          
          const extraRanges = rangeMatch?.ranges || [];
          const isAiComment = comment.message?.startsWith(AI_PREFIX);
          const isPluginManaged = !!rangeMatch || !!markerId;
          
          if (!isPluginManaged && !isAiComment) continue;

          // FIX: Accurately determine where the anchors were originally created
          const anchorPatchSetNum = rangeMatch ? Number(rangeMatch.originalPatchSet) : Number(commentPatchSet);

          // We shouldn't render comments that were created in the future relative to the current view
          if (Number.isFinite(viewPatchSetNum) && Number.isFinite(anchorPatchSetNum) && anchorPatchSetNum > viewPatchSetNum) {
            continue;
          }

          const primaryRange = comment.range ||
            (comment.line
              ? { start_line: comment.line, start_character: 0, end_line: comment.line, end_character: 0 }
              : null);
          const allRanges = primaryRange ? [primaryRange, ...extraRanges] : extraRanges;

          let lineNums = allRanges.flatMap(r => {
            const start = r.start_line ?? r.startLine;
            const end   = r.end_line   ?? r.endLine;
            if (start == null || end == null) return [];
            const nums = [];
            for (let l = start; l <= end; l++) nums.push(l);
            return nums;
          });

          // Run the math mapping if the anchors are from an older commit
          if (Number.isFinite(anchorPatchSetNum) && Number.isFinite(viewPatchSetNum) && anchorPatchSetNum < viewPatchSetNum) {
            lineNums = await mapLineNumbers(
              changeNum,
              anchorPatchSetNum,
              viewPatchSetNum,
              path,
              lineNums
            );
          }

          const lines = lineNums.map(l => makeAnchorKey(path, 'right', String(l)));

          if (lines.length === 0) continue;

          const storageKey = rangeMatch?.storageKey || toPluginStorageKey(lookupId, anchorPatchSetNum);

          savedComments.set(storageKey, {
            id: storageKey,
            path,
            patchSet: anchorPatchSetNum,
            lines,
            text: comment.message,
            resolved: comment.unresolved === false,
            isDraft: true,
            primaryRange,
            additionalRanges: extraRanges,
          });

          managedGerritIds.add(comment.id);
        }
      }

      return savedComments;
    } catch (e) {
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

    let draft = null;
    let fullDraftId = null;
    try {
      draft = await createDraft(
        changeNum,
        patchSet,
        path,
        allRanges[0],
        message,
        !resolved
      );

      fullDraftId = toPluginStorageKey(draft.id, patchSet);
      const urlId = toPluginUrlId(draft.id, patchSet);

      const additionalRanges = allRanges.slice(1);
      try {
        await saveAdditionalRanges(changeNum, urlId, additionalRanges);
      } catch (rangeError) {
        await deleteDraft(changeNum, patchSet, draft.id);
        throw rangeError;
      }

      const markerText = appendMarker(message, draft.id);
      try {
        await updateDraft(changeNum, patchSet, draft.id, markerText, !resolved);
      } catch (markerError) { }

      savedComments.set(fullDraftId, {
        id:               fullDraftId,
        path,
        patchSet,
        lines:            [...selectedLines],
        text:             markerText,
        resolved,
        isDraft:          true,
        primaryRange:     allRanges[0],
        additionalRanges: allRanges.slice(1),
      });

      managedGerritIds.add(draft.id);
      return { draft, error: null };
    } catch (error) {
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

    try {
      const rawGerritId = commentId.includes('/') ? commentId.split('/').slice(1).join('/') : commentId;
      const urlId = toPluginUrlId(rawGerritId, patchSet);
      const gerritId = rawGerritId;

      await deleteDraft(changeNum, patchSet, gerritId);

      let rangeDeleteSuccess = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await deleteAdditionalRanges(changeNum, urlId);
          rangeDeleteSuccess = true;
          break;
        } catch (rangeError) {
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          }
        }
      }

      savedComments.delete(commentId);
      managedGerritIds.delete(toGerritDraftId(commentId));

      return true;
    } catch (error) {
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
      td.multi-anchor-selected div.contentText      { background: rgba(255,200,0,.30) !important; }
      td.multi-anchor-selected button.lineNumButton { background: rgba(255,200,0,.30) !important; }
      td.multi-anchor-existing div.contentText      { border-left:3px solid #1967d2 !important; background:rgba(66,133,244,.12) !important; }
      td.multi-anchor-existing button.lineNumButton { background:rgba(66,133,244,.15) !important; }
      td.multi-anchor-highlighted div.contentText      { background:rgba(66,133,244,.30) !important; border-left:3px solid #1967d2 !important; }
      td.multi-anchor-highlighted button.lineNumButton { background:rgba(66,133,244,.30) !important; }
      .ma-range-badge {
        display:inline-block; margin-left:4px; padding:1px 5px;
        background:#1967d2; color:#fff; border-radius:10px;
        font-size:10px; font-weight:600; line-height:1.4; vertical-align:middle;
        pointer-events:none;
      }
      .multi-anchor-thread { cursor: pointer; }
      .ma-card {
        background: rgb(254,247,224);
        font-family: var(--font-family), 'Roboto', Arial, sans-serif;
        font-size: var(--font-size-normal, 13px);
        color: var(--primary-text-color, #202124);
        overflow: hidden;
        word-wrap: break-word;
      }
      .ma-card.resolved { background: rgb(232,245,233); }
      .ma-card-header {
        display: flex; align-items: center; gap: 6px;
        padding: var(--spacing-m) var(--spacing-m) var(--spacing-s);
        border-bottom: 1px solid rgba(0,0,0,.07);
      }
      .ma-card-header-icon { font-size: 15px; line-height: 1; flex-shrink: 0; }
      .ma-card-header-title { font-weight: 600; font-size: var(--font-size-normal, 13px); letter-spacing: .01em; }
      .ma-card-header-meta { font-size: 11px; color: var(--deemphasized-text-color, #80868b); font-weight: 400; margin-left: 2px; }
      .ma-card-header-tag {
        display: inline-flex; align-items: center; font-size: 10px; font-weight: 600;
        letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px;
        border-radius: 3px; margin-left: 2px;
      }
      .ma-card-header-tag.ai   { background: #e8f0fe; color: #1967d2; }
      .ma-card-header-tag.draft { background: rgba(0,0,0,.06); color: #5f6368; }
      .ma-card-header-right { margin-left: auto; font-size: 11px; color: var(--deemphasized-text-color, #80868b); white-space: nowrap; }
      .ma-card-body {
        padding: var(--spacing-m); white-space: pre-wrap; line-height: 1.55;
        font-size: var(--font-size-normal, 13px); border-bottom: 1px solid rgba(0,0,0,.07);
      }
      .ma-card-edit { padding: var(--spacing-m); border-bottom: 1px solid rgba(0,0,0,.07); }
      .ma-card-edit textarea {
        display: block; width: 100%; box-sizing: border-box; min-height: 80px;
        resize: vertical; font: inherit; font-size: var(--font-size-normal, 13px);
        padding: var(--spacing-s); background: #fff; border: 1px solid var(--border-color, #dadce0);
        border-radius: 4px; color: var(--primary-text-color, #202124); outline: none; transition: border-color .15s;
      }
      .ma-card-edit textarea:focus { border-color: #1967d2; }
      .ma-card-edit-actions { display: flex; justify-content: flex-end; gap: var(--spacing-s); margin-top: var(--spacing-s); position: relative; z-index: 3; pointer-events: auto; }
      .ma-card-footer { display: flex; justify-content: space-between; align-items: center; padding: var(--spacing-s) var(--spacing-m); }
      .ma-resolved-label {
        display: flex; align-items: center; gap: var(--spacing-s);
        font-size: var(--font-size-normal, 13px); color: var(--primary-text-color, #202124); cursor: pointer; user-select: none;
      }
      .ma-resolved-label input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; accent-color: #1967d2; margin: 0; }
      .ma-card-actions { display: flex; gap: 2px; align-items: center; }
      .ma-btn {
        background: none; border: none; cursor: pointer; font: inherit;
        font-size: var(--font-size-normal, 13px); font-weight: 500; padding: 3px 6px;
        border-radius: 3px; color: var(--link-color, #1967d2); transition: background .12s; line-height: 1.4;
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

    const fabWrapper = document.createElement('div');
    fabWrapper.id = 'ma-ai-fab-wrapper';
    Object.assign(fabWrapper.style, {
      position: 'fixed', bottom: '24px', right: '24px', width: '56px', height: '56px', zIndex: '99999'
    });

    const fab = document.createElement('button');
    fab.id = 'ma-ai-fab';
    fab.innerHTML = '🤖';
    fab.title = 'AI Code Review (Ctrl+Shift+A)';
    Object.assign(fab.style, {
      width: '56px', height: '56px', borderRadius: '50%',
      background: '#1a73e8', color: '#fff', border: 'none',
      cursor: 'pointer', fontSize: '22px', boxShadow: '0 4px 12px rgba(0,0,0,.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .15s'
    });
    fab.addEventListener('mouseenter', () => fab.style.transform = 'scale(1.08)');
    fab.addEventListener('mouseleave', () => fab.style.transform = '');
    fab.addEventListener('click', togglePanel);
    fabWrapper.appendChild(fab);
    document.documentElement.appendChild(fabWrapper);
    fabEl = fab;

    const panel = document.createElement('div');
    panel.id = 'ma-ai-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '88px', right: '24px', zIndex: '99999', width: '360px',
      background: '#fff', borderRadius: '12px', boxShadow: '0 8px 32px rgba(0,0,0,.22)',
      display: 'none', flexDirection: 'column', overflow: 'hidden', fontFamily: "var(--font-family),'Roboto',Arial,sans-serif"
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
          <textarea id="ma-prompt-input" rows="3" placeholder="e.g. Focus on null safety and error handling…" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dadce0;border-radius:6px;font:inherit;font-size:13px;resize:vertical;transition:border-color .2s;outline:none;"></textarea>
        </div>
        <div id="ma-history-row" style="display:none;">
          <label style="font-size:11px;color:#5f6368;display:block;margin-bottom:3px;">Recent prompts</label>
          <select id="ma-history-select" style="width:100%;padding:5px 8px;border:1px solid #dadce0;border-radius:6px;font-size:12px;color:#444;background:#fafafa;">
            <option value="">— select a previous prompt —</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="ma-review-btn" style="flex:1;padding:9px 0;background:#1a73e8;color:#fff;border:none;border-radius:6px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .2s;">Run AI Review</button>
          <button id="ma-clear-btn" title="Clear history" style="padding:9px 12px;background:#f1f3f4;color:#5f6368;border:none;border-radius:6px;font:inherit;font-size:12px;cursor:pointer;">🗑</button>
        </div>
        <div id="ma-log" style="display:none;background:#f8f9fa;border-radius:6px;padding:10px;font-size:12px;color:#3c4043;max-height:160px;overflow-y:auto;line-height:1.6;font-family:monospace;"></div>
      </div>
    `;

    document.documentElement.appendChild(panel);
    panelEl = panel;
    logEl = panel.querySelector('#ma-log');

    panel.querySelector('#ma-panel-close').addEventListener('click', closePanel);
    panel.querySelector('#ma-review-btn').addEventListener('click', runAiReview);
    panel.querySelector('#ma-clear-btn').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); refreshHistoryDropdown(); });
    panel.querySelector('#ma-prompt-input').addEventListener('focus', e => e.target.style.borderColor = '#1a73e8');
    panel.querySelector('#ma-prompt-input').addEventListener('blur',  e => e.target.style.borderColor = '#dadce0');
    panel.querySelector('#ma-history-select').addEventListener('change', e => { if (e.target.value) panel.querySelector('#ma-prompt-input').value = e.target.value; });

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

  async function runAiReview() {
    const changeNum = getChangeNumber();
    const patchSet = await getEffectivePatchSetNumber(changeNum);
    if (!changeNum) return;

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

      logMsg('Refreshing diff view…', 'muted');

      const grDiffHost = getGrDiffHost();
      if (grDiffHost) {
        grDiffHost.dispatchEvent(new CustomEvent('reload', { bubbles: true, composed: true, detail: { clearPatchset: false } }));
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
      logMsg('Error: ' + (err.message || String(err)), 'err');
      btn.disabled    = false;
      btn.textContent = 'Run AI Review';
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      background: '#ea4335', color: '#fff', borderRadius: '8px',
      fontSize: '10px', fontWeight: '700', padding: '1px 5px',
      lineHeight: '1.4', pointerEvents: 'none',
    });
    badge.textContent = n;
    wrapper.appendChild(badge);
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      togglePanel();
    }
  });

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
  function displaySavedComments(table, filePath, options = {}) {
    const { preserveOpenEdit = true } = options;
    const diffElement = getDiffElement();
    if (diffElement) ensureStylesInjected(diffElement);

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
      const displayText = stripMarker(
        isAi ? text.replace(/^🤖 AI Review:\n\n/, '') : text
      );

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

      const card     = tr.querySelector('.ma-card');
      const body     = tr.querySelector('.ma-card-body');
      const editArea = tr.querySelector('.ma-card-edit');
      editArea.addEventListener('click', ev => ev.stopPropagation());
      editArea.addEventListener('mousedown', ev => ev.stopPropagation());
      editArea.addEventListener('pointerdown', ev => ev.stopPropagation());
      
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

      tr.querySelector('.ma-resolve-checkbox').addEventListener('change', async ev => {
        ev.stopPropagation();
        const newResolved = ev.target.checked;
        comment.resolved = newResolved;
        card.classList.toggle('resolved', newResolved);
        try {
          const changeNum = getChangeNumber();
          const patchSet =
            comment.patchSet != null
              ? String(comment.patchSet)
              : await getEffectivePatchSetNumber(changeNum);
          const baseText = isAi ? AI_PREFIX + '\n\n' + displayText : displayText;
          const storageText = appendMarker(baseText, extractMarkerId(comment.text) || toGerritDraftId(commentId));
          await updateDraft(changeNum, patchSet, toGerritDraftId(commentId), storageText, !newResolved);
        } catch (err) {
          ev.target.checked = !newResolved;
          comment.resolved = !newResolved;
          card.classList.toggle('resolved', !newResolved);
        }
      });

      tr.querySelector('.ma-edit-btn').addEventListener('click', ev => {
        ev.stopPropagation();
        editingCommentId = commentId;
        activeEditState = { commentId, text: textarea.value };
        body.style.display     = 'none';
        editArea.style.display = 'block';
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });

      tr.querySelector('.ma-edit-cancel').addEventListener('click', ev => {
        ev.stopPropagation();
        textarea.value = displayText;
        editingCommentId = null;
        activeEditState = null;
        body.style.display     = '';
        editArea.style.display = 'none';
      });

      const saveBtn = tr.querySelector('.ma-edit-save');
      saveBtn.addEventListener('mousedown', ev => ev.stopPropagation());
      saveBtn.addEventListener('pointerdown', ev => ev.stopPropagation());
      saveBtn.addEventListener('click', async ev => {
        ev.stopPropagation();
        ev.stopImmediatePropagation();
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

        try {
          const baseText = isAi ? AI_PREFIX + '\n\n' + newText : newText;
          const storageText = appendMarker(baseText, extractMarkerId(comment.text) || toGerritDraftId(commentId));
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
          comment.text = storageText;
          editingCommentId = null;
          activeEditState = null;
          displaySavedComments(table, filePath, { preserveOpenEdit: false });
        } catch (err) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save draft';
          const msg = err?.message || String(err) || 'Unknown error';
          saveBtn.insertAdjacentHTML('afterend',
            `<span style="color:#c62828;font-size:11px;margin-left:6px;" class="ma-save-err">⚠ ${escHtml(msg)}</span>`
          );
          editingCommentId = commentId;
        }
      });

      tr.querySelector('.ma-discard-btn').addEventListener('click', async ev => {
        ev.stopPropagation();
        const btn = tr.querySelector('.ma-discard-btn');
        btn.disabled = true; btn.textContent = 'Deleting…';
        const ok = await deleteMultiAnchorComment(commentId);
        if (ok) { displaySavedComments(table, filePath); updateFabBadge(); }
        else    { btn.disabled = false; btn.textContent = 'Discard'; }
      });

      tr.addEventListener('mouseenter', () => highlightLines(table, filePath, lines, true));
      tr.addEventListener('mouseleave', () => {
        if (!tr.classList.contains('ma-active')) highlightLines(table, filePath, lines, false);
      });
      tr.addEventListener('click', () => {
        const active = document.activeElement;
        if (active && ['TEXTAREA', 'INPUT', 'BUTTON'].includes(active.tagName)) return;
        const on = tr.classList.toggle('ma-active');
        highlightLines(table, filePath, lines, on);
      });

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
    if (selectedLines.has(lineKey)) {
      selectedLines.delete(lineKey);
      setSelectedVisual(row, side, false);
    } else {
      selectedLines.add(lineKey);
      setSelectedVisual(row, side, true);
    }
  }

  function clearSelectionDeep() {
    selectedLines.clear();
    walkShadowTree(document.body, node => {
      if (node.nodeType !== 1 || !node.querySelectorAll) return;
      node.querySelectorAll('td.multi-anchor-selected').forEach(td => {
        td.classList.remove('multi-anchor-selected');
        td.querySelectorAll('div.contentText').forEach(el => { el.style.backgroundColor = ''; });
        td.querySelectorAll('button.lineNumButton').forEach(el => { el.style.backgroundColor = ''; });
      });
    });
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
    if (!positionKey) return;

    const stats = getPendingAnchorStats();
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
      tr.remove(); clearSelectionDeep();
    });

    tr.querySelector('.ma-new-save').addEventListener('click', async () => {
      const text     = textarea.value.trim();
      const resolved = tr.querySelector('.ma-new-resolved').checked;
      if (!text) return;
      const saveBtn = tr.querySelector('.ma-new-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      tr.querySelector('.ma-save-err')?.remove();

      const { draft, error } = await createMultiAnchorComment(selectedLines, text, resolved);
      if (draft) {
        tr.remove(); clearSelectionDeep();
        displaySavedComments(table, filePath);
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save draft';
        const msg = error?.message || String(error) || 'Unknown error';
        saveBtn.insertAdjacentHTML('afterend',
          `<span style="color:#c62828;font-size:11px;margin-left:6px;" class="ma-save-err">⚠ ${escHtml(msg)}</span>`
        );
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
        showCommentBox(table, filePath);
      }
    }

    if (e.key === 'Escape' && hasDraftRowDeep()) {
      removeDraftRowsDeep();
      clearSelectionDeep();
    }
  }

  // ── Single Page App Lifecycle Engine ──────────────────────────────────────
  let currentRouteKey = null;
  let isFetchingRoute = false;

  async function checkRouteAndLoad() {
    const changeNum = getChangeNumber();
    if (!changeNum) {
      currentRouteKey = null;
      return;
    }

    const psToken = getPatchSetNumber();
    const routeKey = `${changeNum}|${psToken}`;
    
    if (routeKey !== currentRouteKey) {
      if (isFetchingRoute) return;
      isFetchingRoute = true;
      currentRouteKey = routeKey;
      commentsLoaded = false;
      
      diffLineMapCache.clear();

      try {
        const patchSet = await getEffectivePatchSetNumber(changeNum);

        try {
          const [additionalRanges, drafts] = await Promise.all([
            getAllAdditionalRanges(changeNum).catch(() => ({})),
            restApi.get(`/changes/${changeNum}/drafts`).catch(() => ({})),
          ]);
          Object.keys(additionalRanges || {}).forEach(k => managedGerritIds.add(toGerritDraftId(k)));
          for (const comments of Object.values(drafts || {})) {
            for (const c of comments || []) {
              if (c?.message?.startsWith(AI_PREFIX) || extractMarkerId(c?.message)) {
                managedGerritIds.add(c.id);
              }
            }
          }
        } catch(e) {}

        await loadMultiAnchorComments(changeNum, patchSet);
      } finally {
        isFetchingRoute = false;
      }
    }
  }

  // ── Absolute Lifecycle & Thread Hider Loop ────────────────────────────────
  let diffObserver         = null;
  let observedDiffRoot     = null;

  setInterval(async () => {
    // 1. Ensure we hide native threads regardless of DOM shifts
    const changeNum = getChangeNumber();
    if (changeNum) {
      const host = getGrDiffHost();
      if (host && host.shadowRoot) {
        injectHiderStyle(host.shadowRoot);
        host.shadowRoot.querySelectorAll('gr-comment-thread:not([data-ma-hidden="1"])').forEach(el => {
          try {
            let shouldHide = false;
            const thread = el.thread;
            
            if (thread) {
              const rawId = thread.rootId || thread.comments?.[0]?.id || '';
              shouldHide = managedGerritIds.has(rawId);
            }
            
            const textContent = el.innerText || '';
            const htmlContent = el.shadowRoot?.innerHTML || '';
            if (!shouldHide && (textContent.includes('🤖 AI Review:') || htmlContent.includes('🤖 AI Review:'))) shouldHide = true;
            if (!shouldHide && (textContent.includes('[MA-ID:') || htmlContent.includes('[MA-ID:'))) shouldHide = true;

            if (shouldHide) {
              el.dataset.maHidden = '1';
              el.style.display = 'none';
              const tr = el.closest('tr');
              if (tr) tr.style.display = 'none';
            }
          } catch {}
        });
      }
    }

    // 2. Poll for DOM & Route Changes
    const diffElement = getDiffElement();
    if (!diffElement) return;

    ensureStylesInjected(diffElement);
    injectAiPanel();

    const { table, filePath } = getTablePathPair(diffElement);
    if (!table || !filePath) return;

    if (!documentHooksInstalled) {
      documentHooksInstalled = true;
      document.addEventListener('click', onDocumentClickCapture, true);
      document.addEventListener('keydown', onDocumentKeydownCapture, true);
    }

    await checkRouteAndLoad();

    if (!commentsLoaded || isEditSessionActive()) return;

    displaySavedComments(table, filePath);
    const applied = applyPendingSelectionToTable(table, filePath);
    if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
      schedulePendingSelectionReapply(filePath, 0);
    }

    if (diffElement.shadowRoot && observedDiffRoot !== diffElement.shadowRoot) {
      observedDiffRoot = diffElement.shadowRoot;
      if (diffObserver) diffObserver.disconnect();
      diffObserver = new MutationObserver(() => {
        clearTimeout(window._maDebounce);
        window._maDebounce = setTimeout(() => refreshCurrentDiffView(), 150);
      });
      diffObserver.observe(diffElement.shadowRoot, { childList: true, subtree: true });
    }
  }, 150);

});
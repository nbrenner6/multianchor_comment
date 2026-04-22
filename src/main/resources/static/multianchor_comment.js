/**
 * Multi-Anchor Comment Plugin for Gerrit
 *
 * Extends Gerrit's code review UI to support comments anchored to multiple
 * non-adjacent lines and across multiple files in the same change. Standard
 * Gerrit only allows comments on a single line or a contiguous range; this
 * plugin lets reviewers reference scattered but related lines (e.g., a call
 * site and its definition in another file) in one comment thread.
 *
 * @see README.md for build and usage instructions.
 */
Gerrit.install(plugin => {

  console.log('[multianchor-comment] JS loaded');

  // In-memory storage for multi-anchor comments
  const savedComments = new Map();
  let commentIdCounter = 1;

  /** Set of JSON anchor keys ({repo path, side, line}). Cleared on comment save/cancel. */
  const selectedLines = new Set();

  /**
   * Injects CSS styles into the Gerrit diff element that are specific to the
   * multi-anchor comment plug-in
   * 
   * This function appends a <style> tag to the diffElement that is provided
   * in the function call, highlighting (yellow), anchored-line indicators
   * (blue border), and hover highlights.
   * 
   * Styles rely on Gerrit's slass names and table structure.
   * 
   * @param {HTMLElement} diffElement 
   * @returns {void}
   */
  function injectStyles(diffElement) {
    const style = document.createElement('style');
    style.textContent = `
      td.multi-anchor-selected div.contentText {
        background-color: rgba(255, 200, 0, 0.3) !important;
      }
      td.multi-anchor-selected button.lineNumButton {
        background-color: rgba(255, 200, 0, 0.3) !important;
      }

      /* AC1: Visual indicators for anchored lines */
      td.multi-anchor-existing div.contentText {
        border-left: 3px solid rgb(25, 103, 210) !important;
        background-color: rgba(66, 133, 244, 0.12) !important;
      }
      td.multi-anchor-existing button.lineNumButton {
        background-color: rgba(66, 133, 244, 0.15) !important;
      }

      /* AC2: Highlighted state for hover/click */
      td.multi-anchor-highlighted div.contentText {
        background-color: rgba(66, 133, 244, 0.35) !important;
        border-left: 3px solid rgb(25, 103, 210) !important;
      }
      td.multi-anchor-highlighted button.lineNumButton {
        background-color: rgba(66, 133, 244, 0.35) !important;
      }

      /* Comment thread styling */
      .multi-anchor-thread {
        cursor: pointer;
      }

    `;

    diffElement.appendChild(style);
  }

  /**
   * Styles are attached per gr-diff-element instance. Gerrit can replace that
   * element on file switches, so re-check before interactions.
   *
   * @param {HTMLElement | null} diffElement
   */
  function ensureStylesInjected(diffElement) {
    if (!diffElement) {
      return;
    }
    if (!diffElement.dataset.multianchorStylesInjected) {
      diffElement.dataset.multianchorStylesInjected = '1';
      injectStyles(diffElement);
    }
  }

  /**
   * @param {string} filePath - repo path for this diff (from gr-diff-host)
   * @param {"left" | "right"} side
   * @param {string} lineNum
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
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  function formatAnchorLabel(key) {
    const a = parseAnchorKey(key);
    if (!a) {
      return key;
    }
    const base = (a.path && a.path.includes('/')) ? a.path.split('/').pop() : a.path;
    const lr = a.side === 'left' ? 'L' : 'R';
    return a.path ? `${base}:${lr}${a.lineNum}` : `${lr}${a.lineNum}`;
  }

  /**
   * Formats anchors as grouped-by-file labels, e.g.
   * "foo.js: R2, R4; bar.js: L10".
   *
   * @param {string[]} keys
   * @returns {string}
   */
  function formatGroupedAnchorLabels(keys) {
    const byPath = new Map();
    keys.forEach(key => {
      const a = parseAnchorKey(key);
      if (!a) {
        return;
      }
      const base = (a.path && a.path.includes('/')) ? a.path.split('/').pop() : a.path;
      const fileLabel = base || a.path || 'unknown-file';
      const lineLabel = `${a.side === 'left' ? 'L' : 'R'}${a.lineNum}`;
      if (!byPath.has(fileLabel)) {
        byPath.set(fileLabel, []);
      }
      byPath.get(fileLabel).push(lineLabel);
    });

    if (byPath.size === 0) {
      return keys.map(formatAnchorLabel).join(', ');
    }
    return [...byPath.entries()]
      .map(([fileLabel, lines]) => `${fileLabel}: ${lines.join(', ')}`)
      .join('; ');
  }

  /**
   * Walks composed ancestors and shadow hosts to find gr-diff-host (holds .path).
   *
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
      }
      else {
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
    if (!host) {
      return '';
    }
    return host.path || host.getAttribute?.('path') || '';
  }

  /**
   * @param {HTMLElement | null} diffElement - gr-diff-element
   * @returns {{ table: HTMLTableElement | null, filePath: string }}
   */
  function getTablePathPair(diffElement) {
    if (!diffElement) {
      return { table: null, filePath: '' };
    }
    const table =
      (diffElement.shadowRoot && diffElement.shadowRoot.querySelector('table#diffTable')) ||
      diffElement.querySelector('table#diffTable');
    const filePath = getFilePathForDiffContext(diffElement);
    return { table, filePath };
  }

  /**
   * Last anchor in insertion order that belongs to currentPath (for draft placement).
   *
   * @param {string[]} keys
   * @param {string} currentPath
   * @returns {string | null}
   */
  function getLastAnchorKeyForFile(keys, currentPath) {
    for (let i = keys.length - 1; i >= 0; i--) {
      const a = parseAnchorKey(keys[i]);
      if (a && a.path === currentPath) {
        return keys[i];
      }
    }
    return null;
  }

  /**
   * @param {HTMLTableElement} table
   * @param {{ path: string, side: string, lineNum: string } | null} anchor
   * @returns {HTMLTableRowElement | null}
   */
  function findRowForAnchor(table, anchor) {
    if (!table || !anchor) {
      return null;
    }
    return table.querySelector(`td.${anchor.side}.lineNum[data-value="${anchor.lineNum}"]`)?.closest('tr') || null;
  }

  function walkShadowTree(node, callback) {
    if (!node) {
      return;
    }
    callback(node);
    if (node.shadowRoot) {
      walkShadowTree(node.shadowRoot, callback);
    }
    const ch = node.children;
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        walkShadowTree(ch[i], callback);
      }
    }
  }

  /**
   * Clears selected styling everywhere (needed when selection spans files).
   */
  function clearSelectionDeep() {
    selectedLines.clear();
    walkShadowTree(document.body, (node) => {
      if (node.nodeType !== 1 || !node.querySelectorAll) {
        return;
      }
      node.querySelectorAll('td.multi-anchor-selected').forEach(td => {
        td.classList.remove('multi-anchor-selected');
        td.querySelectorAll('div.contentText').forEach(el => {
          el.style.backgroundColor = '';
        });
        td.querySelectorAll('button.lineNumButton').forEach(el => {
          el.style.backgroundColor = '';
        });
      });
    });
  }

  function removeDraftRowsDeep() {
    walkShadowTree(document.body, (node) => {
      if (node.nodeType !== 1 || !node.querySelectorAll) {
        return;
      }
      node.querySelectorAll('tr.multi-anchor-comment-row').forEach(tr => tr.remove());
    });
  }

  /**
   * Re-applies yellow selection for pending anchors visible in this file's table.
   *
   * @param {HTMLTableElement} table
   * @param {string} filePath
   * @returns {number} number of anchors that were re-highlighted
   */
  function applyPendingSelectionToTable(table, filePath) {
    if (!table || !filePath) {
      return 0;
    }
    let appliedCount = 0;
    selectedLines.forEach(key => {
      const a = parseAnchorKey(key);
      if (!a || a.path !== filePath) {
        return;
      }
      const row = findRowForAnchor(table, a);
      if (row) {
        setSelectedVisual(row, a.side, true);
        appliedCount++;
      }
    });
    return appliedCount;
  }

  /**
   * @param {string} filePath
   * @returns {boolean}
   */
  function hasPendingAnchorsForFile(filePath) {
    for (const key of selectedLines) {
      const a = parseAnchorKey(key);
      if (a && a.path === filePath) {
        return true;
      }
    }
    return false;
  }

  /**
   * @returns {{ anchorCount: number, fileCount: number }}
   */
  function getPendingAnchorStats() {
    const files = new Set();
    selectedLines.forEach(key => {
      const a = parseAnchorKey(key);
      if (a && a.path) {
        files.add(a.path);
      }
    });
    return {
      anchorCount: selectedLines.size,
      fileCount: files.size
    };
  }

  /**
   * Gerrit sometimes paints table rows after initial file-switch DOM updates.
   * Retry a few times so pending selection reappears when returning to a file.
   *
   * @param {string} filePath
   * @param {number} attempt
   */
  function schedulePendingSelectionReapply(filePath, attempt) {
    if (attempt >= 5) {
      return;
    }
    setTimeout(() => {
      const diffElement = getDiffElement();
      const { table, filePath: currentPath } = getTablePathPair(diffElement);
      if (!table || currentPath !== filePath) {
        return;
      }
      const applied = applyPendingSelectionToTable(table, filePath);
      if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
        schedulePendingSelectionReapply(filePath, attempt + 1);
      }
    }, 140);
  }

  /**
   * Re-renders threads for the visible diff and restores in-progress selection for this file.
   */
  function refreshCurrentDiffView() {
    const diffElement = getDiffElement();
    const { table, filePath } = getTablePathPair(diffElement);
    if (!table || !filePath) {
      return;
    }
    if (diffObserver) {
      diffObserver.disconnect();
    }
    try {
      displaySavedComments(table, filePath);
      const applied = applyPendingSelectionToTable(table, filePath);
      if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
        schedulePendingSelectionReapply(filePath, 0);
      }
    }
    finally {
      if (diffElement.shadowRoot && diffObserver) {
        diffObserver.observe(diffElement.shadowRoot, { childList: true, subtree: true });
      }
    }
  }

  let documentHooksInstalled = false;
  let diffObserver = null;
  let observedDiffRoot = null;
  let attachPollInstalled = false;

  /**
   * Applies/removes visible selected styling directly on row cells as a fallback
   * when Gerrit replaces style scopes during navigation.
   *
   * @param {HTMLTableRowElement} row
   * @param {"left" | "right"} side
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

  /** 
   * Toggles the selected state for a specific diff line in a multi-anchor 
   * comment
   * 
   * If the lineKey has already been selected, it updates the global variable,
   * selectedLinesSet, removing it. It also updates the corresponding table cells,
   * removing the selected class. If the lineKey has NOT already been selected,
   * this function adds its corresponding lineKey and gives it the selected styling.
   * 
   * @param {string} lineKey - JSON from makeAnchorKey (includes file path)
   * @param {"left" | "right"} side - denotes the side of the diff the line is on
   * @param {HTMLTableRowElement} row - the row element representing the line in the diff
   * @returns {void}
   */
  function toggleLine(lineKey, side, row) {
    if (selectedLines.has(lineKey)) {
      selectedLines.delete(lineKey);
      setSelectedVisual(row, side, false);
    }
    else {
      selectedLines.add(lineKey);
      setSelectedVisual(row, side, true);
    }
  }

  /**
   * Creates, inserts, and does the rendering for a multi-anchor comment draft box
   * in the diff table. 
   * 
   * US2: Renders a draft comment box anchored below the last selected line.
   * Displays all anchored line numbers for confirmation and provides Save/Cancel actions.
   * 
   * Draft is placed under the last selected line in the **currently visible** file.
   * Open a file where you picked lines if the draft does not open (see console).
   *
   * @param {HTMLTableElement} table - the Gerrit diff table for the visible file
   * @param {string} filePath - repo path for that table
   * @returns {void}
   */
  function showCommentBox(table, filePath) {
    removeDraftRowsDeep();

    const keys = [...selectedLines];
    const positionKey = getLastAnchorKeyForFile(keys, filePath);
    if (!positionKey) {
      console.warn(
        '[multianchor-comment] Open a file where you selected lines to compose the draft (Ctrl/Cmd+click lines, then press c).'
      );
      return;
    }

    const lineLabels = formatGroupedAnchorLabels(keys);
    const stats = getPendingAnchorStats();
    const pendingHint = `(${stats.anchorCount} anchors pending across ${stats.fileCount} files)`;

    const tr = document.createElement('tr');
    tr.classList.add('multi-anchor-comment-row');
    tr.innerHTML = `
      <td colspan="2"></td>
      <td colspan="2" style="padding: 0; border-top: 1px solid var(--border-color); overflow: hidden;">
        <div style="
          background-color: rgb(254, 247, 224);
          padding: var(--spacing-m);
          font-family: var(--font-family), 'Roboto', Arial, sans-serif;
          font-size: var(--font-size-normal, 1rem);
          display: flex;
          align-items: center;
          overflow: hidden;
        ">
          <span style="color: var(--info-foreground);">✏</span>&nbsp;
          <span style="font-weight: var(--font-weight-medium);">Draft</span>
          <span style="color: var(--deemphasized-text-color); margin-left: var(--spacing-s); font-weight: normal;">
            · Multi-anchor: ${lineLabels}
          </span>
          <span style="color: var(--deemphasized-text-color); margin-left: var(--spacing-s); font-style: italic;">
            ${pendingHint}
          </span>
        </div>
        <div style="
          background-color: rgb(254, 247, 224);
          padding: var(--spacing-m);
          font-family: var(--font-family), 'Roboto', Arial, sans-serif;
          font-size: var(--font-size-normal, 1rem);
          color: var(--primary-text-color);
          overflow: hidden;
        ">
          <textarea class="multi-anchor-textarea" rows="4" placeholder="Mention others with @" style="
            display: block; margin-bottom: var(--spacing-m); width: 100%;
            box-sizing: border-box; font: inherit;
            background-color: white;
            border: 1px solid var(--border-color);
            border-radius: var(--border-radius);
            color: rgb(32, 33, 35);
            padding: var(--spacing-s);
          "></textarea>
          <div style="display: flex; justify-content: space-between; user-select: none;">
            <div style="display: flex; align-items: center; flex: 1;">
              <label style="display: flex; align-items: center; color: var(--comment-text-color);">
                <input type="checkbox" class="multi-anchor-resolved" style="margin-right: var(--spacing-s);"> Resolved
              </label>
            </div>
            <div style="display: flex;">
              <button class="multi-anchor-cancel" style="
                background: none; border: none; color: var(--link-color);
                cursor: pointer; font: inherit; padding: 0 var(--spacing-s);
                font-weight: var(--font-weight-medium);
              ">Cancel</button>
              <button class="multi-anchor-save" style="
                background: none; border: none; color: var(--link-color);
                cursor: pointer; font: inherit; padding: 0 var(--spacing-s);
                font-weight: var(--font-weight-medium);
              ">Save</button>
            </div>
          </div>
        </div>
      </td>
    `;

    const pos = parseAnchorKey(positionKey);
    const lastRow = findRowForAnchor(table, pos);
    if (lastRow) {
      lastRow.insertAdjacentElement('afterend', tr);
    }
    else {
      table.appendChild(tr);
    }

    tr.querySelector('.multi-anchor-save').addEventListener('click', () => {
      const text = tr.querySelector('.multi-anchor-textarea').value;
      const resolved = tr.querySelector('.multi-anchor-resolved').checked;

      if (!text.trim()) {
        return;
      }

      // Save to in-memory storage
      const commentId = `comment-${commentIdCounter++}`;
      savedComments.set(commentId, {
        lines: [...selectedLines],
        text: text,
        resolved: resolved
      });

      console.log('Multi-anchor comment saved:', savedComments.get(commentId));

      tr.remove();
      clearSelectionDeep();

      // Display the saved comment with AC1, AC2, AC3 handlers
      refreshCurrentDiffView();
    });

    tr.querySelector('.multi-anchor-cancel').addEventListener('click', () => {
      tr.remove();
      clearSelectionDeep();
    });

    tr.querySelector('.multi-anchor-textarea').focus();
  }

  /**
   * Marks lines associated w/ a multi-anchor comment. Adds the class 
   * 'multi-anchor-existing' to all of the table cells on the selected lines,
   * visually indicating they are anchored in a comment thread.
   * 
   * AC1
   * 
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {string} filePath - only anchors for this file are marked in this table
   * @param {string[]} lines - array of anchor keys
   */
  function markAnchoredLines(table, filePath, lines) {
    lines.forEach(lineKey => {
      const a = parseAnchorKey(lineKey);
      if (!a || a.path !== filePath) {
        return;
      }
      const row = findRowForAnchor(table, a);
      if (row) {
        row.querySelectorAll(`td.${a.side}`).forEach(td => {
          td.classList.add('multi-anchor-existing');
        });
      }
    });
  }


  /**
   * Temporarily highlihgts the lines associated with a multi-anchor comment
   * 
   * Specifically, used for the hover/click interactions (AC2), visually 
   * linking comment thread with its lines 
   * 
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {string} filePath - only anchors in this file are highlighted here
   * @param {string[]} lines - array of anchor keys
   */
  function highlightCommentLines(table, filePath, lines) {
    lines.forEach(lineKey => {
      const a = parseAnchorKey(lineKey);
      if (!a || a.path !== filePath) {
        return;
      }
      const row = findRowForAnchor(table, a);
      if (row) {
        row.querySelectorAll(`td.${a.side}`).forEach(td => {
          td.classList.add('multi-anchor-highlighted');
        });
      }
    });
  }


  /**
   * Reverses the effects of highlightCommentLines, removing the 'multi-anchor-highlighted'
   * class from the specified lines
   * 
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {string} filePath - only anchors in this file
   * @param {string[]} lines - array of anchor keys that will be unhighlighted
   */
  function unhighlightCommentLines(table, filePath, lines) {
    lines.forEach(lineKey => {
      const a = parseAnchorKey(lineKey);
      if (!a || a.path !== filePath) {
        return;
      }
      const row = findRowForAnchor(table, a);
      if (row) {
        row.querySelectorAll(`td.${a.side}`).forEach(td => {
          td.classList.remove('multi-anchor-highlighted');
        });
      }
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Renders saved comments that touch this file. Threads for multi-file comments
   * appear once per file (under the last anchor in that file).
   *
   * US3: Re-renders all saved comment threads and their associated line markers.
   * Rebuilds from scratch to keep the DOM in sync with the in-memory store.
   *
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {string} filePath - repo path for this diff
   */
  function displaySavedComments(table, filePath) {
    // Remove all existing comment threads first
    table.querySelectorAll('.multi-anchor-thread').forEach(el => el.remove());

    // Clear existing line markers (both anchored and highlighted)
    table.querySelectorAll('td.multi-anchor-existing').forEach(td => {
      td.classList.remove('multi-anchor-existing');
    });
    table.querySelectorAll('td.multi-anchor-highlighted').forEach(td => {
      td.classList.remove('multi-anchor-highlighted');
    });

    // Display each saved comment that has at least one anchor in this file
    savedComments.forEach((comment, commentId) => {
      const { lines, text, resolved } = comment;

      const hasAnchorHere = lines.some(lk => parseAnchorKey(lk)?.path === filePath);
      if (!hasAnchorHere) {
        return;
      }

      // AC1: Mark anchored lines visible in this table
      markAnchoredLines(table, filePath, lines);

      // Create comment thread element (labels list all files)
      const lineLabels = formatGroupedAnchorLabels(lines);

      const tr = document.createElement('tr');
      tr.classList.add('multi-anchor-thread');
      tr.dataset.commentId = commentId;
      tr.innerHTML = `
        <td colspan="2"></td>
        <td colspan="2" style="padding: 0; border-top: 1px solid var(--border-color); overflow: hidden;">
          <div style="
            background-color: ${resolved ? 'rgb(232, 245, 233)' : 'rgb(254, 247, 224)'};
            padding: var(--spacing-m);
            font-family: var(--font-family), 'Roboto', Arial, sans-serif;
            font-size: var(--font-size-normal, 1rem);
            color: rgb(32, 33, 35);
            overflow: hidden; word-wrap: break-word;
          ">
            <div style="margin-bottom: var(--spacing-s);">
              <strong>${resolved ? '✓' : '💬'} Comment</strong> · Lines: ${lineLabels}
              ${resolved ? '<span style="color: rgb(56, 142, 60); font-size: 0.9em; margin-left: var(--spacing-s);">(Resolved)</span>' : ''}
            </div>
            <div style="white-space: pre-wrap;">
              ${escapeHtml(text)}
            </div>
            <div style="margin-top: var(--spacing-s); display: flex; gap: var(--spacing-s); justify-content: flex-end;">
              <button class="ma-resolve-btn" style="
                background: none; border: none; color: var(--link-color);
                cursor: pointer; font: inherit; padding: 0 var(--spacing-s);
                font-weight: var(--font-weight-medium);
              ">${resolved ? 'Unresolve' : 'Resolve'}</button>
              <button class="ma-discard-btn" style="
                background: none; border: none; color: rgb(217, 48, 37);
                cursor: pointer; font: inherit; padding: 0 var(--spacing-s);
                font-weight: var(--font-weight-medium);
              ">Discard</button>
            </div>
          </div>
        </td>
      `;

      // Resolve button handler
      tr.querySelector('.ma-resolve-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        comment.resolved = !comment.resolved;
        refreshCurrentDiffView();
      });

      // Discard button handler
      tr.querySelector('.ma-discard-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        savedComments.delete(commentId);
        refreshCurrentDiffView();
      });

      // AC2: Add hover handlers to highlight associated lines (respects persistent toggle)
      tr.addEventListener('mouseenter', () => {
        highlightCommentLines(table, filePath, lines);
      });

      tr.addEventListener('mouseleave', () => {
        // Only unhighlight if NOT persistently toggled on
        if (!tr.classList.contains('active-highlight')) {
          unhighlightCommentLines(table, filePath, lines);
        }
      });

      // AC3: Click to toggle persistent highlight
      tr.addEventListener('click', () => {
        const isHighlighted = tr.classList.contains('active-highlight');
        if (isHighlighted) {
          tr.classList.remove('active-highlight');
          unhighlightCommentLines(table, filePath, lines);
        } else {
          tr.classList.add('active-highlight');
          highlightCommentLines(table, filePath, lines);
        }
      });

      // Insert after the last anchored line in *this* file
      const lastKeyHere = getLastAnchorKeyForFile(lines, filePath);
      const lastHere = lastKeyHere ? parseAnchorKey(lastKeyHere) : null;
      const lastRow = findRowForAnchor(table, lastHere);
      if (lastRow) {
        lastRow.insertAdjacentElement('afterend', tr);
      } else {
        table.appendChild(tr);
      }
    });
  }

  /**
   * Traverses Gerrit's nested shadow DOM to reach the diff table element.
   * Gerrit uses Polymer/Lit web components, so each layer is behind a shadowRoot.
   * Returns null if any component hasn't rendered yet (handled by retry in attachListeners).
   * 
   * @returns {HTMLElement | null} - the diff element, or null if doesn't exist
   * Traverses Gerrit's nested shadow DOM to reach the diff table element.
   * Gerrit uses Polymer/Lit web components, so each layer is behind a shadowRoot.
   * Returns null if any component hasn't rendered yet (handled by retry in attachListeners).
   */
  function getDiffElement() {
    try {
      return document.querySelector('gr-app').shadowRoot
        .querySelector('gr-app-element').shadowRoot
        .querySelector('gr-diff-view').shadowRoot
        .querySelector('gr-diff-host').shadowRoot
        .querySelector('gr-diff').shadowRoot
        .querySelector('gr-diff-element');
    }
    catch (e) {
      return null;
    }
  }

  function hasDraftRowDeep() {
    let found = false;
    walkShadowTree(document.body, (node) => {
      if (found) {
        return;
      }
      if (node.nodeType === 1 && node.matches && node.matches('tr.multi-anchor-comment-row')) {
        found = true;
      }
    });
    return found;
  }

  /**
   * Finds the first element in composedPath() that matches a selector,
   * accounting for shadow DOM event retargeting.
   *
   * @param {Event} e
   * @param {string} selector
   * @returns {Element | null}
   */
  function findPathElement(e, selector) {
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : [e.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) {
        continue;
      }
      if (node.matches && node.matches(selector)) {
        return node;
      }
      if (node.closest) {
        const match = node.closest(selector);
        if (match) {
          return match;
        }
      }
    }
    return null;
  }

  /**
   * US1 + US5: Only intercept clicks with Ctrl/Cmd held on any diff table (including
   * after navigating between files). Paths come from gr-diff-host.
   */
  function onDocumentClickCapture(e) {
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }
    const currentDiffElement = findPathElement(e, 'gr-diff-element') || getDiffElement();
    ensureStylesInjected(currentDiffElement);

    const table = findPathElement(e, 'table#diffTable');
    if (!table) {
      return;
    }

    const contextNode = findPathElement(e, 'td.left, td.right') || table;
    const filePath = getFilePathForDiffContext(contextNode);
    if (!filePath) {
      return;
    }

    const row = findPathElement(e, 'tr');
    if (!row) {
      return;
    }

    const sideCell = findPathElement(e, 'td.right, td.left');
    if (!sideCell) {
      return;
    }
    const side = sideCell.classList.contains('right') ? 'right' : 'left';

    const lineNumCell = row.querySelector(`td.${side}.lineNum`);

    if (!lineNumCell) {
      return;
    }

    const lineNum = lineNumCell.dataset.value;
    if (!lineNum || lineNum === 'LOST' || lineNum === 'FILE') {
      return;
    }

    const lineKey = makeAnchorKey(filePath, side, lineNum);
    toggleLine(lineKey, side, row);

    console.log('Selected lines:', [...selectedLines]);
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * US2: 'c' opens a comment box; Escape dismisses it. Uses capture phase
   * to intercept before Gerrit's own 'c' shortcut (single-line comment).
   */
  function onDocumentKeydownCapture(e) {
    const tag = e.target.tagName;
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'INPUT') {
      return;
    }

    if (e.key === 'c' && hasDraftRowDeep()) {
      return;
    }

    if (e.key === 'c' && selectedLines.size > 0) {
      const diffElement = getDiffElement();
      const { table, filePath } = getTablePathPair(diffElement);
      if (table && filePath) {
        console.log('c pressed, showing multi-anchor box');
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

  /**
   * Attaches click and keyboard listeners to the diff table once it's available.
   * Retries via setTimeout if the diff hasn't rendered yet (Gerrit loads lazily).
   * system, including:
   *  - polling for diff elements/table
   *  - providing styles for the plugin
   *  - renders saved comments when it's loaded
   *  - handles multi-line selection and keyboard shortcuts
   * 
   * @returns {void}
   */
  function attachListeners() {
    const diffElement = getDiffElement();
    if (!diffElement) {
      setTimeout(attachListeners, 500);
      return;
    }

    ensureStylesInjected(diffElement);

    const { table, filePath } = getTablePathPair(diffElement);
    if (!table || !filePath) {
      setTimeout(attachListeners, 500);
      return;
    }

    if (!documentHooksInstalled) {
      documentHooksInstalled = true;
      document.addEventListener('click', onDocumentClickCapture, true);
      document.addEventListener('keydown', onDocumentKeydownCapture, true);
    }

    // Gerrit can swap the diff element/root between file navigations without
    // reliably triggering the previous observer. Keep a lightweight poll so
    // pending selections are rehydrated when returning to a file.
    if (!attachPollInstalled) {
      attachPollInstalled = true;
      setInterval(() => {
        attachListeners();
      }, 700);
    }

    displaySavedComments(table, filePath);
    const applied = applyPendingSelectionToTable(table, filePath);
    if (applied === 0 && hasPendingAnchorsForFile(filePath)) {
      schedulePendingSelectionReapply(filePath, 0);
    }

    if (diffElement.shadowRoot && observedDiffRoot !== diffElement.shadowRoot) {
      observedDiffRoot = diffElement.shadowRoot;
      if (diffObserver) {
        diffObserver.disconnect();
      }
      diffObserver = new MutationObserver(() => {
        clearTimeout(attachListeners._debounce);
        attachListeners._debounce = setTimeout(() => {
          refreshCurrentDiffView();
        }, 150);
      });
      diffObserver.observe(diffElement.shadowRoot, { childList: true, subtree: true });
    }
  }

  setTimeout(attachListeners, 1000);
});

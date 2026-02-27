Gerrit.install(plugin => {

  console.log('[multianchor-comment] JS loaded');

  // Get the plugin's REST API helper
  const restApi = plugin.restApi();

  // In-memory cache for multi-anchor comments (synced with backend)
  const savedComments = new Map();

  /**
   * Gets the current change number from the URL.
   * URL format: /c/PROJECT/+/CHANGE_NUMBER/[PATCHSET]/[FILE]
   */
  function getChangeNumber() {
    const match = window.location.pathname.match(/\/c\/[^/]+\/\+\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Gets the current patchset number from the URL.
   */
  function getPatchSetNumber() {
    const match = window.location.pathname.match(/\/c\/[^/]+\/\+\/\d+\/(\d+)/);
    return match ? match[1] : 'current';
  }

  /**
   * Gets the current file path from the URL.
   */
  function getFilePath() {
    const match = window.location.pathname.match(/\/c\/[^/]+\/\+\/\d+\/\d+\/(.+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Converts selected line keys to Comment.Range format.
   * @param {Set<string>} lineKeys - Set of "side-lineNum" strings
   * @param {string} side - "left" or "right" to filter by
   * @returns {Array<Range>} Array of range objects
   */
  function lineKeysToRanges(lineKeys, side) {
    const lineNums = [...lineKeys]
      .filter(key => key.startsWith(side))
      .map(key => parseInt(key.split('-')[1], 10))
      .sort((a, b) => a - b);

    if (lineNums.length === 0) return [];

    // Group consecutive lines into ranges
    const ranges = [];
    let rangeStart = lineNums[0];
    let rangeEnd = lineNums[0];

    for (let i = 1; i < lineNums.length; i++) {
      if (lineNums[i] === rangeEnd + 1) {
        rangeEnd = lineNums[i];
      } else {
        ranges.push({
          startLine: rangeStart,
          startCharacter: 0,
          endLine: rangeEnd,
          endCharacter: 0
        });
        rangeStart = lineNums[i];
        rangeEnd = lineNums[i];
      }
    }
    ranges.push({
      startLine: rangeStart,
      startCharacter: 0,
      endLine: rangeEnd,
      endCharacter: 0
    });

    return ranges;
  }

  /**
   * Creates a draft comment via Gerrit's native API.
   * Note: Gerrit uses PUT (not POST) to create draft comments.
   * For whole-line selections, we only send 'line' (no range).
   * @returns {Promise<Object>} The created comment info
   */
  async function createDraft(changeNum, patchSet, path, range, message) {
    const endpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts`;

    // For whole-line selections (startChar=0, endChar=0), don't send a range
    // Just use the line number like native Gerrit comments
    const body = {
      path: path,
      line: range.endLine,
      message: message
    };

    console.log('[multianchor] Creating draft:', endpoint);
    console.log('[multianchor] Request body:', JSON.stringify(body, null, 2));
    return restApi.put(endpoint, body);
  }

  /**
   * Deletes a draft comment via Gerrit's native API.
   */
  async function deleteDraft(changeNum, patchSet, draftId) {
    const endpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts/${draftId}`;
    console.log('[multianchor] Deleting draft:', endpoint);
    return restApi.delete(endpoint);
  }

  /**
   * Saves additional ranges for a comment via plugin API.
   */
  async function saveAdditionalRanges(changeNum, commentUuid, ranges) {
    const endpoint = `/changes/${changeNum}/multianchor-ranges/${commentUuid}`;
    const body = { ranges: ranges };
    console.log('[multianchor] Saving additional ranges:', endpoint, body);
    return restApi.put(endpoint, body);
  }

  /**
   * Gets additional ranges for a comment via plugin API.
   */
  async function getAdditionalRanges(changeNum, commentUuid) {
    const endpoint = `/changes/${changeNum}/multianchor-ranges/${commentUuid}`;
    return restApi.get(endpoint);
  }

  /**
   * Deletes additional ranges for a comment via plugin API.
   */
  async function deleteAdditionalRanges(changeNum, commentUuid) {
    const endpoint = `/changes/${changeNum}/multianchor-ranges/${commentUuid}`;
    console.log('[multianchor] Deleting additional ranges:', endpoint);
    return restApi.delete(endpoint);
  }

  /**
   * Gets all additional ranges for a change via plugin API.
   */
  async function getAllAdditionalRanges(changeNum) {
    const endpoint = `/changes/${changeNum}/multianchor-ranges`;
    return restApi.get(endpoint);
  }

  /**
   * Loads all drafts and their additional ranges.
   */
  async function loadMultiAnchorComments(changeNum, patchSet) {
    try {
      // Get all drafts from Gerrit
      const draftsEndpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts`;
      const drafts = await restApi.get(draftsEndpoint);

      // Get all additional ranges from plugin
      const additionalRanges = await getAllAdditionalRanges(changeNum);

      console.log('[multianchor] Loaded drafts:', drafts);
      console.log('[multianchor] Loaded additional ranges:', additionalRanges);

      // Clear and rebuild cache
      savedComments.clear();

      // Process drafts - drafts is a map of path -> array of comments
      for (const [path, comments] of Object.entries(drafts || {})) {
        for (const comment of comments) {
          const uuid = comment.id;
          const extraRanges = additionalRanges[uuid] || [];

          // Only include comments that have additional ranges (multi-anchor)
          if (extraRanges.length > 0) {
            // Combine primary range with additional ranges
            const allRanges = comment.range ? [comment.range, ...extraRanges] : extraRanges;

            // Convert ranges to line keys for UI
            const lines = allRanges.flatMap(range => {
              const lineKeys = [];
              for (let line = range.startLine; line <= range.endLine; line++) {
                lineKeys.push(`right-${line}`);  // Assuming right side for now
              }
              return lineKeys;
            });

            savedComments.set(uuid, {
              id: uuid,
              path: path,
              lines: lines,
              text: comment.message,
              resolved: comment.unresolved === false,
              primaryRange: comment.range,
              additionalRanges: extraRanges
            });
          }
        }
      }

      console.log('[multianchor] Cached comments:', savedComments);
      return savedComments;
    } catch (error) {
      console.error('[multianchor] Error loading comments:', error);
      return savedComments;
    }
  }

  /**
   * Creates a multi-anchor comment (draft + additional ranges).
   */
  async function createMultiAnchorComment(selectedLines, message, resolved) {
    const changeNum = getChangeNumber();
    const patchSet = getPatchSetNumber();
    const path = getFilePath();

    if (!changeNum || !path) {
      console.error('[multianchor] Cannot determine change or file path');
      return null;
    }

    // Determine which side has the most selections
    const rightLines = [...selectedLines].filter(k => k.startsWith('right'));
    const leftLines = [...selectedLines].filter(k => k.startsWith('left'));
    const side = rightLines.length >= leftLines.length ? 'right' : 'left';

    // Convert line selections to ranges
    const allRanges = lineKeysToRanges(selectedLines, side);

    if (allRanges.length === 0) {
      console.error('[multianchor] No valid ranges selected');
      return null;
    }

    try {
      // 1. Create draft with primary (first) range via Gerrit API
      const primaryRange = allRanges[0];
      const draft = await createDraft(changeNum, patchSet, path, primaryRange, message);

      console.log('[multianchor] Created draft:', draft);

      // 2. If there are additional ranges, save them via plugin API
      if (allRanges.length > 1) {
        const additionalRanges = allRanges.slice(1);
        await saveAdditionalRanges(changeNum, draft.id, additionalRanges);
      }

      // 3. Add to local cache
      savedComments.set(draft.id, {
        id: draft.id,
        path: path,
        lines: [...selectedLines],
        text: message,
        resolved: resolved,
        primaryRange: primaryRange,
        additionalRanges: allRanges.slice(1)
      });

      return draft;
    } catch (error) {
      console.error('[multianchor] Error creating comment:', error);
      return null;
    }
  }

  /**
   * Deletes a multi-anchor comment (draft + additional ranges).
   */
  async function deleteMultiAnchorComment(commentId) {
    const changeNum = getChangeNumber();
    const patchSet = getPatchSetNumber();

    if (!changeNum) {
      console.error('[multianchor] Cannot determine change number');
      return false;
    }

    try {
      // 1. Delete additional ranges from plugin storage
      await deleteAdditionalRanges(changeNum, commentId);

      // 2. Delete draft from Gerrit
      await deleteDraft(changeNum, patchSet, commentId);

      // 3. Remove from local cache
      savedComments.delete(commentId);

      return true;
    } catch (error) {
      console.error('[multianchor] Error deleting comment:', error);
      return false;
    }
  }

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

  const selectedLines = new Set();

  function toggleLine(lineKey, side, row) {
    if (selectedLines.has(lineKey)) {
      selectedLines.delete(lineKey);
      row.querySelectorAll(`td.${side}`).forEach(td => td.classList.remove('multi-anchor-selected'));
    }
    else {
      selectedLines.add(lineKey);
      row.querySelectorAll(`td.${side}`).forEach(td => td.classList.add('multi-anchor-selected'));
    }
  }

  function showCommentBox(table, selectedLines) {
    const existing = table.querySelector('tr.multi-anchor-comment-row');
    if (existing) {
      existing.remove();
    }

    const lineLabels = [...selectedLines].join(', ');

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

    // insert after last
    const lastLineKey = [...selectedLines][selectedLines.size - 1];
    const [side, lineNum] = lastLineKey.split('-');
    const lastRow = table.querySelector(`td.${side}.lineNum[data-value="${lineNum}"]`)?.closest('tr');
    if (lastRow) {
      lastRow.insertAdjacentElement('afterend', tr);
    }
    else {
      table.appendChild(tr);
    }

    tr.querySelector('.multi-anchor-save').addEventListener('click', async () => {
      const text = tr.querySelector('.multi-anchor-textarea').value;
      const resolved = tr.querySelector('.multi-anchor-resolved').checked;

      if (!text.trim()) {
        return;
      }

      // Disable buttons while saving
      tr.querySelector('.multi-anchor-save').disabled = true;
      tr.querySelector('.multi-anchor-save').textContent = 'Saving...';

      try {
        // Save to backend via REST API
        const draft = await createMultiAnchorComment(selectedLines, text, resolved);

        if (draft) {
          console.log('[multianchor] Comment saved:', draft);
          tr.remove();
          clearSelection(table);

          // Display the saved comment with AC1, AC2, AC3 handlers
          displaySavedComments(table);
        } else {
          console.error('[multianchor] Failed to save comment');
          tr.querySelector('.multi-anchor-save').disabled = false;
          tr.querySelector('.multi-anchor-save').textContent = 'Save';
        }
      } catch (error) {
        console.error('[multianchor] Error saving comment:', error);
        tr.querySelector('.multi-anchor-save').disabled = false;
        tr.querySelector('.multi-anchor-save').textContent = 'Save';
      }
    });

    tr.querySelector('.multi-anchor-cancel').addEventListener('click', () => {
      tr.remove();
      clearSelection(table);
    });

    tr.querySelector('.multi-anchor-textarea').focus();
  }

  function clearSelection(table) {
    selectedLines.clear();
    table.querySelectorAll('td.multi-anchor-selected div.contentText').forEach(el => {
      el.style.backgroundColor = '';
    });
    table.querySelectorAll('td.multi-anchor-selected button.lineNumButton').forEach(el => {
      el.style.backgroundColor = '';
    });
    table.querySelectorAll('td.multi-anchor-selected').forEach(td => {
      td.classList.remove('multi-anchor-selected');
    });
  }

  // AC1: Mark all anchored lines with visual indicators  
  function markAnchoredLines(table, lines) {
    lines.forEach(lineKey => {
      const [side, lineNum] = lineKey.split('-');
      const row = table.querySelector(`td.${side}.lineNum[data-value="${lineNum}"]`)?.closest('tr');
      if (row) {
        row.querySelectorAll(`td.${side}`).forEach(td => {
          td.classList.add('multi-anchor-existing');
        });
      }
    });
  }

  // AC2: Highlight lines associated with a comment on hover/click
  function highlightCommentLines(table, lines) {
    lines.forEach(lineKey => {
      const [side, lineNum] = lineKey.split('-');
      const row = table.querySelector(`td.${side}.lineNum[data-value="${lineNum}"]`)?.closest('tr');
      if (row) {
        row.querySelectorAll(`td.${side}`).forEach(td => {
          td.classList.add('multi-anchor-highlighted');
        });
      }
    });
  }

  function unhighlightCommentLines(table, lines) {
    lines.forEach(lineKey => {
      const [side, lineNum] = lineKey.split('-');
      const row = table.querySelector(`td.${side}.lineNum[data-value="${lineNum}"]`)?.closest('tr');
      if (row) {
        row.querySelectorAll(`td.${side}`).forEach(td => {
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

  function displaySavedComments(table) {
    // Remove all existing comment threads first
    table.querySelectorAll('.multi-anchor-thread').forEach(el => el.remove());

    // Clear existing line markers (both anchored and highlighted)
    table.querySelectorAll('td.multi-anchor-existing').forEach(td => {
      td.classList.remove('multi-anchor-existing');
    });
    table.querySelectorAll('td.multi-anchor-highlighted').forEach(td => {
      td.classList.remove('multi-anchor-highlighted');
    });

    // Display each saved comment
    savedComments.forEach((comment, commentId) => {
      const { lines, text, resolved } = comment;

      // AC1: Mark all anchored lines
      markAnchoredLines(table, lines);

      // Create comment thread element
      const lineLabels = lines.map(lk => {
        const [side, num] = lk.split('-');
        return `${side === 'left' ? 'L' : 'R'}${num}`;
      }).join(', ');

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
        displaySavedComments(table);
      });

      // Discard button handler
      tr.querySelector('.ma-discard-btn').addEventListener('click', async (ev) => {
        ev.stopPropagation();

        const btn = tr.querySelector('.ma-discard-btn');
        btn.disabled = true;
        btn.textContent = 'Deleting...';

        try {
          const success = await deleteMultiAnchorComment(commentId);
          if (success) {
            console.log('[multianchor] Comment deleted:', commentId);
            displaySavedComments(table);
          } else {
            btn.disabled = false;
            btn.textContent = 'Discard';
          }
        } catch (error) {
          console.error('[multianchor] Error deleting comment:', error);
          btn.disabled = false;
          btn.textContent = 'Discard';
        }
      });

      // AC2: Add hover handlers to highlight associated lines (respects persistent toggle)
      tr.addEventListener('mouseenter', () => {
        highlightCommentLines(table, lines);
      });

      tr.addEventListener('mouseleave', () => {
        // Only unhighlight if NOT persistently toggled on
        if (!tr.classList.contains('active-highlight')) {
          unhighlightCommentLines(table, lines);
        }
      });

      // AC3: Click to toggle persistent highlight
      tr.addEventListener('click', () => {
        const isHighlighted = tr.classList.contains('active-highlight');
        if (isHighlighted) {
          tr.classList.remove('active-highlight');
          unhighlightCommentLines(table, lines);
        } else {
          tr.classList.add('active-highlight');
          highlightCommentLines(table, lines);
        }
      });

      // Insert after the last anchored line
      const lastLineKey = lines[lines.length - 1];
      const [side, lineNum] = lastLineKey.split('-');
      const lastRow = table.querySelector(`td.${side}.lineNum[data-value="${lineNum}"]`)?.closest('tr');
      if (lastRow) {
        lastRow.insertAdjacentElement('afterend', tr);
      } else {
        table.appendChild(tr);
      }
    });
  }

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

  function attachListeners() {
    const diffElement = getDiffElement();
    if (!diffElement) {
      setTimeout(attachListeners, 500);
      return;
    }

    injectStyles(diffElement);

    const table = diffElement.querySelector('table#diffTable');
    if (!table) {
      setTimeout(attachListeners, 500);
      return;
    }

    // Load and display comments from backend on initial load
    const changeNum = getChangeNumber();
    const patchSet = getPatchSetNumber();
    if (changeNum) {
      loadMultiAnchorComments(changeNum, patchSet).then(() => {
        displaySavedComments(table);
      });
    }

    table.addEventListener('click', function (e) {
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }

      const row = e.target.closest('tr');
      if (!row) {
        return;
      }

      const isRight = e.target.closest('td.right') !== null;
      const isLeft = e.target.closest('td.left') !== null;
      if (!isRight && !isLeft) {
        return;
      }

      const side = isRight ? 'right' : 'left';

      const lineNumCell = row.querySelector(`td.${side}.lineNum`);

      if (!lineNumCell) {
        return;
      }

      const lineNum = lineNumCell.dataset.value;
      if (!lineNum || lineNum === 'LOST' || lineNum === 'FILE') {
        return;
      }

      const lineKey = `${side}-${lineNum}`;
      toggleLine(lineKey, side, row);

      console.log('Selected lines:', [...selectedLines]);
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('keydown', function (e) {
      // Block if typing in any text field (check both target and active element)
      const tag = e.target.tagName;
      const activeTag = document.activeElement && document.activeElement.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'INPUT') {
        return;
      }

      // Also block if a comment box is already open
      if (e.key === 'c' && table.querySelector('tr.multi-anchor-comment-row')) {
        return;
      }

      if (e.key === 'c' && selectedLines.size > 0) {
        console.log('c pressed, showing multi-anchor box');
        e.stopImmediatePropagation();
        e.preventDefault();
        showCommentBox(table, selectedLines);
      }
      if (e.key === 'Escape') {
        const existing = table.querySelector('tr.multi-anchor-comment-row');
        if (existing) {
          existing.remove();
          clearSelection(table);
        }
      }
    }, true);
  }

  setTimeout(attachListeners, 1000);
});

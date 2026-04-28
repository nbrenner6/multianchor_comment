/**
 * Multi-Anchor Comment Plugin for Gerrit
 *
 * Extends Gerrit's code review UI to support comments anchored to multiple
 * non-adjacent lines within a single diff view. Standard Gerrit only allows
 * comments on a single line or a contiguous range; this plugin lets reviewers
 * reference scattered but related lines (e.g., a renamed variable and all its
 * call sites) in one comment thread.
 *
 * @see README.md for build and usage instructions.
 */
Gerrit.install(plugin => {

  // Get the plugin's REST API helper
  const restApi = plugin.restApi();

  // In-memory cache for multi-anchor comments (synced with backend)
  const savedComments = new Map();

  /**
   * Gets the current change number from the URL.
   * URL format: /c/PROJECT/+/CHANGE_NUMBER/[PATCHSET]/[FILE]
   * Supports multi-segment project names (e.g., myorg/myrepo).
   */
  function getChangeNumber() {
    const match = window.location.pathname.match(/\/c\/(.+?)\/\+\/(\d+)/);
    return match ? match[2] : null;
  }

  /**
   * Gets the current patchset number from the URL.
   * Returns 'current' if patchset is not specified.
   */
  function getPatchSetNumber() {
    const match = window.location.pathname.match(/\/c\/.+?\/\+\/\d+\/(\d+)/);
    return match ? match[1] : 'current';
  }

  /** Cache so we do not refetch change detail on every operation while the URL still implies "current". */
  let effectivePatchSetCache = { changeNum: null, urlToken: null, resolved: null };

  /**
   * Returns the patchset string to use for APIs and storage keys.
   * When the URL omits a revision, Gerrit uses "current" for draft endpoints, but plugin storage
   * keys use numeric patchset numbers; this resolves "current" via change detail.
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
    const detail = await restApi.get(`/changes/${changeNum}/detail`);
    const rev = detail.revisions[detail.current_revision];
    const resolved = String(rev._number);
    effectivePatchSetCache = { changeNum, urlToken, resolved };
    return resolved;
  }

  /**
   * Gets the current file path from the URL.
   * Supports URLs with or without explicit patchset number.
   */
  function getFilePath() {
    // Try with patchset number first
    let match = window.location.pathname.match(/\/c\/.+?\/\+\/\d+\/\d+\/(.+)/);
    if (match) {
      return decodeURIComponent(match[1]);
    }
    // Try without patchset number (uses 'current')
    match = window.location.pathname.match(/\/c\/.+?\/\+\/\d+\/([^0-9].*)$/);
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
          start_line: rangeStart,
          start_character: 0,
          end_line: rangeEnd,
          end_character: 0
        });
        rangeStart = lineNums[i];
        rangeEnd = lineNums[i];
      }
    }
    ranges.push({
      start_line: rangeStart,
      start_character: 0,
      end_line: rangeEnd,
      end_character: 0
    });

    return ranges;
  }

  /**
   * Creates a draft comment via Gerrit's native API.
   * Note: Gerrit uses PUT (not POST) to create draft comments.
   * Preserves full range information for multi-line selections.
   * @param {string} changeNum - The change number
   * @param {string} patchSet - The patchset number
   * @param {string} path - The file path
   * @param {Object} range - The range object with start_line, start_character, end_line, end_character
   * @param {string} message - The comment message
   * @param {boolean} unresolved - Whether the comment is unresolved
   * @param {string} side - 'PARENT' for left side, 'REVISION' for right side (optional)
   * @returns {Promise<Object>} The created comment info
   */
  async function createDraft(changeNum, patchSet, path, range, message, unresolved, side) {
    const endpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts`;

    const body = {
      path: path,
      message: message,
      unresolved: unresolved
    };

    // Include side if specified (PARENT for left, REVISION for right)
    if (side === 'left') {
      body.side = 'PARENT';
    }

    // For whole-line selections (startChar=0, endChar=0, single line), use line only
    // For multi-line or character-specific selections, include the full range
    const isWholeLineSingleLine =
      range.start_line === range.end_line &&
      range.start_character === 0 &&
      range.end_character === 0;

    if (isWholeLineSingleLine) {
      body.line = range.start_line;
    } else {
      body.line = range.start_line;
      body.range = {
        start_line: range.start_line,
        start_character: range.start_character,
        end_line: range.end_line,
        end_character: range.end_character
      };
    }

    return restApi.put(endpoint, body);
  }

  /**
   * Deletes a draft comment via Gerrit's native API.
   */
  async function deleteDraft(changeNum, patchSet, draftId) {
    const endpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts/${draftId}`;
    return restApi.delete(endpoint);
  }

  /**
   * Saves additional ranges for a comment via plugin API.
   */
  async function saveAdditionalRanges(changeNum, patchSet, commentUuid, ranges) {
    const compositeId = `${patchSet}~${commentUuid}`;
    const endpoint = `/changes/${changeNum}/multianchor-ranges/${compositeId}`;
    const body = { ranges: ranges };
    return await restApi.put(endpoint, body);
  }

  /**
   * Gets additional ranges for a comment via plugin API.
   */
  async function getAdditionalRanges(changeNum, patchSet, commentUuid) {
    const compositeId = `${patchSet}~${commentUuid}`;
    const endpoint = `/changes/${changeNum}/multianchor-ranges/${compositeId}`;
    return restApi.get(endpoint);
  }

  /**
   * Deletes additional ranges for a comment via plugin API.
   */
  async function deleteAdditionalRanges(changeNum, patchSet, commentUuid) {
    const compositeId = `${patchSet}~${commentUuid}`;
    const endpoint = `/changes/${changeNum}/multianchor-ranges/${compositeId}`;
    return restApi.delete(endpoint);
  }

  /**
   * Updates a draft comment's resolved state via Gerrit's native API.
   * @param {string} changeNum - The change number
   * @param {string} patchSet - The patchset number
   * @param {string} draftId - The draft comment ID
   * @param {boolean} resolved - Whether the comment should be resolved
   * @returns {Promise<Object>} The updated comment info
   */
  async function updateDraftResolved(changeNum, patchSet, draftId, resolved) {
    const endpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts/${draftId}`;
    return restApi.put(endpoint, { unresolved: !resolved });
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
  async function loadMultiAnchorComments(changeNum) {
    try {
      const patchSet = await getEffectivePatchSetNumber(changeNum);
      // Get all drafts from Gerrit
      const draftsEndpoint = `/changes/${changeNum}/revisions/${patchSet}/drafts`;
      const drafts = await restApi.get(draftsEndpoint);

      // Get all additional ranges from plugin
      const additionalRanges = await getAllAdditionalRanges(changeNum);

      // Clear and rebuild cache
      savedComments.clear();

      // Process drafts - drafts is a map of path -> array of comments
      for (const [path, comments] of Object.entries(drafts || {})) {
        for (const comment of comments) {
          const uuid = comment.id;

          // Build the composite key used in plugin storage: "{patchSet}/{uuid}"
          const compositeKey = `${patchSet}/${uuid}`;
          const extraRanges = additionalRanges[compositeKey] || [];

          // Only include comments that have additional ranges (multi-anchor)
          if (extraRanges.length > 0) {
            // Combine primary range with additional ranges.
            // comment.range is only set when we sent a range object; when we sent only `line`,
            // Gerrit stores no range so we reconstruct it from comment.line.
            const primaryRange = comment.range ||
              (comment.line ? {start_line: comment.line, start_character: 0, end_line: comment.line, end_character: 0} : null);
            const allRanges = primaryRange ? [primaryRange, ...extraRanges] : extraRanges;

            // Convert ranges to line keys for UI
            const lines = allRanges.flatMap(range => {
              const lineKeys = [];
              for (let line = range.start_line; line <= range.end_line; line++) {
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

      return savedComments;
    } catch (error) {
      return savedComments;
    }
  }

  /**
   * Creates a multi-anchor comment (draft + additional ranges).
   * Implements compensation logic for atomicity: if saveAdditionalRanges fails,
   * the draft is deleted to avoid inconsistent state.
   */
  async function createMultiAnchorComment(selectedLines, message, resolved) {
    const changeNum = getChangeNumber();
    const path = getFilePath();

    if (!changeNum || !path) {
      return null;
    }

    const patchSet = await getEffectivePatchSetNumber(changeNum);

    // Determine which side has the most selections
    const rightLines = [...selectedLines].filter(k => k.startsWith('right'));
    const leftLines = [...selectedLines].filter(k => k.startsWith('left'));
    const side = rightLines.length >= leftLines.length ? 'right' : 'left';

    // Convert line selections to ranges
    const allRanges = lineKeysToRanges(selectedLines, side);

    if (allRanges.length === 0) {
      return null;
    }

    let draft = null;
    try {
      // 1. Create draft with primary (first) range via Gerrit API
      const primaryRange = allRanges[0];
      draft = await createDraft(changeNum, patchSet, path, primaryRange, message, !resolved, side);

      // 2. If there are additional ranges, save them via plugin API
      if (allRanges.length > 1) {
        const additionalRanges = allRanges.slice(1);
        try {
          await saveAdditionalRanges(changeNum, patchSet, draft.id, additionalRanges);
        } catch (rangeError) {
          // Compensation: delete the draft to maintain consistency
          console.error('Failed to save additional ranges, compensating by deleting draft:', rangeError);
          try {
            await deleteDraft(changeNum, patchSet, draft.id);
          } catch (deleteError) {
            console.error('Compensation delete failed:', deleteError);
          }
          throw rangeError;
        }
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
      console.error('Failed to create multi-anchor comment:', error);
      return null;
    }
  }

  /**
   * Deletes a multi-anchor comment (draft + additional ranges).
   * Implements retry logic for atomicity: if deleteAdditionalRanges fails,
   * retries with backoff and logs the partial failure.
   */
  async function deleteMultiAnchorComment(commentId) {
    const changeNum = getChangeNumber();

    if (!changeNum) {
      return false;
    }

    const patchSet = await getEffectivePatchSetNumber(changeNum);

    // Store comment data for potential restoration
    const commentData = savedComments.get(commentId);

    try {
      // 1. Delete draft from Gerrit first
      await deleteDraft(changeNum, patchSet, commentId);

      // 2. Delete additional ranges from plugin storage with retry
      let rangeDeleteSuccess = false;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await deleteAdditionalRanges(changeNum, patchSet, commentId);
          rangeDeleteSuccess = true;
          break;
        } catch (rangeError) {
          lastError = rangeError;
          console.warn(`Attempt ${attempt + 1} to delete additional ranges failed:`, rangeError);
          if (attempt < 2) {
            // Wait before retry (exponential backoff: 100ms, 200ms)
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          }
        }
      }

      if (!rangeDeleteSuccess) {
        // Log partial failure - draft deleted but ranges remain (orphaned)
        console.error('Partial delete: draft deleted but additional ranges remain:', lastError);
        // Still consider this a success for the user since the draft is gone
        // The orphaned range data will be ignored since it references a non-existent comment
      }

      // 3. Remove from local cache
      savedComments.delete(commentId);

      return true;
    } catch (error) {
      console.error('Failed to delete multi-anchor comment:', error);
      return false;
    }
  }

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

  /** Set of currently selected line keys (format: "left-42" or "right-17"). Cleared on comment save/cancel. */
  const selectedLines = new Set();

  /**
   * Toggles the selected state for a specific diff line in a multi-anchor
   * comment
   *
   * If the lineKey has already been selected, it updates the global variable,
   * selectedLinesSet, removing it. It also updates the corresponding table cells,
   * removing the selected class. If the lineKey has NOT already been selected,
   * this function adds its corresponding lineKey and gives it the selected styling.
   *
   * @param {string} lineKey - unique ID for a line, uses the format "side-lineNum"
   * @param {"left" | "right"} side - denotes the side of the diff the line is on
   * @param {HTMLTableRowElement} row - the row element representing the line in the diff
   * @returns {void}
   */
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

  /**
   * Creates, inserts, and does the rendering for a multi-anchor comment draft box
   * in the diff table.
   *
   * US2: Renders a draft comment box anchored below the last selected line.
   * Displays all anchored line numbers for confirmation and provides Save/Cancel actions.
   *
   * @param {HTMLTableElement} table - the Gerrit diff table
   * @param {Set<String>} selectedLines - set of line keys that are currently
   * selected
   * @returns {void}
   */
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
          tr.remove();
          clearSelection(table);

          // Display the saved comment with AC1, AC2, AC3 handlers
          displaySavedComments(table);
        } else {
          tr.querySelector('.multi-anchor-save').disabled = false;
          tr.querySelector('.multi-anchor-save').textContent = 'Save';
        }
      } catch (error) {
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

  /**
   * Clears all selected lines and removes their visual highlights.
   *
   * This function empties the selectedLines Set, and removes inline styling
   * that was applied to the selected cells.
   *
   * @param {HTMLTableElement} table - Gerrit diff table that contains the
   * selected rows
   */

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

  /**
   * Marks lines associated w/ a multi-anchor comment. Adds the class
   * 'multi-anchor-existing' to all of the table cells on the selected lines,
   * visually indicating they are anchored in a comment thread.
   *
   * AC1
   *
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {*} lines - array of line keys
   */
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


  /**
   * Temporarily highlihgts the lines associated with a multi-anchor comment
   *
   * Specifically, used for the hover/click interactions (AC2), visually
   * linking comment thread with its lines
   *
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {*} lines - array of line keys
   */
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


  /**
   * Reverses the effects of highlightCommentLines, removing the 'multi-anchor-highlighted'
   * class from the specified lines
   *
   * @param {HTMLTableElement} table - Gerrit diff table
   * @param {string[]} lines - array of line keys that will be unhighlighted
   */
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

  /**
   * Renders the saved multi-anchored comments in the diff table. Comment threads
   * will be inserted after the last anchored line for a given comment
   *
   * US3: Re-renders all saved comment threads and their associated line markers.
   * Rebuilds from scratch to keep the DOM in sync with the in-memory store.
   * Only displays comments for the current file path.
   *
   * @param {*} table - Gerrit diff table
   */
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

    // Get current file path to filter comments
    const currentPath = getFilePath();

    // Display each saved comment (only for current file)
    savedComments.forEach((comment, commentId) => {
      const { lines, text, resolved, path } = comment;

      // Skip comments not belonging to the current file
      if (path !== currentPath) {
        return;
      }

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

      // Resolve button handler - persists the resolved state to the backend
      tr.querySelector('.ma-resolve-btn').addEventListener('click', async (ev) => {
        ev.stopPropagation();

        const btn = tr.querySelector('.ma-resolve-btn');
        const originalText = btn.textContent;
        const newResolved = !comment.resolved;

        // Optimistic UI update
        comment.resolved = newResolved;
        btn.disabled = true;
        btn.textContent = 'Saving...';
        displaySavedComments(table);

        try {
          const changeNum = getChangeNumber();
          const patchSet = await getEffectivePatchSetNumber(changeNum);
          await updateDraftResolved(changeNum, patchSet, commentId, newResolved);
          // Success - UI already updated optimistically
        } catch (error) {
          // Revert on failure
          console.error('Failed to update resolved state:', error);
          comment.resolved = !newResolved;
          displaySavedComments(table);
        }
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
            displaySavedComments(table);
          } else {
            btn.disabled = false;
            btn.textContent = 'Discard';
          }
        } catch (error) {
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

  function getGrDiffHost() {
    try {
      return document.querySelector('gr-app').shadowRoot
        .querySelector('gr-app-element').shadowRoot
        .querySelector('gr-diff-view').shadowRoot
        .querySelector('gr-diff-host');
    }
    catch (e) {
      return null;
    }
  }

  /**
   * Hides any native Gerrit comment threads whose rootId is in savedComments.
   * Multi-anchor comments are rendered by the plugin, so the native thread is redundant.
   */
  function hideNativeThreadsForMultiAnchor(root) {
    if (savedComments.size === 0) return;
    root.querySelectorAll('gr-comment-thread').forEach(threadEl => {
      try {
        const thread = threadEl.thread;
        if (!thread) return;
        const rootId = thread.rootId ||
          (thread.comments && thread.comments[0] && thread.comments[0].id);
        if (rootId && savedComments.has(rootId)) {
          threadEl.style.display = 'none';
          const tr = threadEl.closest('tr');
          if (tr) tr.style.display = 'none';
        }
      } catch (e) {
        // ignore — thread property may not be set yet
      }
    });
  }

  /**
   * Sets up a MutationObserver on the gr-diff-host shadow root so that native
   * Gerrit comment threads for multi-anchor comments are hidden whenever Gerrit
   * (re-)renders them.
   */
  function setupNativeThreadHider() {
    const grDiffHost = getGrDiffHost();
    if (!grDiffHost || !grDiffHost.shadowRoot) return;

    const root = grDiffHost.shadowRoot;

    // Run once immediately in case threads are already rendered
    hideNativeThreadsForMultiAnchor(root);

    const observer = new MutationObserver(() => {
      hideNativeThreadsForMultiAnchor(root);
    });
    observer.observe(root, {childList: true, subtree: true});
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

    injectStyles(diffElement);

    const table = diffElement.querySelector('table#diffTable');
    if (!table) {
      setTimeout(attachListeners, 500);
      return;
    }

    // Load and display comments from backend on initial load
    const changeNum = getChangeNumber();
    if (changeNum) {
      effectivePatchSetCache = { changeNum: null, urlToken: null, resolved: null };
      loadMultiAnchorComments(changeNum).then(() => {
        displaySavedComments(table);
        setupNativeThreadHider();
      });
    }

    // US1 + US5: Only intercept clicks with Ctrl/Cmd held, so normal Gerrit
    // interactions (single-line comments, navigation) are unaffected.
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

      e.preventDefault();
      e.stopPropagation();
    });

    // US2: 'c' opens a comment box; Escape dismisses it. Uses capture phase
    // to intercept before Gerrit's own 'c' shortcut (single-line comment).
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

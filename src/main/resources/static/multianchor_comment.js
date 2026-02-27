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

  console.log('[multianchor-comment] JS loaded');

  // In-memory storage for multi-anchor comments
  const savedComments = new Map();
  let commentIdCounter = 1;

  /** Injects CSS classes for selection highlighting (yellow), anchored-line indicators (blue border), and hover highlights. */
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

  /** US1: Toggles a line's selected state and updates its visual highlight. */
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
   * US2: Renders a draft comment box anchored below the last selected line.
   * Displays all anchored line numbers for confirmation and provides Save/Cancel actions.
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
      clearSelection(table);

      // Display the saved comment with AC1, AC2, AC3 handlers
      displaySavedComments(table);
    });

    tr.querySelector('.multi-anchor-cancel').addEventListener('click', () => {
      tr.remove();
      clearSelection(table);
    });

    tr.querySelector('.multi-anchor-textarea').focus();
  }

  /** Clears all selected lines and removes their visual highlights. */
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

  /**
   * US3: Re-renders all saved comment threads and their associated line markers.
   * Rebuilds from scratch to keep the DOM in sync with the in-memory store.
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
      tr.querySelector('.ma-discard-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        savedComments.delete(commentId);
        displaySavedComments(table);
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

  /**
   * Attaches click and keyboard listeners to the diff table once it's available.
   * Retries via setTimeout if the diff hasn't rendered yet (Gerrit loads lazily).
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

    // Display any saved comments on initial load
    displaySavedComments(table);

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

      console.log('Selected lines:', [...selectedLines]);
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

Gerrit.install(plugin => {

console.log('[multianchor-comment] JS loaded');

function injectStyles(diffElement) {
  const style = document.createElement('style');
  style.textContent = `
    td.multi-anchor-selected div.contentText {
      background-color: rgba(255, 200, 0, 0.3) !important;
    }
    td.multi-anchor-selected button.lineNumButton {
      background-color: rgba(255, 200, 0, 0.3) !important;
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
    <td colspan="2" style="padding: 0; border-top: 1px solid var(--border-color);">
      <div style="
        background-color: rgb(254, 247, 224);
        padding: var(--spacing-m);
        font-family: var(--font-family), 'Roboto', Arial, sans-serif;
        font-size: var(--font-size-normal, 1rem);
        display: flex;
        align-items: center;
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
      ">
        <textarea class="multi-anchor-textarea" rows="4" placeholder="Mention others with @" style="
          display: block; margin-bottom: var(--spacing-m); width: 100%;
          box-sizing: border-box; font: inherit;
          background-color: white;
          border: 1px solid var(--border-color);
          border-radius: var(--border-radius);
          color: var(--primary-text-color);
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
    console.log('Multi-anchor comment saved:', {
      lines: [...selectedLines],
      comment: text
    });
    tr.remove();
    clearSelection(table);
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

function getDiffElement() {
  try {
    return document.querySelector('gr-app').shadowRoot
      .querySelector('gr-app-element').shadowRoot
      .querySelector('gr-diff-view').shadowRoot
      .querySelector('gr-diff-host').shadowRoot
      .querySelector('gr-diff').shadowRoot
      .querySelector('gr-diff-element');
  }
  catch(e) {
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

  table.addEventListener('click', function(e) {
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
    if (!lineNum || lineNum === 'LOST' || lineNum === 'FILE')  {
      return;
    }

    const lineKey = `${side}-${lineNum}`;
    toggleLine(lineKey, side, row);

    console.log('Selected lines:', [...selectedLines]);
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
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

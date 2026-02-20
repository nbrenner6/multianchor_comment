console.log('[multianchor-comment] JS loaded');

(function() {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = "plugins/multianchor_comment/multianchor_comment.css";
  document.head.appendChild(link);
})();

(function() {
  const selectedLines = new Set();

  function toggleLine(num, rowElt) {
    if (selectedLines.has(num)) {
      selectedLines.delete(num));
      rowElt.classList.remove("multi-anchor-selected")

    }
    else {
      selectedLines.add(num);
      rowElt.classList.add("multi-anchor-selected");
    }
  }

  function attachListeners() {
    const rows = document.querySelectorAll("tr[data-line-number]");

    rows.forEach(row => {
      row.addEventListener("click", function(e) {
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }

      const lineNum = row.getAttribute("data-line-number");
      if (!lineNum) {
        return;
      }

      toggleLine(lineNum, row);
      e.preventDefault();
      e.stopPropagation();
      });
    });
  }

  window.addEventListener("load", () => {
  setTimeout(attachListeners, 1000);
  });
})();

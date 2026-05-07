const path = require('path');

const pluginScriptPath = path.resolve(
  __dirname,
  '../../main/resources/static/multianchor_comment.js'
);

function bootPlugin() {
  jest.resetModules();
  document.body.innerHTML = '';
  document.querySelector('#ma-ai-fab-wrapper')?.remove();
  document.querySelector('#ma-ai-fab')?.remove();
  document.querySelector('#ma-ai-panel')?.remove();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.__MULTIANCHOR_TEST__ = true;
  delete window.__multianchorTestApi;
  const restApi = {
    get: jest.fn(),
    put: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  };
  global.Gerrit = {
    install: cb =>
      cb({
        restApi: () => restApi,
      }),
  };
  require(pluginScriptPath);
  return {api: window.__multianchorTestApi, restApi};
}

describe('multianchor_comment frontend helpers', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('round-trips anchor keys', () => {
    const {api} = bootPlugin();
    const key = api.makeAnchorKey('src/file.js', 'right', '42');
    expect(api.parseAnchorKey(key)).toEqual({
      path: 'src/file.js',
      side: 'right',
      lineNum: '42',
    });
  });

  test('returns null for malformed anchor keys', () => {
    const {api} = bootPlugin();
    expect(api.parseAnchorKey('not-json')).toBeNull();
    expect(api.parseAnchorKey('{"missing":"fields"}')).toBeNull();
  });

  test('formats grouped anchor labels by file and side', () => {
    const {api} = bootPlugin();
    const labels = api.formatGroupedAnchorLabels([
      api.makeAnchorKey('a/foo.ts', 'right', '10'),
      api.makeAnchorKey('a/foo.ts', 'left', '3'),
      api.makeAnchorKey('b/bar.ts', 'right', '7'),
    ]);
    expect(labels).toContain('foo.ts: R10, L3');
    expect(labels).toContain('bar.ts: R7');
  });

  test('coalesces contiguous ranges and filters by side', () => {
    const {api} = bootPlugin();
    const keys = new Set([
      api.makeAnchorKey('f', 'right', '2'),
      api.makeAnchorKey('f', 'right', '3'),
      api.makeAnchorKey('f', 'right', '6'),
      api.makeAnchorKey('f', 'left', '8'),
    ]);
    expect(api.anchorKeysToRanges(keys, 'right')).toEqual([
      {start_line: 2, start_character: 0, end_line: 3, end_character: 0},
      {start_line: 6, start_character: 0, end_line: 6, end_character: 0},
    ]);
  });

  test('converts IDs between Gerrit, url and plugin storage formats', () => {
    const {api} = bootPlugin();
    expect(api.toPluginStorageKey('abc_123', '7')).toBe('7/abc_123');
    expect(api.toGerritDraftId('7/abc_123')).toBe('abc_123');
    expect(api.toPluginUrlId('abc_123', '7')).toBe('7~abc_123');
  });

  test('returns the most recent anchor key for a file', () => {
    const {api} = bootPlugin();
    const keys = [
      api.makeAnchorKey('a', 'right', '1'),
      api.makeAnchorKey('b', 'right', '2'),
      api.makeAnchorKey('a', 'left', '8'),
    ];
    expect(api.getLastAnchorKeyForFile(keys, 'a')).toBe(keys[2]);
    expect(api.getLastAnchorKeyForFile(keys, 'missing')).toBeNull();
  });

  test('escapes html for safe insertion', () => {
    const {api} = bootPlugin();
    expect(api.escHtml('<b>unsafe</b> & "quoted"')).toBe(
      '&lt;b&gt;unsafe&lt;/b&gt; &amp; "quoted"'
    );
  });

  test('edit session lock is active when editingCommentId is set', () => {
    const {api} = bootPlugin();
    api.setEditingCommentId('comment-1');
    expect(api.isEditSessionActive()).toBe(true);
  });

  test('edit session detection walks nested shadow roots', () => {
    const {api} = bootPlugin();
    api.setEditingCommentId(null);
    api.setActiveEditState({commentId: 'comment-2', text: 'draft'});

    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = `
      <table>
        <tbody>
          <tr class="multi-anchor-thread" data-comment-id="comment-2">
            <td><div class="ma-card-edit" style="display: block;"></div></td>
          </tr>
        </tbody>
      </table>
    `;
    document.body.appendChild(host);
    expect(api.isEditSessionActive()).toBe(true);
  });

  test('edit session detection is false with no active editor', () => {
    const {api} = bootPlugin();
    api.setEditingCommentId(null);
    api.setActiveEditState(null);
    expect(api.isEditSessionActive()).toBe(false);
  });

  test('extracts change/patchset/file path from Gerrit URL', () => {
    const {api} = bootPlugin();
    window.history.pushState(
      {},
      '',
      '/c/project/+/123/5/src%2Fmain%2FApp.java'
    );
    expect(api.getChangeNumber()).toBe('123');
    expect(api.getPatchSetNumber()).toBe('5');
    expect(api.getFilePath()).toBe('src/main/App.java');
  });

  test('loadMultiAnchorComments loads plugin-managed and AI comments only', async () => {
    const {api, restApi} = bootPlugin();
    restApi.get.mockImplementation(url => {
      if (url.includes('/drafts')) {
        return Promise.resolve({
          'src/a.ts': [
            {
              id: 'draft_plugin',
              line: 12,
              message: 'plugin managed',
              unresolved: true,
            },
            {
              id: 'draft_ai',
              line: 3,
              message: `${api.AI_PREFIX}\n\nAI says hi`,
              unresolved: true,
            },
            {
              id: 'draft_other',
              line: 7,
              message: 'plain gerrit comment',
              unresolved: true,
            },
          ],
        });
      }
      if (url.endsWith('/multianchor-ranges')) {
        return Promise.resolve({
          '5/draft_plugin': [{start_line: 14, end_line: 15}],
        });
      }
      if (url.endsWith('/detail')) {
        return Promise.resolve({
          current_revision: 'abc',
          revisions: {abc: {_number: 5}},
        });
      }
      return Promise.resolve({});
    });
    window.history.pushState({}, '', '/c/p/+/123/5/src%2Fa.ts');

    await api.loadMultiAnchorComments('123', '5');
    const snapshot = Object.fromEntries(api.getSavedCommentsSnapshot());
    expect(Object.keys(snapshot).sort()).toEqual(['5/draft_ai', '5/draft_plugin']);
    expect(api.getManagedIds().sort()).toEqual(['draft_ai', 'draft_plugin']);
    expect(snapshot['5/draft_plugin'].lines).toEqual(
      expect.arrayContaining([
        api.makeAnchorKey('src/a.ts', 'right', '12'),
        api.makeAnchorKey('src/a.ts', 'right', '14'),
        api.makeAnchorKey('src/a.ts', 'right', '15'),
      ])
    );
  });

  test('createMultiAnchorComment persists draft and additional ranges', async () => {
    const {api, restApi} = bootPlugin();
    window.history.pushState({}, '', '/c/p/+/123/5/src%2Fa.ts');
    const k1 = api.makeAnchorKey('src/a.ts', 'right', '10');
    const k2 = api.makeAnchorKey('src/a.ts', 'right', '11');
    const k3 = api.makeAnchorKey('src/a.ts', 'right', '20');
    const selected = new Set([k1, k2, k3]);

    restApi.put.mockImplementation((url, body) => {
      if (url.endsWith('/drafts')) {
        return Promise.resolve({id: 'new_draft'});
      }
      if (url.includes('/multianchor-ranges/')) {
        expect(body.ranges).toEqual([
          {start_line: 20, start_character: 0, end_line: 20, end_character: 0},
        ]);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const result = await api.createMultiAnchorComment(selected, 'hello', false);
    expect(result.error).toBeNull();
    expect(result.draft.id).toBe('new_draft');
    const snapshot = Object.fromEntries(api.getSavedCommentsSnapshot());
    expect(snapshot['5/new_draft']).toBeDefined();
    expect(snapshot['5/new_draft'].patchSet).toBe('5');
    expect(snapshot['5/new_draft'].lines).toEqual(expect.arrayContaining([k1, k2, k3]));
  });

  test('deleteMultiAnchorComment deletes both draft and ranges', async () => {
    const {api, restApi} = bootPlugin();
    window.history.pushState({}, '', '/c/p/+/123/5/src%2Fa.ts');
    api.clearSavedComments();
    api.clearManagedIds();
    // use exposed create path for canonical insertion
    restApi.put.mockResolvedValueOnce({id: 'draft_del'}).mockResolvedValueOnce({});
    await api.createMultiAnchorComment(new Set([api.makeAnchorKey('src/a.ts', 'right', '9')]), 'to remove', false);

    restApi.delete.mockResolvedValue({});
    const ok = await api.deleteMultiAnchorComment('5/draft_del');
    expect(ok).toBe(true);
    expect(restApi.delete).toHaveBeenCalledWith('/changes/123/revisions/5/drafts/draft_del');
    expect(restApi.delete).toHaveBeenCalledWith('/changes/123/multianchor-ranges/5~draft_del');
  });

  test('displaySavedComments renders thread row and supports edit mode toggle', () => {
    const {api, restApi} = bootPlugin();
    restApi.get.mockResolvedValue({});
    api.clearSavedComments();
    window.history.pushState({}, '', '/c/p/+/123/5/src%2Fa.ts');
    // seed by creating one comment
    restApi.put.mockResolvedValueOnce({id: 'draft_ui'}).mockResolvedValueOnce({});

    return api
      .createMultiAnchorComment(
        new Set([api.makeAnchorKey('src/a.ts', 'right', '11')]),
        'ui text',
        false
      )
      .then(() => {
        const table = document.createElement('table');
        table.id = 'diffTable';
        table.innerHTML = `
          <tr>
            <td class="right lineNum" data-value="11">
              <button class="lineNumButton"></button>
            </td>
            <td class="right"><div class="contentText">line</div></td>
          </tr>`;
        api.displaySavedComments(table, 'src/a.ts', {preserveOpenEdit: false});
        const tr = table.querySelector('tr.multi-anchor-thread');
        expect(tr).toBeTruthy();
        const editBtn = tr.querySelector('.ma-edit-btn');
        editBtn.click();
        expect(tr.querySelector('.ma-card-edit').style.display).toBe('block');
        expect(tr.querySelector('.ma-card-body').style.display).toBe('none');
      });
  });

  test('displaySavedComments saves edited text and updates draft', async () => {
    const {api, restApi} = bootPlugin();
    window.history.pushState({}, '', '/c/p/+/123/5/src%2Fa.ts');
    restApi.put.mockResolvedValueOnce({id: 'draft_edit'}).mockResolvedValueOnce({});
    await api.createMultiAnchorComment(
      new Set([api.makeAnchorKey('src/a.ts', 'right', '19')]),
      'before edit',
      false
    );

    const table = document.createElement('table');
    table.id = 'diffTable';
    table.innerHTML = `
      <tr>
        <td class="right lineNum" data-value="19">
          <button class="lineNumButton"></button>
        </td>
        <td class="right"><div class="contentText">line</div></td>
      </tr>`;
    api.displaySavedComments(table, 'src/a.ts', {preserveOpenEdit: false});

    const tr = table.querySelector('tr.multi-anchor-thread');
    tr.querySelector('.ma-edit-btn').click();
    const textarea = tr.querySelector('.ma-edit-textarea');
    textarea.value = 'after edit';
    restApi.get.mockResolvedValueOnce({id: 'draft_edit', message: 'before edit'});
    restApi.put.mockResolvedValueOnce({});
    tr.querySelector('.ma-edit-save').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(restApi.put).toHaveBeenCalledWith(
      '/changes/123/revisions/5/drafts/draft_edit',
      expect.objectContaining({message: 'after edit'})
    );
  });

  test('displaySavedComments toggles resolved and persists unresolved=false', async () => {
    const {api, restApi} = bootPlugin();
    window.history.pushState({}, '', '/c/p/+/123/5/src%2Fa.ts');
    restApi.put.mockResolvedValueOnce({id: 'draft_resolve'}).mockResolvedValueOnce({});
    await api.createMultiAnchorComment(
      new Set([api.makeAnchorKey('src/a.ts', 'right', '21')]),
      'resolve me',
      false
    );

    const table = document.createElement('table');
    table.id = 'diffTable';
    table.innerHTML = `
      <tr>
        <td class="right lineNum" data-value="21">
          <button class="lineNumButton"></button>
        </td>
        <td class="right"><div class="contentText">line</div></td>
      </tr>`;
    api.displaySavedComments(table, 'src/a.ts', {preserveOpenEdit: false});

    restApi.get.mockResolvedValueOnce({id: 'draft_resolve', message: 'resolve me'});
    restApi.put.mockResolvedValueOnce({});
    const checkbox = table.querySelector('.ma-resolve-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    await Promise.resolve();
    await Promise.resolve();

    expect(restApi.put).toHaveBeenCalledWith(
      '/changes/123/revisions/5/drafts/draft_resolve',
      expect.objectContaining({unresolved: false})
    );
  });

  test('toggleLine updates selected lines and row styling', () => {
    const {api} = bootPlugin();
    api.clearSelectedLines();
    const table = document.createElement('table');
    table.innerHTML = `
      <tr>
        <td class="right lineNum" data-value="30"><button class="lineNumButton"></button></td>
        <td class="right"><div class="contentText">line</div></td>
      </tr>`;
    const row = table.querySelector('tr');
    const key = api.makeAnchorKey('src/a.ts', 'right', '30');
    api.toggleLine(key, 'right', row);
    expect(api.getSelectedLines()).toEqual([key]);
    expect(row.querySelector('td.right').classList.contains('multi-anchor-selected')).toBe(true);
    api.toggleLine(key, 'right', row);
    expect(api.getSelectedLines()).toEqual([]);
  });
});

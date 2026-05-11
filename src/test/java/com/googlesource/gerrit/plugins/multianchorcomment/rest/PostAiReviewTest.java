package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.PatchSet;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.api.GerritApi;
import com.google.gerrit.extensions.api.changes.ChangeApi;
import com.google.gerrit.extensions.api.changes.Changes;
import com.google.gerrit.extensions.api.changes.DraftApi;
import com.google.gerrit.extensions.api.changes.DraftInput;
import com.google.gerrit.extensions.api.changes.FileApi;
import com.google.gerrit.extensions.api.changes.RevisionApi;
import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.common.CommentInfo;
import com.google.gerrit.extensions.common.DiffInfo;
import com.google.gerrit.extensions.common.DiffInfo.ContentEntry;
import com.google.gerrit.extensions.common.FileInfo;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.server.change.RevisionResource;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewClient;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewClient.AiComment;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

public class PostAiReviewTest {

  @Mock private AiReviewClient aiClient;
  @Mock private MultiAnchorStorage storage;
  @Mock private GerritApi gApi;
  @Mock private Changes changes;
  @Mock private ChangeApi changeApi;
  @Mock private RevisionApi revisionApi;

  private PostAiReview postAiReview;

  @Before
  public void setUp() throws Exception {
    MockitoAnnotations.initMocks(this);
    postAiReview = new PostAiReview(aiClient, storage, gApi);

    // Set up the GerritApi call chain
    when(gApi.changes()).thenReturn(changes);
    when(changes.id(anyInt())).thenReturn(changeApi);
    when(changeApi.revision(anyInt())).thenReturn(revisionApi);

    // Default: no files (empty diff)
    when(revisionApi.files()).thenReturn(Collections.emptyMap());
  }

  private RevisionResource mockRevisionResource(String project, int changeId, int revisionId) {
    RevisionResource rsrc = mock(RevisionResource.class);
    Change change = mock(Change.class);
    PatchSet patchSet = mock(PatchSet.class);
    PatchSet.Id psId = mock(PatchSet.Id.class);

    when(rsrc.getChange()).thenReturn(change);
    when(rsrc.getPatchSet()).thenReturn(patchSet);
    when(rsrc.getProject()).thenReturn(Project.nameKey(project));
    when(change.getId()).thenReturn(Change.id(changeId));
    when(patchSet.id()).thenReturn(psId);
    when(psId.get()).thenReturn(revisionId);
    return rsrc;
  }

  private AiComment makeAiComment(String path, String message, Range... ranges) {
    AiComment c = new AiComment();
    c.path = path;
    c.message = message;
    c.allRanges = new ArrayList<>(Arrays.asList(ranges));
    c.primaryRange = ranges[0];
    return c;
  }

  private Range makeRange(int sl, int sc, int el, int ec) {
    Range r = new Range();
    r.startLine = sl;
    r.startCharacter = sc;
    r.endLine = el;
    r.endCharacter = ec;
    return r;
  }

  private DraftApi mockDraftApi(String draftId) throws Exception {
    DraftApi draftApi = mock(DraftApi.class);
    CommentInfo posted = new CommentInfo();
    posted.id = draftId;
    when(draftApi.get()).thenReturn(posted);
    when(revisionApi.createDraft(any(DraftInput.class))).thenReturn(draftApi);
    return draftApi;
  }

  private PostAiReview.Input makeInput(String prompt) {
    PostAiReview.Input input = new PostAiReview.Input();
    input.prompt = prompt;
    return input;
  }

  @Test
  public void testNoAiComments() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.emptyList());

    Response<String> resp = postAiReview.apply(rsrc, makeInput("review"));

    assertEquals("AI review posted: 0 comments", resp.value());
    verify(revisionApi, never()).createDraft(any());
    verify(storage, never()).saveRanges(any(), any(), anyInt(), any(), any());
  }

  @Test
  public void testSingleCommentSingleRange() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    AiComment comment = makeAiComment("Foo.java", "fix this", makeRange(1, 0, 3, 5));
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.singletonList(comment));

    Response<String> resp = postAiReview.apply(rsrc, makeInput("review"));

    assertEquals("AI review posted: 1 comments", resp.value());
    verify(revisionApi).createDraft(any(DraftInput.class));
    // Single range: allRanges.size() == 1, so storage.saveRanges should NOT be called
    verify(storage, never()).saveRanges(any(), any(), anyInt(), any(), any());
  }

  @Test
  public void testSingleCommentMultipleRanges() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 2);
    mockDraftApi("draft-1");

    AiComment comment = makeAiComment("Foo.java", "fix this",
        makeRange(1, 0, 3, 5),
        makeRange(10, 0, 12, 0),
        makeRange(20, 0, 22, 0));
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.singletonList(comment));

    postAiReview.apply(rsrc, makeInput("review"));

    // allRanges.size() > 1, so storage.saveRanges should be called with subList(1, 3)
    verify(storage).saveRanges(
        eq(Project.nameKey("proj")),
        eq(Change.id(1)),
        eq(2),
        eq("draft-1"),
        any());
  }

  @Test
  public void testMultipleComments() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);

    // Each createDraft call returns different draft IDs
    DraftApi draftApi1 = mock(DraftApi.class);
    DraftApi draftApi2 = mock(DraftApi.class);
    DraftApi draftApi3 = mock(DraftApi.class);
    CommentInfo c1 = new CommentInfo(); c1.id = "d1";
    CommentInfo c2 = new CommentInfo(); c2.id = "d2";
    CommentInfo c3 = new CommentInfo(); c3.id = "d3";
    when(draftApi1.get()).thenReturn(c1);
    when(draftApi2.get()).thenReturn(c2);
    when(draftApi3.get()).thenReturn(c3);
    when(revisionApi.createDraft(any(DraftInput.class)))
        .thenReturn(draftApi1, draftApi2, draftApi3);

    List<AiComment> comments = Arrays.asList(
        makeAiComment("A.java", "msg1", makeRange(1, 0, 2, 0)),
        makeAiComment("B.java", "msg2", makeRange(5, 0, 6, 0)),
        makeAiComment("C.java", "msg3", makeRange(10, 0, 11, 0)));
    when(aiClient.review(anyString(), anyString())).thenReturn(comments);

    Response<String> resp = postAiReview.apply(rsrc, makeInput("review"));

    assertEquals("AI review posted: 3 comments", resp.value());
    verify(revisionApi, times(3)).createDraft(any(DraftInput.class));
  }

  @Test
  public void testDraftCreationFailureContinuesLoop() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);

    // First createDraft throws, second succeeds
    DraftApi draftApi2 = mock(DraftApi.class);
    CommentInfo c2 = new CommentInfo(); c2.id = "d2";
    when(draftApi2.get()).thenReturn(c2);
    when(revisionApi.createDraft(any(DraftInput.class)))
        .thenThrow(new RuntimeException("creation failed"))
        .thenReturn(draftApi2);

    List<AiComment> comments = Arrays.asList(
        makeAiComment("A.java", "msg1", makeRange(1, 0, 2, 0)),
        makeAiComment("B.java", "msg2", makeRange(5, 0, 6, 0)));
    when(aiClient.review(anyString(), anyString())).thenReturn(comments);

    Response<String> resp = postAiReview.apply(rsrc, makeInput("review"));

    // Should still return 2 comments (the loop continues despite failure)
    assertEquals("AI review posted: 2 comments", resp.value());
  }

  @Test
  public void testStorageSaveFailureContinuesLoop() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);

    DraftApi draftApi1 = mock(DraftApi.class);
    DraftApi draftApi2 = mock(DraftApi.class);
    CommentInfo c1 = new CommentInfo(); c1.id = "d1";
    CommentInfo c2 = new CommentInfo(); c2.id = "d2";
    when(draftApi1.get()).thenReturn(c1);
    when(draftApi2.get()).thenReturn(c2);
    when(revisionApi.createDraft(any(DraftInput.class)))
        .thenReturn(draftApi1, draftApi2);

    // First saveRanges throws, second should still be attempted
    doThrow(new RuntimeException("storage failed"))
        .doNothing()
        .when(storage).saveRanges(any(), any(), anyInt(), any(), any());

    List<AiComment> comments = Arrays.asList(
        makeAiComment("A.java", "msg1", makeRange(1, 0, 2, 0), makeRange(3, 0, 4, 0)),
        makeAiComment("B.java", "msg2", makeRange(5, 0, 6, 0), makeRange(7, 0, 8, 0)));
    when(aiClient.review(anyString(), anyString())).thenReturn(comments);

    Response<String> resp = postAiReview.apply(rsrc, makeInput("review"));

    assertEquals("AI review posted: 2 comments", resp.value());
    verify(storage, times(2)).saveRanges(any(), any(), anyInt(), any(), any());
  }

  @Test
  public void testFetchDiffSkipsCommitMsg() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    Map<String, FileInfo> files = new LinkedHashMap<>();
    files.put("/COMMIT_MSG", new FileInfo());
    files.put("Foo.java", new FileInfo());
    when(revisionApi.files()).thenReturn(files);

    FileApi fileApi = mock(FileApi.class);
    DiffInfo diffInfo = new DiffInfo();
    ContentEntry entry = new ContentEntry();
    entry.ab = Arrays.asList("context line");
    diffInfo.content = Collections.singletonList(entry);
    when(fileApi.diff()).thenReturn(diffInfo);
    when(revisionApi.file("Foo.java")).thenReturn(fileApi);

    AiComment comment = makeAiComment("Foo.java", "fix this", makeRange(1, 0, 2, 0));
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.singletonList(comment));

    postAiReview.apply(rsrc, makeInput("review"));

    // Verify /COMMIT_MSG file was never requested
    verify(revisionApi, never()).file("/COMMIT_MSG");
    verify(revisionApi).file("Foo.java");
  }

  @Test
  public void testFetchDiffFormatsContextLines() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    Map<String, FileInfo> files = new LinkedHashMap<>();
    files.put("Foo.java", new FileInfo());
    when(revisionApi.files()).thenReturn(files);

    FileApi fileApi = mock(FileApi.class);
    DiffInfo diffInfo = new DiffInfo();
    ContentEntry entry = new ContentEntry();
    entry.ab = Arrays.asList("line1", "line2");
    diffInfo.content = Collections.singletonList(entry);
    when(fileApi.diff()).thenReturn(diffInfo);
    when(revisionApi.file("Foo.java")).thenReturn(fileApi);

    ArgumentCaptor<String> diffCaptor = ArgumentCaptor.forClass(String.class);
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.emptyList());

    postAiReview.apply(rsrc, makeInput("review"));

    verify(aiClient).review(diffCaptor.capture(), eq("review"));
    String diff = diffCaptor.getValue();
    assertTrue(diff.contains(" line1"));
    assertTrue(diff.contains(" line2"));
  }

  @Test
  public void testFetchDiffFormatsRemovedLines() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    Map<String, FileInfo> files = new LinkedHashMap<>();
    files.put("Foo.java", new FileInfo());
    when(revisionApi.files()).thenReturn(files);

    FileApi fileApi = mock(FileApi.class);
    DiffInfo diffInfo = new DiffInfo();
    ContentEntry entry = new ContentEntry();
    entry.a = Arrays.asList("removed line");
    diffInfo.content = Collections.singletonList(entry);
    when(fileApi.diff()).thenReturn(diffInfo);
    when(revisionApi.file("Foo.java")).thenReturn(fileApi);

    ArgumentCaptor<String> diffCaptor = ArgumentCaptor.forClass(String.class);
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.emptyList());

    postAiReview.apply(rsrc, makeInput("review"));

    verify(aiClient).review(diffCaptor.capture(), eq("review"));
    assertTrue(diffCaptor.getValue().contains("-removed line"));
  }

  @Test
  public void testFetchDiffFormatsAddedLines() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    Map<String, FileInfo> files = new LinkedHashMap<>();
    files.put("Foo.java", new FileInfo());
    when(revisionApi.files()).thenReturn(files);

    FileApi fileApi = mock(FileApi.class);
    DiffInfo diffInfo = new DiffInfo();
    ContentEntry entry = new ContentEntry();
    entry.b = Arrays.asList("added line");
    diffInfo.content = Collections.singletonList(entry);
    when(fileApi.diff()).thenReturn(diffInfo);
    when(revisionApi.file("Foo.java")).thenReturn(fileApi);

    ArgumentCaptor<String> diffCaptor = ArgumentCaptor.forClass(String.class);
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.emptyList());

    postAiReview.apply(rsrc, makeInput("review"));

    verify(aiClient).review(diffCaptor.capture(), eq("review"));
    assertTrue(diffCaptor.getValue().contains("+added line"));
  }

  @Test
  public void testDraftFieldsSetCorrectly() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    Range primaryRange = makeRange(5, 2, 8, 10);
    AiComment comment = makeAiComment("Bar.java", "improve this", primaryRange);
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.singletonList(comment));

    postAiReview.apply(rsrc, makeInput("review"));

    ArgumentCaptor<DraftInput> draftCaptor = ArgumentCaptor.forClass(DraftInput.class);
    verify(revisionApi).createDraft(draftCaptor.capture());

    DraftInput draft = draftCaptor.getValue();
    assertEquals("Bar.java", draft.path);
    assertEquals(8, (int) draft.line);
    assertSame(primaryRange, draft.range);
    assertTrue(draft.message.contains("improve this"));
    assertTrue(draft.unresolved);
  }

  @SuppressWarnings("unchecked")
  @Test
  public void testSubListExcludesPrimaryRange() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 2);
    mockDraftApi("draft-1");

    Range r1 = makeRange(1, 0, 3, 0);
    Range r2 = makeRange(10, 0, 12, 0);
    Range r3 = makeRange(20, 0, 22, 0);
    AiComment comment = makeAiComment("Foo.java", "fix", r1, r2, r3);
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.singletonList(comment));

    postAiReview.apply(rsrc, makeInput("review"));

    ArgumentCaptor<List<Range>> rangesCaptor = ArgumentCaptor.forClass(List.class);
    verify(storage).saveRanges(any(), any(), anyInt(), any(), rangesCaptor.capture());

    List<Range> saved = rangesCaptor.getValue();
    assertEquals(2, saved.size());
    // Primary range (r1) should be excluded, only r2 and r3 saved
    assertSame(r2, saved.get(0));
    assertSame(r3, saved.get(1));
  }

  @Test(expected = Exception.class)
  public void testAiClientExceptionPropagates() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    when(aiClient.review(anyString(), anyString())).thenThrow(new Exception("AI error"));

    postAiReview.apply(rsrc, makeInput("review"));
  }

  @Test
  public void testResponseMessageIncludesCount() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 1);
    mockDraftApi("draft-1");

    List<AiComment> comments = Arrays.asList(
        makeAiComment("A.java", "msg1", makeRange(1, 0, 2, 0)),
        makeAiComment("B.java", "msg2", makeRange(3, 0, 4, 0)));
    when(aiClient.review(anyString(), anyString())).thenReturn(comments);

    Response<String> resp = postAiReview.apply(rsrc, makeInput("review"));

    assertEquals("AI review posted: 2 comments", resp.value());
  }

  @Test
  public void testPostedDraftIdUsedForStorage() throws Exception {
    RevisionResource rsrc = mockRevisionResource("proj", 1, 3);
    mockDraftApi("specific-draft-id-xyz");

    AiComment comment = makeAiComment("Foo.java", "fix",
        makeRange(1, 0, 2, 0), makeRange(5, 0, 6, 0));
    when(aiClient.review(anyString(), anyString())).thenReturn(Collections.singletonList(comment));

    postAiReview.apply(rsrc, makeInput("review"));

    verify(storage).saveRanges(
        eq(Project.nameKey("proj")),
        eq(Change.id(1)),
        eq(3),
        eq("specific-draft-id-xyz"),
        any());
  }
}

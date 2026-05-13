package com.googlesource.gerrit.plugins.multianchorcomment;

import static com.google.common.truth.Truth.assertThat;

import com.google.common.reflect.TypeToken;
import com.google.gerrit.acceptance.LightweightPluginDaemonTest;
import com.google.gerrit.acceptance.PushOneCommit;
import com.google.gerrit.acceptance.RestResponse;
import com.google.gerrit.acceptance.TestPlugin;
import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.common.CommentInfo;
import com.google.gerrit.json.OutputFormat;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewClient;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewConfig;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.PostAiReview;
import com.google.inject.AbstractModule;
import com.google.inject.Inject;
import com.google.inject.util.Modules;
import java.io.Reader;
import java.lang.reflect.Type;
import java.util.List;
import org.junit.Test;

@TestPlugin(
    name = "multianchor_comment",
    sysModule = "com.googlesource.gerrit.plugins.multianchorcomment.MultiAnchorAiReviewIT$TestPluginModule"
)
public class MultiAnchorAiReviewIT extends LightweightPluginDaemonTest {

  public static class TestPluginModule extends AbstractModule {
    @Override
    protected void configure() {
      install(
          Modules.override(new PluginModule())
              .with(new AbstractModule() {
                @Override
                protected void configure() {
                  bind(AiReviewClient.class).to(FakeAiReviewClient.class);
                }
              }));
    }
  }

  public static class FakeAiReviewClient extends AiReviewClient {
    private static volatile List<AiComment> comments = List.of();

    @Inject
    FakeAiReviewClient(AiReviewConfig config) {
      super(config);
    }

    @Override
    public List<AiComment> review(String diff, String userPrompt) {
      return comments;
    }

    static void setComments(List<AiComment> next) {
      comments = next;
    }
  }

  @Test
  public void postAiReviewCreatesDraftAndStoresAdditionalRanges() throws Exception {
    ChangeContext ctx = createChangeContext();

    AiReviewClient.AiComment comment = new AiReviewClient.AiComment();
    comment.path = "a.txt";
    comment.message = "Issue across two ranges";
    comment.allRanges = List.of(
        range(1, 0, 1, 1),
        range(1, 2, 1, 3));
    comment.primaryRange = comment.allRanges.get(0);

    FakeAiReviewClient.setComments(List.of(comment));

    PostAiReview.Input input = new PostAiReview.Input();
    input.prompt = "focus";

    RestResponse response =
        adminRestSession.post(
            "/changes/" + ctx.changeId + "/revisions/" + ctx.patchSet + "/ai-review", input);
    response.assertOK();

    List<CommentInfo> drafts =
        gApi.changes().id(ctx.changeId).revision(ctx.patchSet).draftsAsList();
    assertThat(drafts).hasSize(1);

    String commentId = drafts.get(0).id;
    RestResponse getResponse =
        adminRestSession.get(
            "/changes/" + ctx.changeId + "/multianchor-ranges/" + ctx.patchSet + "~" + commentId);
    getResponse.assertOK();

    List<Range> stored = parseJson(getResponse, new TypeToken<List<Range>>() {}.getType());
    assertThat(stored).hasSize(1);
  }

  @Test
  public void postAiReviewWithNoCommentsCreatesNoDrafts() throws Exception {
    ChangeContext ctx = createChangeContext();

    FakeAiReviewClient.setComments(List.of());

    PostAiReview.Input input = new PostAiReview.Input();
    input.prompt = "none";

    RestResponse response =
        adminRestSession.post(
            "/changes/" + ctx.changeId + "/revisions/" + ctx.patchSet + "/ai-review", input);
    response.assertOK();

    List<CommentInfo> drafts =
        gApi.changes().id(ctx.changeId).revision(ctx.patchSet).draftsAsList();
    assertThat(drafts).isEmpty();
  }

  @Test
  public void postAiReviewWithSingleRangeDoesNotStoreExtras() throws Exception {
    ChangeContext ctx = createChangeContext();

    AiReviewClient.AiComment comment = new AiReviewClient.AiComment();
    comment.path = "a.txt";
    comment.message = "Single range";
    comment.allRanges = List.of(range(1, 0, 1, 1));
    comment.primaryRange = comment.allRanges.get(0);

    FakeAiReviewClient.setComments(List.of(comment));

    PostAiReview.Input input = new PostAiReview.Input();
    input.prompt = null;

    adminRestSession
        .post("/changes/" + ctx.changeId + "/revisions/" + ctx.patchSet + "/ai-review", input)
        .assertOK();

    List<CommentInfo> drafts =
        gApi.changes().id(ctx.changeId).revision(ctx.patchSet).draftsAsList();
    assertThat(drafts).hasSize(1);

    String commentId = drafts.get(0).id;
    RestResponse getResponse =
        adminRestSession.get(
            "/changes/" + ctx.changeId + "/multianchor-ranges/" + ctx.patchSet + "~" + commentId);
    getResponse.assertOK();

    List<Range> stored = parseJson(getResponse, new TypeToken<List<Range>>() {}.getType());
    assertThat(stored).isEmpty();
  }

  private ChangeContext createChangeContext() throws Exception {
    PushOneCommit.Result result = createChange();
    int changeNumber = result.getChange().change().getId().get();
    int patchSet = result.getPatchSetId().get();
    return new ChangeContext(String.valueOf(changeNumber), patchSet);
  }

  private Range range(int startLine, int startCharacter, int endLine, int endCharacter) {
    Range r = new Range();
    r.startLine = startLine;
    r.startCharacter = startCharacter;
    r.endLine = endLine;
    r.endCharacter = endCharacter;
    return r;
  }

  private <T> T parseJson(RestResponse response, Type type) throws Exception {
    try (Reader reader = response.getReader()) {
      return OutputFormat.JSON_COMPACT.newGson().fromJson(reader, type);
    }
  }

  private static class ChangeContext {
    private final String changeId;
    private final int patchSet;

    private ChangeContext(String changeId, int patchSet) {
      this.changeId = changeId;
      this.patchSet = patchSet;
    }
  }
}

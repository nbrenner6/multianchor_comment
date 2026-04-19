package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.extensions.api.GerritApi;
import com.google.gerrit.extensions.api.changes.DraftInput;
import com.google.gerrit.extensions.common.CommentInfo;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestModifyView;
import com.google.gerrit.server.change.RevisionResource;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewClient;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.util.List;

@Singleton
public class PostAiReview implements RestModifyView<RevisionResource, PostAiReview.Input> {

  public static class Input {
    public String prompt;
  }

  private final AiReviewClient aiClient;
  private final MultiAnchorStorage storage;
  private final GerritApi gApi;

  @Inject
  PostAiReview(AiReviewClient aiClient, MultiAnchorStorage storage, GerritApi gApi) {
    this.aiClient = aiClient;
    this.storage  = storage;
    this.gApi     = gApi;
  }

  @Override
  public Response<String> apply(RevisionResource rsrc, Input input) throws Exception {
    int changeId   = rsrc.getChange().getId().get();
    int revisionId = rsrc.getPatchSet().id().get();

    // build the diff to send to the AI
    String diff = fetchDiff(changeId, revisionId);

    // call the AI
    List<AiReviewClient.AiComment> aiComments = aiClient.review(diff, input.prompt);

    // post each AI comment as a draft + save extra ranges
    for (AiReviewClient.AiComment aiComment : aiComments) {
      try {
        DraftInput draft  = new DraftInput();
        draft.path        = aiComment.path;
        draft.line        = aiComment.primaryRange.endLine;
        draft.range       = aiComment.primaryRange;
        draft.message     = "🤖 AI Review:\n\n" + aiComment.message;
        draft.unresolved  = true;

        System.err.println("Attempting to post draft for path: " + aiComment.path
            + " line: " + aiComment.primaryRange.endLine);

        CommentInfo posted = gApi.changes()
            .id(changeId)
            .revision(revisionId)
            .createDraft(draft)
            .get();

        System.err.println("Posted draft with id: " + posted.id);

        if (aiComment.allRanges.size() > 1) {
          storage.saveRanges(
              rsrc.getProject(),
              rsrc.getChange().getId(),
              posted.id,
              aiComment.allRanges.subList(1, aiComment.allRanges.size())
          );
        }
      } catch (Exception e) {
        System.err.println("Failed to post draft: " + e.getMessage());
        e.printStackTrace();
      }
    }

    return Response.ok("AI review posted: " + aiComments.size() + " comments");
  }

  private String fetchDiff(int changeId, int revisionId) throws Exception {
    var files = gApi.changes().id(changeId).revision(revisionId).files();
    StringBuilder sb = new StringBuilder();
    for (String path : files.keySet()) {
      if (path.equals("/COMMIT_MSG")) continue;
      var diff = gApi.changes().id(changeId).revision(revisionId).file(path).diff();
      sb.append("### ").append(path).append("\n");
      diff.content.forEach(chunk -> {
        if (chunk.ab != null) chunk.ab.forEach(l -> sb.append(" ").append(l).append("\n"));
        if (chunk.a  != null) chunk.a .forEach(l -> sb.append("-").append(l).append("\n"));
        if (chunk.b  != null) chunk.b .forEach(l -> sb.append("+").append(l).append("\n"));
      });
    }
    return sb.toString();
  }
}

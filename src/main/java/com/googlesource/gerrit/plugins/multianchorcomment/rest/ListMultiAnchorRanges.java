package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.extensions.client.Comment.Range;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestReadView;
import com.google.gerrit.server.change.ChangeResource;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import com.googlesource.gerrit.plugins.multianchorcomment.storage.MultiAnchorStorage;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * REST endpoint for listing all multi-anchor ranges for a change.
 *
 * <p>GET /changes/{changeId}/multianchor-ranges
 *
 * <p>Returns a map of comment UUIDs to their additional ranges. This allows the frontend to fetch
 * all multi-anchor data for a change in a single request.
 *
 * <p>Example response:
 *
 * <pre>{@code
 * {
 *   "comment-uuid-123": [
 *     {"startLine": 50, "startCharacter": 0, "endLine": 52, "endCharacter": 15}
 *   ],
 *   "comment-uuid-456": [
 *     {"startLine": 100, "startCharacter": 0, "endLine": 105, "endCharacter": 20},
 *     {"startLine": 200, "startCharacter": 0, "endLine": 210, "endCharacter": 0}
 *   ]
 * }
 * }</pre>
 */
@Singleton
public class ListMultiAnchorRanges implements RestReadView<ChangeResource> {

  private final MultiAnchorStorage storage;

  @Inject
  ListMultiAnchorRanges(MultiAnchorStorage storage) {
    this.storage = storage;
  }

  @Override
  public Response<Map<String, List<Range>>> apply(ChangeResource rsrc) throws IOException {
    Map<String, List<Range>> ranges =
        storage.getRanges(rsrc.getProject(), rsrc.getChange().getId());
    return Response.ok(ranges);
  }
}
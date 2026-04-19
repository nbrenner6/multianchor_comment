package com.googlesource.gerrit.plugins.multianchorcomment;

import static com.google.gerrit.server.change.ChangeResource.CHANGE_KIND;
import static com.google.gerrit.server.change.RevisionResource.REVISION_KIND;
import static com.googlesource.gerrit.plugins.multianchorcomment.rest.MultiAnchorRangesResource.MULTIANCHOR_RANGES_KIND;

import com.google.gerrit.extensions.registration.DynamicMap;
import com.google.gerrit.extensions.registration.DynamicSet;
import com.google.gerrit.extensions.restapi.RestApiModule;
import com.google.gerrit.extensions.webui.JavaScriptPlugin;
import com.google.gerrit.extensions.webui.WebUiPlugin;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewClient;
import com.googlesource.gerrit.plugins.multianchorcomment.ai.AiReviewConfig;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.DeleteMultiAnchorRanges;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.GetMultiAnchorRanges;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.MultiAnchorRangesCollection;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.PostAiReview;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.SaveMultiAnchorRanges;

/**
 * Guice module for the multi-anchor comment plugin.
 *
 * <p>Registers:
 *
 * <ul>
 *   <li>JavaScript plugin for frontend UI
 *   <li>REST API endpoints for storing additional anchor ranges
 * </ul>
 *
 * <p>REST API endpoints:
 *
 * <ul>
 *   <li>GET /changes/{id}/multianchor-ranges - List all ranges for a change
 *   <li>GET /changes/{id}/multianchor-ranges/{uuid} - Get ranges for a comment
 *   <li>PUT /changes/{id}/multianchor-ranges/{uuid} - Save ranges for a comment
 *   <li>DELETE /changes/{id}/multianchor-ranges/{uuid} - Delete ranges for a comment
 * </ul>
 */

public class PluginModule extends RestApiModule {
  @Override
  protected void configure() {
    // Frontend
    DynamicSet.bind(binder(), WebUiPlugin.class)
        .toInstance(new JavaScriptPlugin("multianchor_comment.js"));

    // Existing multi-anchor range endpoints
    DynamicMap.mapOf(binder(), MULTIANCHOR_RANGES_KIND);
    child(CHANGE_KIND, "multianchor-ranges").to(MultiAnchorRangesCollection.class);
    get(MULTIANCHOR_RANGES_KIND).to(GetMultiAnchorRanges.class);
    put(MULTIANCHOR_RANGES_KIND).to(SaveMultiAnchorRanges.class);
    delete(MULTIANCHOR_RANGES_KIND).to(DeleteMultiAnchorRanges.class);

    // AI review config and client — no annotation bindings needed
    bind(AiReviewConfig.class);
    bind(AiReviewClient.class);

    // AI review endpoint: POST /changes/{id}/revisions/{id}/ai-review
    post(REVISION_KIND, "ai-review").to(PostAiReview.class);
  }
}

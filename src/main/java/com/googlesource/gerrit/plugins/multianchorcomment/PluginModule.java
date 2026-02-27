package com.googlesource.gerrit.plugins.multianchorcomment;

import static com.google.gerrit.server.change.ChangeResource.CHANGE_KIND;
import static com.googlesource.gerrit.plugins.multianchorcomment.rest.MultiAnchorRangesResource.MULTIANCHOR_RANGES_KIND;

import com.google.gerrit.extensions.registration.DynamicMap;
import com.google.gerrit.extensions.registration.DynamicSet;
import com.google.gerrit.extensions.restapi.RestApiModule;
import com.google.gerrit.extensions.webui.JavaScriptPlugin;
import com.google.gerrit.extensions.webui.WebUiPlugin;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.DeleteMultiAnchorRanges;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.GetMultiAnchorRanges;
import com.googlesource.gerrit.plugins.multianchorcomment.rest.MultiAnchorRangesCollection;
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
    // Register the JavaScript plugin for frontend UI
    DynamicSet.bind(binder(), WebUiPlugin.class)
        .toInstance(new JavaScriptPlugin("multianchor_comment.js"));

    // Register the dynamic map for our resource kind (required for REST routing)
    DynamicMap.mapOf(binder(), MULTIANCHOR_RANGES_KIND);

    // Register the collection as a child of changes
    // This enables: /changes/{changeId}/multianchor-ranges
    child(CHANGE_KIND, "multianchor-ranges").to(MultiAnchorRangesCollection.class);

    // Register CRUD operations for individual comment ranges
    // These enable: /changes/{changeId}/multianchor-ranges/{commentUuid}
    get(MULTIANCHOR_RANGES_KIND).to(GetMultiAnchorRanges.class);
    put(MULTIANCHOR_RANGES_KIND).to(SaveMultiAnchorRanges.class);
    delete(MULTIANCHOR_RANGES_KIND).to(DeleteMultiAnchorRanges.class);
  }
}

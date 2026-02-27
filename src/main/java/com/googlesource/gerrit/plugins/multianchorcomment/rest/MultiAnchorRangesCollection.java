package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.extensions.registration.DynamicMap;
import com.google.gerrit.extensions.restapi.ChildCollection;
import com.google.gerrit.extensions.restapi.IdString;
import com.google.gerrit.extensions.restapi.ResourceNotFoundException;
import com.google.gerrit.extensions.restapi.RestView;
import com.google.gerrit.server.change.ChangeResource;
import com.google.inject.Inject;
import com.google.inject.Provider;
import com.google.inject.Singleton;

/**
 * Collection for multi-anchor ranges, attached to changes.
 *
 * <p>Handles URL pattern: /changes/{changeId}/multianchor-ranges/{commentUuid}
 *
 * <p>This collection provides access to additional anchor ranges stored by the plugin. Each comment
 * (identified by UUID) can have multiple additional ranges beyond the primary range stored in
 * Gerrit core.
 */
@Singleton
public class MultiAnchorRangesCollection
    implements ChildCollection<ChangeResource, MultiAnchorRangesResource> {

  private final DynamicMap<RestView<MultiAnchorRangesResource>> views;
  private final Provider<ListMultiAnchorRanges> list;

  @Inject
  MultiAnchorRangesCollection(
      DynamicMap<RestView<MultiAnchorRangesResource>> views,
      Provider<ListMultiAnchorRanges> list) {
    this.views = views;
    this.list = list;
  }

  /**
   * Returns the view for listing all multi-anchor ranges for a change.
   *
   * <p>Called when GET /changes/{changeId}/multianchor-ranges is requested (without a comment UUID).
   */
  @Override
  public RestView<ChangeResource> list() {
    return list.get();
  }

  /**
   * Parses a comment UUID and creates a resource for it.
   *
   * <p>Called when a specific comment UUID is provided in the URL, e.g., GET/PUT/DELETE
   * /changes/{changeId}/multianchor-ranges/{commentUuid}
   *
   * @param parent the change resource (provides project and change ID context)
   * @param id the comment UUID from the URL
   * @return a resource representing the ranges for that comment
   */
  @Override
  public MultiAnchorRangesResource parse(ChangeResource parent, IdString id)
      throws ResourceNotFoundException {
    String commentUuid = id.get();
    if (commentUuid == null || commentUuid.isEmpty()) {
      throw new ResourceNotFoundException("Comment UUID is required");
    }
    return new MultiAnchorRangesResource(
        parent.getProject(), parent.getChange().getId(), commentUuid);
  }

  /** Returns the dynamic map of views registered for this resource type. */
  @Override
  public DynamicMap<RestView<MultiAnchorRangesResource>> views() {
    return views;
  }
}
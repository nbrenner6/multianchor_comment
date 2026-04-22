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
 * <p>Handles URL pattern: /changes/{changeId}/multianchor-ranges/{patchSet}~{commentUuid}
 *
 * <p>This collection provides access to additional anchor ranges stored by the plugin. Each comment
 * (identified by UUID) can have multiple additional ranges beyond the primary range stored in
 * Gerrit core. Ranges are scoped to a specific patchset so that line numbers correspond to the
 * correct version of the file.
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
   * <p>Called when GET /changes/{changeId}/multianchor-ranges is requested (without a composite ID).
   */
  @Override
  public RestView<ChangeResource> list() {
    return list.get();
  }

  /**
   * Parses a composite ID ({patchSet}~{commentUuid}) and creates a resource for it.
   *
   * <p>Called when a specific composite ID is provided in the URL, e.g., GET/PUT/DELETE
   * /changes/{changeId}/multianchor-ranges/{patchSet}~{commentUuid}
   *
   * @param parent the change resource (provides project and change ID context)
   * @param id the composite ID ({patchSet}~{commentUuid}) from the URL
   * @return a resource representing the ranges for that comment on that patchset
   */
  @Override
  public MultiAnchorRangesResource parse(ChangeResource parent, IdString id)
      throws ResourceNotFoundException {
    String compositeId = id.get();
    if (compositeId == null || compositeId.isEmpty()) {
      throw new ResourceNotFoundException("Composite ID ({patchSet}~{commentUuid}) is required");
    }

    int separatorIndex = compositeId.indexOf('~');
    if (separatorIndex <= 0 || separatorIndex >= compositeId.length() - 1) {
      throw new ResourceNotFoundException(
          "Invalid ID format. Expected {patchSet}~{commentUuid}, got: " + compositeId);
    }

    int patchSet;
    try {
      patchSet = Integer.parseInt(compositeId.substring(0, separatorIndex));
    } catch (NumberFormatException e) {
      throw new ResourceNotFoundException(
          "Invalid patchset number in ID: " + compositeId);
    }
    if (patchSet <= 0) {
      throw new ResourceNotFoundException(
          "Patchset number must be positive, got: " + patchSet);
    }

    String commentUuid = compositeId.substring(separatorIndex + 1);
    return new MultiAnchorRangesResource(
        parent.getProject(), parent.getChange().getId(), patchSet, commentUuid);
  }

  /** Returns the dynamic map of views registered for this resource type. */
  @Override
  public DynamicMap<RestView<MultiAnchorRangesResource>> views() {
    return views;
  }
}
package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.restapi.RestResource;
import com.google.gerrit.extensions.restapi.RestView;
import com.google.inject.TypeLiteral;

/**
 * REST resource representing the additional ranges for a specific comment on a specific patchset.
 *
 * <p>This resource is identified by the composite ID {patchSet}~{commentUuid} and provides access
 * to the additional anchor ranges stored by the plugin for that comment. Ranges are scoped to a
 * patchset so that line numbers correspond to the correct version of the file.
 *
 * <p>URL pattern: /changes/{changeId}/multianchor-ranges/{patchSet}~{commentUuid}
 */
public class MultiAnchorRangesResource implements RestResource {

  /** Type literal for dynamic view dispatch. */
  public static final TypeLiteral<RestView<MultiAnchorRangesResource>> MULTIANCHOR_RANGES_KIND =
      new TypeLiteral<>() {};

  private final Project.NameKey project;
  private final Change.Id changeId;
  private final int patchSet;
  private final String commentUuid;

  public MultiAnchorRangesResource(
      Project.NameKey project, Change.Id changeId, int patchSet, String commentUuid) {
    this.project = project;
    this.changeId = changeId;
    this.patchSet = patchSet;
    this.commentUuid = commentUuid;
  }

  /** Returns the project containing the change. */
  public Project.NameKey getProject() {
    return project;
  }

  /** Returns the change ID. */
  public Change.Id getChangeId() {
    return changeId;
  }

  /** Returns the patchset number this resource is scoped to. */
  public int getPatchSet() {
    return patchSet;
  }

  /** Returns the comment UUID this resource represents. */
  public String getCommentUuid() {
    return commentUuid;
  }
}
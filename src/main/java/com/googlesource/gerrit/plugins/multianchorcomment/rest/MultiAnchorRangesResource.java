package com.googlesource.gerrit.plugins.multianchorcomment.rest;

import com.google.gerrit.entities.Change;
import com.google.gerrit.entities.Project;
import com.google.gerrit.extensions.restapi.RestResource;
import com.google.gerrit.extensions.restapi.RestView;
import com.google.inject.TypeLiteral;

/**
 * REST resource representing the additional ranges for a specific comment.
 *
 * <p>This resource is identified by the comment UUID and provides access to the additional anchor
 * ranges stored by the plugin for that comment.
 *
 * <p>URL pattern: /changes/{changeId}/multianchor-ranges/{commentUuid}
 */
public class MultiAnchorRangesResource implements RestResource {

  /** Type literal for dynamic view dispatch. */
  public static final TypeLiteral<RestView<MultiAnchorRangesResource>> MULTIANCHOR_RANGES_KIND =
      new TypeLiteral<>() {};

  private final Project.NameKey project;
  private final Change.Id changeId;
  private final String commentUuid;

  public MultiAnchorRangesResource(Project.NameKey project, Change.Id changeId, String commentUuid) {
    this.project = project;
    this.changeId = changeId;
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

  /** Returns the comment UUID this resource represents. */
  public String getCommentUuid() {
    return commentUuid;
  }
}
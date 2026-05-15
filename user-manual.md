# Multi-Anchored Comments in Gerrit User’s Manual

## 0\. Contents

1.  Introduction
2.  Getting Started
3.  Reviewer Documentation
4.  Author/Change Owner Documentation
5.  Second Reviewer Documentation
6.  Administrator Documentation

## 1\. Introduction

### Purpose of the Manual

This manual serves to explain the functionality of the multi-anchored comments (MACs) plugin for Gerrit. It documents how users interact with and use the plugin. The goal is to help each potential user role understand how to use the new capabilities to support code review workflows.

### Overview of the Plugin

The plugin is designed to closely align with the native Gerrit functionality while extending its support to allow comments that are attached to multiple, non-adjacent code locations.

The MAC plugin is a lightweight extension to the existing Gerrit functionality that adds support for:

- MACs within a single file
- Cross-file comments across multiple changed lines
- Editing, publishing, resolving, and deleting MACs
- Patchset-aware MAC persistence

### Intended Audience

This manual provides documentation for all known user-types of both native Gerrit and the MAC plugin. This includes:

- Code reviewers
- Authors/change owners
- Second reviewers
- Administrators/Gerrit maintainers
- Quality Assurance engineers
- AI review users

### Terminology

This manual uses a collection of terms that are important to understanding the full documentation and functionality of the plugin. These terms include:

- **Anchor:** A selected line or range of (adjacent) lines attached to a comment
- **Multi-anchored comment (MAC):** A single comment associated with multiple non-adjacent lines (i.e. _anchors_).
- **Cross-file comment:** A multi-anchored comment whose anchors span more than one file
- **AI review:** A plugin feature that generates draft review comments automatically via connection to an LLM API key
- **Draft comment:** a comment that has been created but not yet published
- **Patchset:** A specific revision of a Gerrit change
- **Native Gerrit comment:** A standard single-anchor Gerrit comment.

##   
2\. Getting Started

### Basic Requirements

Since the plugin adds to the existing functionality of Gerrit, it is important that the user already has native Gerrit running in order to fully utilize the extension. This includes:

- Access to a Gerrit instance with the plugin installed
- Permission to view and review changes
- A change or patchset open in Gerrit
- At least one modified file available in the diff view
- AI review API key\*\*

The README explains that the plugin is placed inside Gerrit’s /plugins directory, built with Bazel, copied into the Gerrit site’s plugin directory, and verified through the Gerrit admin plugins page.

_\*\* In order to use the AI review functionality, the system must first be configured with the necessary AI provider key and settings by an administrator \*\*_

### Opening the Plugin in Gerrit

For the ordinary user, the workflow for accessing the plugin outside of the environment setup outlined in the README is as follows:

1.  Open Gerrit
2.  Open a change
3.  Click a file to enter the diff view
4.  Use muli-line selection, cross-file selection, or the AI review button

### Normal Workflow

The README outlines the basic usage patterns. For the majority of reviews, the workflow would operate as follows:

1.  Select one or more relevant lines by clicking on them, holding cmd/ctrl for MACs
2.  Press c to create a comment
3.  Write the body of the comment
4.  Save, publish, resolve, or delete the comment as applicable

## 3\. Reviewer Documentation

### Creating a MAC in a Single File

**Use case:** one review issue applies to multiple lines all existing in the same, single file.

**Steps:**

1.  Open a change in Gerrit
2.  Open the diff view of the relevant file
3.  Click the first line related to the issue
4.  Hold cmd/ctrl
5.  Select desired additional related lines, including ones that are not adjacent to the already selected anchors
6.  Press c to open comment interface
7.  Confirm that the draft box properly displays the selected lines

**Expected result:** A single comment is attached to all of the selected lines and is displayed when viewing the file in which the lines exist.

### Creating a Cross-File Comment

**Use case:** one issue spans multiple files.

**Steps:**

1.  Open the first relevant file in the diff
2.  Select the relevant lines or lines
3.  Navigate to another changed file
4.  Select additional related lines in the new file
5.  Press c to draft a comment
6.  Confirm that the comment draft correctly identifies all of the selected lines, and the file that each belongs to
7.  Write one comment body to reference all of the selected lines
8.  Save or publish the comment

**Expected result:** the comment appears when viewing any file that contains one of its anchors.

### Running an AI Review

**Use case:** you want automated help finding possible issues in code pushed to Gerrit, creating draft comments that you can edit before publishing.

**Steps:**

1.  Open a Gerrit change
2.  Open a file in the diff view
3.  Click the **AI Review** button in the bottom-right corner of the page
4.  If desired, provide the AI review with a prompt to guide its commenting process
5.  Wait for draft comments to appear
6.  Review each generated comment
7.  Publish the comments you agree with

**Expected result:** AI-generated comments appear throughout the change.

## 4\. Author/Change Owner Documentation

### Responding to a MAC (single- or multi-file)

**Use case:** a reviewer leaves one comment attached to multiple lines

**Steps:**

1.  Open the comment
2.  Inspect every highlighted anchor, visiting all related files, if applicable
3.  Determine the issue, updating relevant code
4.  Reply to the comment explaining the changes made to address the comment
5.  Resolve the comment if the issue is fully addressed, otherwise leave it open for confirmation by a reviewer

**Expected result:** if the comment is resolved, the MAC should no longer be visible, and the lines associated with it should no longer be highlighted (unless they are highlighted by another comment that has not been resolved).

### Responding to AI-Generated Comments

**Use case:** AI-generated draft comments are published or shared during review

**Steps:**

1.  Read the AI-generated comment carefully
2.  Check whether each selected anchor is relevant
3.  Decide whether the comment identifies a real issue
    1.  AI-generated comments should be handled like human-written comments but with extra attention to false positives, as the model leans in the direction of over-commenting rather than under-commenting
4.  Fix the code, ask for clarification, or explain why no change is necessary

**Expected result:** if the comment is resolved, the MAC should no longer be visible, and the lines associated with it should no longer be highlighted (unless they are highlighted by another comment that has not been resolved).

## 5\. Second Reviewer Documentation

### Reviewing Comments Created by Another User

**Use case:** another reviewer has already created comments or AI drafts

**Steps:**

1.  Open the Gerrit change
2.  Review existing comments and drafts
3.  Inspect every anchor attached to each multi-anchored comment
4.  Edit unclear draft comments, remove duplicate or unnecessary comments
5.  Resolve comments that have already been addressed
6.  Finalize the remaining review comments

**Expected results:** a subset of polished, doubly-reviewed MACs should be present

## 6\. Administrator/Maintainer Documentation

### Installing the Plugin in a Development Gerrit Site

**Use case:** setting up a development environment for work related to Gerrit or the MAC plugin specifically.

**Steps:**

1.  Clone Gerrit into a local repository
2.  Change into the Gerrit directory
3.  Build Gerrit with:

bazel build //:gerrit

1.  Initialize a development Gerrit site:

java -jar bazel-bin/gerrit.war init --batch --dev -d /tmp/gerrit-site

1.  Build the plugin:

bazel build //plugins/multianchor_comment: multianchor_comment

1.  Copy the plugin jar to the Gerrit /plugins folder:

sudo cp bazel-bin/plugins/multianchor_comment /multianchor_comment.jar /tmp/gerrit-site/plugins/

1.  Start Gerrit:

java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site

1.  Open the locally-hosted Gerrit instance at http://localhost:8080

**Expected result:** the plugin should be activated, verifiable at http://localhost:8080/admin/plugins

### Adding a Repository for Testing

**Use case:** a local repository needs to be added to Gerrit

**Steps:**

1.  Generate an SSH key:

ssh-keygen -t ed25519 -f ~/.ssh/id_gerrit -C "gerrit-local"

1.  Start the SSH agent and add the key:

eval "$(ssh-agent -s)"

ssh-add ~/.ssh/id_gerrit

1.  Add a localhost Gerrit SSH config
2.  Add the public key to Gerrit under **Settings->SSH keys**
3.  Verify the Gerrit SSH connection

ssh -p 29418 localhost gerrit version

1.  Create a Gerrit project
2.  Add Gerrit as a Git remote
3.  Push a change to: refs/for/master

**Expected result:** the change (and repository) should appear in the Gerrit UI.

### Configuring AI Review

**Use case:** you want to enable the AI review functionality for your Gerrit development site, _and you already have the following prerequisites:_

- A running locally-hosted Gerrit site
- The plugin jar enabled
- An Anthropic API key

**Steps:**

1.  Navigate to gerrit.config, and add:

\[plugin "multianchor_comment"\]

aiApiUrl = https://api.anthropic.com/v1/messages

aiModel = claude-haiku-4-5-20251001

1.  If secure.config doesn’t exist, create it:

touch /tmp/gerrit-site/etc/secure.config

chmod 600 /tmp/gerrit-site/etc/secure.config

nano /tmp/gerrit-site/etc/secure.config

1.  Navigate to secure.config and add your Anthropic API key:

\[plugin "multianchor_comment"\]

aiApiKey = sk-ant-your-key-here

1.  Stop any running Gerrit processes, then restart Gerrit:

java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site

**Expected result:** in the diff view of a change, the AI Review button appears in the bottom-right corner

### Running Tests

**Use case:** tests should be run, including backend unit tests, integration tests, e2e tests, or Jest frontend tests, especially after making changes that affect any of the following:

- Comment persistence
- REST endpoints
- AI review behavior
- Frontend selection logic
- Cross-file comment rendering

**Steps:**

1.  Run the plugin test command:

bazel test //plugins/multianchor_comment:multianchor_ comment_tests

**Expected result:** all tests should pass
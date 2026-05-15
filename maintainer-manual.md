# Maintainer's Manual: Multi-Anchored Comments in Gerrit

**CS 5150: Software Engineering (Spring 2026)**

Team 6: Nick Brenner (nlb74), Evan Zhu (ejz26), Dylan Kenniff (dmk332), James Tu (jt737), Javohir Abdurazzakov (ja688)

**Repository:** [https://github.com/nbrenner6/multianchor_comment](https://github.com/nbrenner6/multianchor_comment)

---

## Table of Contents

1. [Introduction & System Overview](#1-introduction--system-overview)
2. [Requirements Analysis & Specification](#2-requirements-analysis--specification)
3. [Architectural Diagrams](#3-architectural-diagrams)
4. [Class Diagrams](#4-class-diagrams)
5. [Final User Interface Designs](#5-final-user-interface-designs)
6. [Developer Environment Setup & Deployment Procedure](#6-developer-environment-setup--deployment-procedure)
7. [Style Guide & Developer Workflow](#7-style-guide--developer-workflow)
8. [Test Plan & Results](#8-test-plan--results)
9. [Known Issues & Future Work](#9-known-issues--future-work)

---

## 1. Introduction & System Overview

This document is intended for future developers who will maintain, extend, or debug the Multi-Anchored Comments plugin for Gerrit. It covers the system’s design, architecture, testing infrastructure, deployment procedures, and developer workflow conventions.

The plugin delivers three core capabilities:

- **Multi-anchored commenting:** Reviewers can select any number of non-adjacent lines (within a single file or across multiple files) and attach a single comment to all of them. This addresses a long-standing gap where reviewers must either duplicate their feedback across multiple single-line comments or write a general comment with manual line references.

- **AI-powered code review (RobotComments):** A built-in AI review feature sends the commit diff to an LLM (Anthropic's Claude) and receives back multi-anchored comments identifying bugs, code quality issues, and repeated patterns. These are stored as editable draft entities, allowing reviewers to use them as a starting point and iterate before finalizing.

- **Cross-patchset comment persistence:** Multi-anchor ranges are scoped to the patchset they were created on, so line numbers always refer to the correct file version. When the URL uses an implicit "current" revision, the plugin resolves it to the real patchset number before saving or loading data.

The plugin is implemented as a Gerrit plugin consisting of a JavaScript frontend that integrates with Gerrit's PolyGerrit UI via the Shadow DOM, and a Java backend that registers custom REST API endpoints via Guice and persists additional anchor metadata in Git refs following NoteDB conventions.

---

## 2. Requirements Analysis & Specification

The following requirements represent the final, delivered state of the plugin as of the end of Sprint 4. Requirements 1–5 were originally drafted in Sprint 1 and refined through subsequent sprints; Requirements 6–8 were added in Sprint 3 in response to client feedback and midpoint presentation feedback about project scope.

### Requirement 1: Multi-Line Selection

Implement functionality enabling code reviewers to select multiple non-adjacent lines of code within a single file, visually displaying all selected lines before prompting for feedback.

**Acceptance Criteria:**

- Reviewers can click on a line to set the first anchor, then Ctrl+click (Windows/Linux) or Cmd+click (macOS) on additional lines to add more anchors.
- Selected lines are visually highlighted until the reviewer deselects them or creates a comment.
- Clicking on a line that has already been selected deselects it.
- Reviewers can select lines on either side ("before" or "after") of the diff.

**Status:** Delivered (Sprint 1).

### Requirement 2: Multi-Anchored Comment Creation

Enable code reviewers to create a single comment that references any number of selected lines, so that a single piece of feedback is attached to all relevant locations.

**Acceptance Criteria:**

- After selecting multiple lines, the reviewer presses 'c' (the same key used for standard Gerrit comments) to open the comment box.
- The comment box displays the line number and diff side for each selected anchor.
- Once submitted, the comment is associated with all selected lines.
- The multi-anchor workflow does not interfere with standard single-line or adjacent-block commenting.

**Status:** Delivered (Sprint 1).

### Requirement 3: Anchor Visualization

Enable code authors to see which lines a multi-anchored comment refers to, providing full context without parsing the entire file.

**Acceptance Criteria:**

- A multi-anchored comment visually indicates all associated lines by highlighting them in the UI.
- Hovering over or clicking on a comment highlights the associated lines.
- The comment UI displays associated line numbers with their diff side.

**Status:** Delivered (Sprint 1).

### Requirement 4: Backend Persistence

All code review comments, especially multi-anchored ones, persist in the backend so that code authors can view them across sessions.

**Acceptance Criteria:**

- Upon creation, all metadata (line numbers, comment text, file paths, patchset) is stored persistently using Git-based storage following NoteDB conventions.
- Gerrit's REST APIs are updated to support multi-anchored comments via plugin-specific endpoints.
- CRUD operations (create, read, update, delete) are available through REST endpoints.

**Status:** Delivered (Sprint 2).

### Requirement 5: Native Gerrit Integration

Integrate multi-anchored comments into Gerrit's existing commenting functionality without breaking native behavior.

**Acceptance Criteria:**

- The Gerrit plugin builds correctly via Bazel alongside Gerrit core.
- Users can toggle the plugin on/off via the standard plugin administration page.
- Single-line and adjacent-block comments continue to render and persist correctly when the plugin is enabled.
- The multi-anchor comment workflow is intuitive alongside the native Gerrit workflow.

**Status:** Delivered (Sprints 1–3).

### Requirement 6: Cross-File Multi-Anchored Comments

Extend multi-anchored comments to reference lines across different files within the same patchset.

**Acceptance Criteria:**

- Highlighted lines persist when switching between files during comment creation.
- The comment draft box shows the specific files and lines selected.
- Once created, a cross-file comment appears on each referenced file's diff view.
- Anchor metadata includes file path information per anchor.

**Status:** Delivered (Sprint 3).

### Requirement 7: AI-Powered Code Review (RobotComments)

Provide a front-end feature that triggers an AI-generated draft review with multi-anchored commenting support.

**Acceptance Criteria:**

- An "AI Review" button is rendered on the commit diff page.
- Pressing the button triggers an API call to an LLM with the commit diff as context.
- AI-generated comments support the multi-anchored format, selecting relevant non-adjacent lines.
- Comments are stored as draft entities that the reviewer can edit, resolve, or modify anchors on before finalizing.
- The prompt explicitly differentiates when multi-anchored vs. standard comments are appropriate.

**Status:** Delivered (Sprint 3).

### Requirement 8: Cross-Patchset Comment Persistence

Multi-anchor ranges are scoped to the patchset they were created on, handling anchor drift when code is modified in subsequent patchsets.

**Acceptance Criteria:**

- Additional anchor ranges are stored and retrieved with an explicit patchset identity, so line numbers always refer to the correct revision.
- When the change URL uses an implicit "current" revision, the plugin resolves it to the real patchset number.
- If saving additional ranges fails after a draft is created, the draft is removed or the flow fails gracefully.
- Deleting a multi-anchor draft cleans up plugin-stored ranges and surfaces partial failures in logs without breaking the user's discard flow.

**Status:** Delivered (Sprint 3–4); core scoping logic delivered
---

## 3. Architectural Diagrams

### 3.1 Deployment Diagram

<img width="621" height="361" alt="Screenshot 2026-05-15 at 5 41 28 AM" src="https://github.com/user-attachments/assets/9a1829d4-2662-40d8-ab8f-46c8f241e611" />

**Node Descriptions:**

**Personal Computer:** The developer’s local machine. It hosts both the Gerrit UI and the Git client. In the local development environment, this machine connects to a locally running Gerrit instance

- **Web Browser (PolyGerrit UI):** The browser running Gerrit's frontend. The plugin's JavaScript executes here, rendering the diff view, displaying multi-anchor comments, and providing the AI Review button. Communicates with the Gerrit server over HTTP/REST on port 8080.

- **Git Client:** Used to push code changes to Gerrit for review over SSH on port 29418.

**Gerrit Server (localhost:8080 in dev):** The server running the Gerrit instance.

- **gerrit.war daemon:** The running Gerrit JVM process that hosts all server-side logic including the REST API, SSH server, and plugin runtime. The plugin's JAR is loaded at startup from `$GERRIT_SITE/plugins/`.

- **REST API:** Gerrit's HTTP REST API layer. Handles browser requests for both native Gerrit endpoints and plugin-registered endpoints (e.g., `/multianchor-ranges`, `/ai-review`).

- **SSH Server:** Handles git push/fetch operations on port 29418.

- **Plugin Layer:** The plugin JAR is loaded here, registering its REST endpoints and frontend JavaScript. Handles reads/writes to Git refs for persistence.

**Git Repository Storage (JGit / NoteDB):** Filesystem-level Git repository storage. Stores project code, review metadata, and the plugin's multi-anchor data in custom Git refs (`refs/meta/multianchor`). Accessed by the plugin via JGit.

### 3.2 Class Diagram

<img width="623" height="357" alt="Screenshot 2026-05-15 at 5 41 37 AM" src="https://github.com/user-attachments/assets/1a29a770-d9e7-4ebb-b98d-ffb8f03f6c4a" />


**Frontend Components:**

- **JS Plugin System:** The plugin's frontend entry point. Listens for user events (click, Ctrl+click) on the diff view and renders the custom comment input box. Makes REST calls to both Gerrit's native Draft Comments API and the plugin's own backend endpoints to save and load multi-anchor comment data. Also renders the "AI Review" button and handles the AI review flow.

- **gr-diff Element:** Gerrit's built-in diff rendering component. The plugin traverses the Shadow DOM chain to inject styling (highlight selected lines) and attach event listeners for multi-anchor selection.

**Backend Components:**

- **Draft Comments Service:** Gerrit's native REST API for managing draft comments at `/changes/{id}/revisions/{rev}/drafts`. The plugin calls this directly to create the primary anchor comment, giving each multi-anchor comment a native Gerrit UUID that integrates with the normal review workflow.

- **REST Framework (Guice):** Gerrit's REST routing and registration infrastructure. The plugin registers its own `/multianchor-ranges` and `/ai-review` endpoints as child collections under the change resource using `ChildCollection` and `RestApiModule`.

- **Change Service:** Gerrit's change management service. Resolves `changeID` URL segments into `ChangeResource` objects, providing the plugin with change ID and project name for locating the corresponding Git repository.

- **Auth/User Service:** Provides `CurrentUser` and `IdentifiedUser` interfaces. The plugin injects `CurrentUser` to obtain the commenter's username and email for Git commit attribution when writing to NoteDB.

- **Git Repo Manager:** Wraps JGit's repository access via `GitRepositoryManager`. The plugin uses this to open the project's Git repository for reading and writing custom Git refs.

---

## 4. Final User Interface Designs

**Multi-Anchored Commenting**
<img width="789" height="451" alt="Screenshot 2026-05-15 at 5 45 42 AM" src="https://github.com/user-attachments/assets/f52a96f0-c620-4339-a675-fe793b8b15ec" />


**AI Review**

<img width="354" height="400" alt="Screenshot 2026-05-15 at 5 03 02 AM" src="https://github.com/user-attachments/assets/4c6d5491-ff4d-4624-95a9-f97f387decd9" />

---

## 5. Developer Environment Setup & Deployment Procedure

### 5.1 Prerequisites

- **Java:** JDK 21 or later (JDK 25 is Gerrit's current default; JDK 21 is needed for coverage builds)
- **Bazel / Bazelisk:** Required for building Gerrit and the plugin
- **Git:** For cloning the repository and pushing test changes
- **SSH:** For communicating with the local Gerrit instance
- **An Anthropic API key** (optional; required only for the AI review feature): obtain one at [https://console.anthropic.com](https://console.anthropic.com)

### 5.2 First-Time Setup

Clone the Gerrit repository and place the plugin inside it:

```bash
git clone https://github.com/GerritCodeReview/gerrit
cd gerrit
# Place the multianchor_comment folder inside /plugins
```

Build the Gerrit WAR:

```bash
bazel build //:gerrit
```

> **Note:** You may need to run `REPIN=1 bazel run @external_deps//:pin` if upstream dependencies changed.

Initialize a development Gerrit site:

```bash
java -jar bazel-bin/gerrit.war init --batch --dev -d /tmp/gerrit-site
```

### 5.3 Building the Plugin

```bash
bazel build //plugins/multianchor_comment:multianchor_comment
```

Copy the JAR to the development Gerrit site:

```bash
sudo cp bazel-bin/plugins/multianchor_comment/multianchor_comment.jar /tmp/gerrit-site/plugins/
```

### 5.4 Starting Gerrit

Before starting, ensure no previous Gerrit processes are running:

```bash
ps aux | grep gerrit
# If any are found:
kill <PID>
```

Start the Gerrit daemon:

```bash
java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site
```

Open [http://localhost:8080](http://localhost:8080) in a browser. To sign in, click "sign in" and then click "admin" (no credentials needed in dev mode).

### 5.5 Verifying Plugin Installation

Navigate to [http://localhost:8080/admin/plugins](http://localhost:8080/admin/plugins) and confirm that `multianchor_comment` is listed and enabled.

### 5.6 Adding a Test Repository

Generate an SSH key for Gerrit:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_gerrit -C "gerrit-local"
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_gerrit
```

Configure SSH (`~/.ssh/config`):

```
Host localhost
  Port 29418
  User admin
  IdentityFile ~/.ssh/id_gerrit
```

Add the public key to Gerrit: navigate to Settings > SSH Keys in the Gerrit UI, paste the output of `cat ~/.ssh/id_gerrit.pub`, and click Add.

Verify the connection:

```bash
ssh -p 29418 localhost gerrit version
```

Create a project and push code:

```bash
ssh -i ~/.ssh/id_gerrit -p 29418 admin@localhost gerrit create-project <repo-name>
git remote add gerrit ssh://localhost:29418/<repo-name>
```

Install the Gerrit commit-msg hook (required for Change-Id footers):

```bash
f="$(git rev-parse --git-dir)/hooks/commit-msg"
curl -o "$f" http://localhost:8080/tools/hooks/commit-msg
chmod +x "$f"
```

Push a change for review:

```bash
git push ssh://admin@localhost:29418/<repo-name> HEAD:refs/for/master
```

> **Troubleshooting:** If you re-initialized Gerrit, you may need to run `ssh-keygen -R "[localhost]:29418"` to clear stale host keys. If the user does not exist, you can create one with username "admin" and full name "Admin".

### 5.7 AI Review Configuration

The AI review feature requires an Anthropic API key configured on the Gerrit server.

**Step 1 — Get an API key:** Create an account at [https://console.anthropic.com](https://console.anthropic.com) and generate a key. Free trial credits are sufficient for development. The recommended model is `claude-haiku-4-5-20251001` (cheapest option).

**Step 2 — Configure `gerrit.config`:** Add the following to `/tmp/gerrit-site/etc/gerrit.config`:

```ini
[plugin "multianchor_comment"]
    aiApiUrl = https://api.anthropic.com/v1/messages
    aiModel = claude-haiku-4-5-20251001
```

To use a more capable model at higher cost, replace with `claude-sonnet-4-6` or `claude-opus-4-6`.

**Step 3 — Configure `secure.config`:** Add your API key to `/tmp/gerrit-site/etc/secure.config`:

```ini
[plugin "multianchor_comment"]
    aiApiKey = sk-ant-your-key-here
```

If `secure.config` does not exist, create it:

```bash
touch /tmp/gerrit-site/etc/secure.config
chmod 600 /tmp/gerrit-site/etc/secure.config
```

The `chmod 600` ensures only the Gerrit process owner can read the key.

**Step 4 — Rebuild and restart Gerrit** (see Sections 5.3 and 5.4).

**Step 5 — Verify:** Navigate to a diff view in Gerrit (open a change and click on a file). A blue "AI Review" button should appear in the bottom-right corner. Clicking it will generate draft comments after a few seconds.

**AI Review Troubleshooting:**

| Symptom                                                   | Likely Cause                          | Fix                                                                                                      |
| --------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Button appears but nothing happens / spinner runs forever | Invalid or missing API key            | Verify `secure.config` contains the correct key with available credits                                   |
| `insufficient_quota` error in server logs                 | API key out of credits                | Add credits at console.anthropic.com or generate a new key                                               |
| Button does not appear                                    | Plugin not loaded                     | Check `http://localhost:8080/admin/plugins`; verify JAR is in plugins directory and Gerrit was restarted |
| Comments have only one anchor                             | Expected for single-occurrence issues | Multi-anchor comments are generated when the AI detects the same issue in multiple locations             |
| AI review is slow                                         | Using a large model                   | Switch to `claude-haiku-4-5-20251001` in `gerrit.config`                                                 |

**Cost Estimates (approximate, depends on diff size):**

| Model                     | Small Diff | Large Diff |
| ------------------------- | ---------- | ---------- |
| claude-haiku-4-5-20251001 | ~$0.0001   | ~$0.001    |
| claude-sonnet-4-6         | ~$0.001    | ~$0.01     |
| claude-opus-4-6           | ~$0.005    | ~$0.05     |

### 5.8 Rebuilding After Changes

When you make edits to the plugin source:

```bash
bazel build //plugins/multianchor_comment:multianchor_comment
sudo cp bazel-bin/plugins/multianchor_comment/multianchor_comment.jar /tmp/gerrit-site/plugins/
# Restart Gerrit (Section 6.4), then hard-reload the browser: Ctrl/Cmd + Shift + R
```

When done with Gerrit, press Ctrl+C in the terminal to shut down the daemon cleanly (avoids lingering processes).

---

## 6. Style Guide & Developer Workflow

### 6.1 Branching Strategy

Each user story or feature is developed on its own branch that includes the story identifier for traceability. Branches are kept short-lived and rebased onto `main` regularly to reduce merge friction and keep reviews focused on the story delta. Developers implement the feature, run local tests (unit, integration, and frontend Jest where applicable), and validate behavior locally before opening a pull request. Large or cross-cutting work is split into smaller, reviewable commits and branches (for example: API changes, UX changes, and tests separated) to simplify review and potential rollback. Bug fix branches follow the same workflow.

### 6.2 Code Review Process

Before any PR is merged into `main`, it must be reviewed and approved by at least one team member who did not author the change, with two reviewers requested for cross-cutting or higher-risk changes. Reviewers verify correctness, readability, test completeness, documentation/manual updates, and the PR's impact on behavior and UX.
 
In addition to manual review, CodeRabbit.ai is configured on the repository to provide automated feedback on every PR. Developers evaluate and apply recommended fixes they deem appropriate and address review feedback through iterative commits in the same branch to keep the PR focused and the change history clear.


### 6.3 Peer Programming

Pair programming is a deliberate practice for complex work such as integration tests, storage/ref fixes, UI refactors, and coverage improvements. Pairs are assigned based on the user story assignee table and rotate across sprints to expose each member to different areas of the codebase (frontend, backend API, storage, testing). For well-scoped fixes, developers work solo, reserving pairing for tasks where two contributors materially increase speed, confidence, or knowledge transfer.

### 6.4 Commit Conventions

Commit messages use descriptive headers with PR references. Examples from the project:

- `Add Bazel Building Functionality (#2)`
- `Implement User Stories 1 and 2 for Sprint 1 (#5)`
- `Fix Typing 'c' in Textbox (User Story 3) (#9)`
- `Address PR review feedback on multi-anchor comment plugin`

Each commit header should clearly describe what was changed and why.

### 6.5 PR Sizing

PRs should be scoped to a single feature or user story. If a PR exceeds approximately 300 lines of changes, it should be split into smaller, independently reviewable units. This was adopted as a practice starting in Sprint 3 after client feedback that Sprint 2's two large PRs were difficult to review.

### 6.6 Code Style

**Java (Backend):** Follow Gerrit's existing code style conventions. The Gerrit codebase uses Google Java Style. Key points: 2-space indentation, Javadoc on public methods, Guice `@Inject` annotations on constructors.

**JavaScript (Frontend):** All functions in `multianchor_comment.js` have canonical JSDoc-style comments including `@param`, `@returns`, and purpose descriptions. This documentation standard was established in Sprint 1 and should be maintained for all new frontend code.

---

## 7. Test Plan & Results

### 7.1 Test Plan Overview

The test suite follows the testing pyramid: approximately 80% unit tests, 15% integration tests, and 5% end-to-end tests.

**Testing styles employed:**

- **Exploratory testing:** Used during initial development to manually exercise the frontend in a running Gerrit instance. Useful for baseline assurance before writing formal tests.
- **Black box testing:** Unit tests created by engineers who did not develop the feature, based on the specification alone.
- **White box testing:** Unit tests written by the feature developer with knowledge of the implementation.

**Automation:**

- Backend: JUnit 4 test suites integrated into the Bazel build pipeline.
- Frontend: Jest test suites for `multianchor_comment.js`, runnable via Bazel or locally via `npm test`.

### 7.2 How to Run the Tests

**Run all tests (recommended):**

From the Gerrit repository root:

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_all_tests
```

Or from the plugin directory:

```bash
./run_all_plugin_tests.sh
```

**Run Java tests only:**

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_tests
```

**Run frontend tests only (via Bazel):**

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_frontend_tests
```

**Run frontend tests locally (faster iteration):**

```bash
cd plugins/multianchor_comment
npm ci
npm test
# Coverage report: coverage/lcov-report/index.html
```

**Viewing Jest coverage output under Bazel:**

Gerrit's `.bazelrc` uses `--test_output=errors` by default, which hides output for passing tests. To see the Jest coverage summary:

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_frontend_tests \
  --test_output=all --cache_test_results=no
```

Jest copies `coverage-summary.json` and `lcov.info` into undeclared outputs as `jest-coverage/` when `TEST_UNDECLARED_OUTPUTS_DIR` is set.

### 7.3 Coverage

Coverage is tracked separately for Java and JavaScript since they use different tooling.

**JavaScript (Jest):**

Run `npm test` locally for a full coverage table and HTML report at `coverage/lcov-report/index.html`.

**Java (JUnit / JaCoCo):**

Gerrit's default JDK 25 bytecode can break Bazel's JaCoCo instrumentation step. Pin the Java 21 toolchain for coverage builds:

```bash
bazelisk coverage //plugins/multianchor_comment:multianchor_comment_tests \
  --combined_report=lcov \
  --test_output=errors \
  --java_language_version=21 \
  --java_runtime_version=remotejdk_21 \
  --tool_java_language_version=21 \
  --tool_java_runtime_version=remotejdk_21
```

Convert the resulting LCOV report to HTML:

```bash
genhtml "$(bazel info execution_root)/bazel-out/_coverage/_coverage_report.dat" \
  -o /tmp/multianchor-java-coverage-html
```

**Coverage targets:** 90% line coverage, 85% branch coverage.

Java (backend) met both targets:

<img width="618" height="133" alt="Screenshot 2026-05-15 at 5 49 18 AM" src="https://github.com/user-attachments/assets/7f195fb9-9b5a-4f68-824d-3eaf003784a7" />

JavaScript (frontend) coverage via Jest:

<img width="626" height="100" alt="Screenshot 2026-05-15 at 6 18 40 AM" src="https://github.com/user-attachments/assets/c9fc2325-987f-4fb3-951e-260a63a9854f" />

The JavaScript coverage targets were not attainable at the level set for Java. The frontend logic runs inside Gerrit's Shadow DOM and is not directly accessible to Jest in the same way backend endpoints are to JUnit. Iterating on the test suite showed that achieving higher coverage would require splitting functions and files in non-intuitive ways that inflate the metrics without adding meaningful assurance. Jest remained highly useful for exercising scoped, predescribed interactions with the frontend.


### 7.4 Integration & End-to-End Testing

<img width="337" height="59" alt="Screenshot 2026-05-15 at 6 00 24 AM" src="https://github.com/user-attachments/assets/8f183e5b-dab6-4a84-ba60-09143e83e576" />

<img width="621" height="67" alt="Screenshot 2026-05-15 at 6 00 29 AM" src="https://github.com/user-attachments/assets/9f248583-dae9-4c57-80a9-7d72072dd497" />

Integration Tests
- Integration tests are located at MultiAnchorCommentIT.java in the test folder
- These tests do the following:
  - API coverage: Exercise the plugin REST endpoints for saving, listing, getting and deleting multi-anchor ranges.
  - Storage validation: Verify MultiAnchorStorage persists ranges into refs/users and correctly wraps ref updates.
  - AI integration (where present): Exercise AiReview client hooks to ensure graceful handling of AI review responses.

E2E: Added in the /plugins/multianchor_comment/e2e-tests directory
- Scenario implementation: plugins/multianchor_comment/e2e-tests/src/test/scala/com/google/gerrit/scenarios/MultiAnchorRangesRest.scala
- Data-driven inputs: …/MultiAnchorRangesRest.json and …/MultiAnchorRangesRest-body.json under src/test/resources/data/
- Same package and base class pattern as e2e-tests/ (Gatling Simulation via GerritSimulation, httpProtocol, jsonFile(resource).convert(keys)).
- Executed via plugins/multianchor_comment/e2e-tests/OVERLAY.txt


---

## 8. Known Issues & Future Work

### 8.1 Known Issues

**User confusion with native comments (reduced):** Multi-anchored comments use different shortcuts, semantics, and persistence mechanisms from Gerrit's native single-range comments. The addition of the User Manual mitigates this, but without further UI discoverability cues, this can still confuse reviewers unfamiliar with the plugin. The user's manual should be consulted for usage instructions.
 
**AI-generated review quality inconsistency:** The usefulness of AI-generated multi-anchored comments depends on prompt quality and the external LLM response format. AI reviews may occasionally generate excessive comments, irrelevant suggestions, or malformed outputs. Prompt engineering improvements were added during Sprint 4 to encourage smaller-scoped comments, and defensive parsing logic was implemented to handle malformed AI responses. All AI-generated comments are stored as editable drafts, allowing reviewers to modify or discard suggestions before submission.
 
**Gerrit upstream compatibility changes:** Because the plugin integrates deeply with Gerrit frontend rendering, REST APIs, and storage behavior, future Gerrit updates may introduce breaking changes to internal APIs, DOM structures, or plugin loading behavior. Automated Jest, integration, and Gatling tests provide regression coverage to quickly identify compatibility issues after upstream changes.


### 8.2 Resolved Issues
 
**Stale current-revision caching:** Previously, the UI could cache the resolved patchset for "current" and read/write plugin data against an older patchset until reload. This was resolved by updated patchset feature fixes merged to main in Sprint 4.


### 8.3 Future Work / Enhancement Opportunities

The following features were discussed during the project but not implemented due to time constraints:
 
- **Comment navigation / overview panel:** A UI panel that lists all multi-anchored comments in a change and allows clicking to jump directly to the corresponding lines, even across files. This would address usability for large reviews.
- **Enhanced visual indicators:** Iconography or badges on multi-anchored comments showing the number of anchored locations and their file paths, to distinguish them more clearly from standard comments in the comment thread.
- **Automated anchor remapping:** When code referenced by a multi-anchored comment shifts due to edits in a subsequent patchset, automatically remap anchor line numbers rather than simply scoping to the original patchset. This is the "anchor drift" problem partially addressed by patchset-scoped storage but not fully solved with automatic remapping.
- **Upstream contribution:** Packaging the plugin for submission to the Gerrit open-source project as a contributed plugin or proposing multi-anchor commenting as a core Gerrit feature. The client noted during the final presentation that this project originated from the official Gerrit page and that integration is a real possibility.
- **Linter integration:** Adding a linter for internal code quality, both for the plugin codebase and potentially as a contribution to the native Gerrit codebase if pursuing upstream integration. This was raised during the final presentation as a good addition.


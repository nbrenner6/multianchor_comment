# First time running

Clone the repo: https://github.com/GerritCodeReview/gerrit

Place the multianchor_comment folder (the parent directory of this README) into the plugins/ directory.

Run: bazel build :gerrit

Run: java -jar bazel-bin/gerrit.war init --batch --dev -d /tmp/gerrit-site

# Building

To build the plugin, run: bazel build //plugins/multianchor_comment:multianchor_comment

Copy the jar to the development directory: cp bazel-bin/plugins/multianchor_comment/multianchor_comment.jar /tmp/gerrit-site/plugins/

# Start Gerrit

First, ensure that previous sessions are not running: pkill -f "gerrit.war daemon"

To start Gerrit, run: java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site

Open in a browser: http://localhost:8080

# Verify the plugin installation

In Gerrit, click "sign in," but instead of entering your credentials, click "admin."

Then, go to: http://localhost:8080/admin/plugins and verify that multianchor_comment is listed.

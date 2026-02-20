# First time running

Clone the repo: https://github.com/GerritCodeReview/gerrit
Change to the directory: cd gerrit

Place the multianchor_comment folder inside /plugins

# Build the Gerrit WAR

Build the Gerrit WAR: bazel build //:gerrit

# Initialize a development Gerrit site

Run: java -jar bazel-bin/gerrit.war init --batch --dev -d /tmp/gerrit-site

# Building

To build the plugin, run: bazel build //plugins/multianchor_comment:multianchor_comment

Copy the jar to the development directory: sudo cp bazel-bin/plugins/multianchor_comment/multianchor_comment.jar /tmp/gerrit-site/plugins/

# Start Gerrit

First, ensure that previous sessions are not running

Run: ps aux | grep gerrit

If any processes related to gerrit are running, run kill <PID>

To start Gerrit, run: java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site

Open in a browser: http://localhost:8080

# Verify the plugin installation

In Gerrit, click "sign in," but instead of entering your credentials, click "admin."

Then, go to: http://localhost:8080/admin/plugins and verify that multianchor_comment is listed.

# Adding a repo

Run: ssh-keygen -t ed25519 -f ~/.ssh/id_gerrit -C "gerrit-local"

Create a passphrase of your choosing

Load the key into ssh agent:
- Run: eval "$(ssh-agent -s)"
- Run: ssh-add ~/.ssh/id_gerrit

Then, do: nano ~/.ssh/config

Add the following:

Host localhost
  Port 29418
  User <your-gerrit-username>
  IdentityFile ~/.ssh/id_gerrit

Now, open the Gerrit Web UI at: http://localhost:8080 and log in as admin

Go to: Settings/SSH Keys

Paste the output of: cat ~/.ssh/id_gerrit.pub

Click Add

Run: ssh -p 29418 localhost gerrit version

to check your gerrit version

Create a new GitHub repo locally. Then, run: ssh -i ~/.ssh/id_gerrit -p 29418 admin@localhost gerrit create-project <repo-name>

Add Gerrit as a remote: git remote add gerrit ssh://localhost:29418/<repo-name>

Install Gerrit commit-msg hook (necessary):

f="$(git rev-parse --git-dir)/hooks/commit-msg"; curl -o "$f" http://localhost:8080/tools/hooks/commit-msg ; chmod +x "$f"

If you already had commits, use git commit --amend to ensure they all have a Change-Id in the footer

Make a commit and push using: git push ssh://admin@localhost:29418/<repo-name> HEAD:refs/for/master

Verify that you can see the commit in the Gerrit Web UI

# Using the plugin

Looking at a diff view for a commit, hold ctrl/cmd and select multiple (even non-adjacent) lines.

Press 'c'

You should see a "Draft - Multi-anchor: <selected lines>" comment box appear!



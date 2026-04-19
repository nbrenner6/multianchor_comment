# First time running

Clone the repo: https://github.com/GerritCodeReview/gerrit
Change to the directory: cd gerrit

Place the multianchor_comment folder inside /plugins

# Build the Gerrit WAR

Build the Gerrit WAR: `bazel build //:gerrit`

# Initialize a development Gerrit site

Run: `java -jar bazel-bin/gerrit.war init --batch --dev -d /tmp/gerrit-site`

# Building

To build the plugin, run: `bazel build //plugins/multianchor_comment:multianchor_comment`

Copy the jar to the development directory: `sudo cp bazel-bin/plugins/multianchor_comment/multianchor_comment.jar /tmp/gerrit-site/plugins/`

# Start Gerrit

First, ensure that previous sessions are not running

Run: `ps aux | grep gerrit`

If any processes related to gerrit are running, run `kill <PID>`

To start Gerrit, run: `java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site`

Open in a browser: http://localhost:8080

# Verify the plugin installation

In Gerrit, click "sign in," but instead of entering your credentials, click "admin."

Then, go to: http://localhost:8080/admin/plugins and verify that multianchor_comment is listed.

# Adding a repo

Run: `ssh-keygen -t ed25519 -f ~/.ssh/id_gerrit -C "gerrit-local"`

Create a passphrase of your choosing

Load the key into ssh agent:
- Run: `eval "$(ssh-agent -s)"`
- Run: `ssh-add ~/.ssh/id_gerrit`

Then, do: `nano ~/.ssh/config`

Add the following:

```
Host localhost
  Port 29418
  User <your-gerrit-username> (admin if you signed in as admin)
  IdentityFile ~/.ssh/id_gerrit
```

Now, open the Gerrit Web UI at: http://localhost:8080 and log in as admin

Go to: Settings/SSH Keys

Paste the output of: `cat ~/.ssh/id_gerrit.pub`

Click Add

Run: `ssh -p 29418 localhost gerrit version` to check your gerrit version

Create a new GitHub repo locally. Then, run: `ssh -i ~/.ssh/id_gerrit -p 29418 admin@localhost gerrit create-project <repo-name>`

  - If you re-initalized Gerrit, you may have to run `ssh-keygen -R "[localhost]:29418"` first
  - If the user does not exist, you can create one with username "admin" and full name "Admin"

Add Gerrit as a remote: `git remote add gerrit ssh://localhost:29418/<repo-name>`

Install Gerrit commit-msg hook (necessary):

`f="$(git rev-parse --git-dir)/hooks/commit-msg"; curl -o "$f" http://localhost:8080/tools/hooks/commit-msg ; chmod +x "$f"`

If you already had commits, use git commit --amend to ensure they all have a Change-Id in the footer

Make a commit and push using: `git push ssh://admin@localhost:29418/<repo-name> HEAD:refs/for/master`

Verify that you can see the commit in the Gerrit Web UI

# AI Review Configuration

The plugin includes an AI-powered code review feature that posts multi-anchor draft comments
on your diffs automatically. When enabled, a **🤖 AI Review** button appears in the bottom-right
corner of any diff view. Clicking it sends the diff to an AI model which returns review comments,
potentially anchored to multiple non-adjacent locations simultaneously.

## Prerequisites

- A Gerrit site initialized and running (see setup instructions above)
- An Anthropic API key (get one free at https://console.anthropic.com)
- The plugin jar installed in your Gerrit site's `plugins/` directory

## Setup

### 1. Get an API Key

Go to https://console.anthropic.com, create an account, and generate an API key.
You will receive free trial credits which are sufficient for development use.
The recommended model is `claude-haiku-4-5-20251001` which is the cheapest option.

### 2. Configure gerrit.config

Add the following section to your Gerrit site's `etc/gerrit.config`
(located at `/tmp/gerrit-site/etc/gerrit.config` in the default dev setup):

```ini
[plugin "multianchor_comment"]
    aiApiUrl = https://api.anthropic.com/v1/messages
    aiModel = claude-haiku-4-5-20251001
```

To use a more capable model at higher cost, replace `claude-haiku-4-5-20251001` with
`claude-sonnet-4-6` or `claude-opus-4-6`.

### 3. Configure secure.config

Add your API key to `etc/secure.config` (this file is separate from `gerrit.config`
so the key is not accidentally committed or shared):

```ini
[plugin "multianchor_comment"]
    aiApiKey = sk-ant-your-key-here
```

If `secure.config` does not exist yet, create it:

```bash
touch /tmp/gerrit-site/etc/secure.config
chmod 600 /tmp/gerrit-site/etc/secure.config
nano /tmp/gerrit-site/etc/secure.config
```

The `chmod 600` ensures only the Gerrit process owner can read the key.

### 4. Install the Plugin

Build the plugin and copy the jar to your Gerrit site:

```bash
bazel build //plugins/multianchor_comment:multianchor_comment
sudo cp bazel-bin/plugins/multianchor_comment/multianchor_comment.jar /tmp/gerrit-site/plugins/
```

### 5. Restart Gerrit

```bash
# Find and stop any running Gerrit process
ps aux | grep gerrit
kill <PID>

# Start Gerrit again
java -jar bazel-bin/gerrit.war daemon --console-log -d /tmp/gerrit-site
```

### 6. Verify

Navigate to a diff view in Gerrit (open a change and click on a file).
You should see a blue **🤖 AI Review** button in the bottom-right corner of the page.
Click it — after a few seconds, draft comments will appear in the diff with multi-anchor
highlighting showing all related locations for each issue.

## Troubleshooting

**Button appears but nothing happens / spinner runs forever**
Check the Gerrit server console for errors. The most common cause is an invalid or
missing API key. Verify `secure.config` contains the correct key and that the key
has available credits at https://console.anthropic.com.

**"insufficient_quota" error in server logs**
Your API key has run out of credits. Add credits at https://console.anthropic.com
or generate a new key on an account with credits.

**Button does not appear in the diff view**
The plugin may not be loaded. Go to `http://localhost:8080/admin/plugins` and confirm
`multianchor_comment` is listed and enabled. If not, check that the jar was copied
to the correct plugins directory and Gerrit was restarted.

**Comments appear but have only one anchor**
This is expected for issues that appear only once in the diff. Multi-anchor comments
are generated when the AI detects the same issue in multiple locations simultaneously.
Files with more code and repeated patterns will produce more multi-anchor comments.

**AI review is too slow**
Switch to `claude-haiku-4-5-20251001` in `gerrit.config` — it is significantly faster
and cheaper than Sonnet or Opus while still producing useful reviews.

## Cost Estimates

All costs are approximate and depend on diff size.

| Model | Cost per review (small diff) | Cost per review (large diff) |
|---|---|---|
| claude-haiku-4-5-20251001 | ~$0.0001 | ~$0.001 |
| claude-sonnet-4-6 | ~$0.001 | ~$0.01 |
| claude-opus-4-6 | ~$0.005 | ~$0.05 |

For development and testing, `claude-haiku-4-5-20251001` is strongly recommended.
$5 of credits will cover hundreds to thousands of test reviews.

# Using the plugin

Looking at a diff view for a commit, hold ctrl/cmd and select multiple (even non-adjacent) lines.

Press 'c'

You should see a "Draft - Multi-anchor: <selected lines>" comment box appear!

# Testing

To run the test suite, run: `bazel test //plugins/multianchor_comment:multianchor_comment_tests`

# Tips

When you make an edit, you can rebuild, copy the jar to the development directory (use sudo), and then run the jar.

Instead of looking up the URL each time, you can do ctrl/cmd + shift + R to hard reload the page.

When done with Gerrit, do ctrl + C to properly shut Gerrit down (avoids lingering processes).

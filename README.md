# First time running

Clone the repo: https://github.com/GerritCodeReview/gerrit
Change to the directory: cd gerrit

Place the multianchor_comment folder inside /plugins

# Build the Gerrit WAR

Build the Gerrit WAR: `bazel build //:gerrit`

Note: You may need to run `REPIN=1 bazel run @external_deps//:pin` if upstream dependencies changed

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

Looking at a diff view for a commit:

1. **Click once** (no modifier) on a line to set the **first anchor** — that line is selected.
2. **Ctrl+click** (Windows/Linux) or **Cmd+click** (macOS) on other lines to **add** more anchors (any file in the change).

Press 'c'

You should see a "Draft - Multi-anchor: <selected lines>" comment box appear!

# Testing

## Run everything at once (recommended)

From the **Gerrit repository root**, Java (JUnit) and frontend (Jest) tests run together:

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_all_tests
```

Or from this plugin directory:

```bash
./run_all_plugin_tests.sh
```

The Jest `sh_test` prints a **coverage summary block** to its stdout (`=== multianchor_comment Jest coverage (totals) ===`). You often **will not see it** when:

- Gerrit’s `.bazelrc` uses **`--test_output=errors`**, so **passing** tests hide logs, and/or  
- results are **(cached)**, so Bazel does not re-run the test and prints almost nothing.

**To see Jest coverage in the terminal under Bazel**, force a fresh run and show all test output:

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_frontend_tests \
  --test_output=all --cache_test_results=no
```

Same idea for the combined suite (only the Jest target will print the block; Java stays quiet unless it fails):

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_all_tests \
  --test_output=all --cache_test_results=no
```

Under Bazel, Jest also copies `coverage-summary.json` and `lcov.info` into undeclared outputs as `jest-coverage/` when `TEST_UNDECLARED_OUTPUTS_DIR` is set (see [undeclared outputs](https://bazel.build/reference/test-encyclopedia)).

## Run targets individually

**Java only** (plugin + REST integration):

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_tests
```

**Frontend only** (Jest under Bazel — isolated temp dir, `npm ci` + `npm test`):

```bash
bazel test //plugins/multianchor_comment:multianchor_comment_frontend_tests
```

**Frontend locally** (faster iteration; HTML + JSON coverage under `coverage/`):

```bash
cd plugins/multianchor_comment
npm ci          # or: npm install
npm test        # thresholds in jest.config.cjs; see coverage/lcov-report/index.html
```

## Coverage across the full suite

The plugin is tested in **two languages**; coverage is **not merged into one percentage** (Java and JavaScript use different tooling).

### JavaScript (Jest) — `multianchor_comment.js`

| How | What you get |
|-----|----------------|
| **Local (simplest)** | `cd plugins/multianchor_comment && npm test` — full table + `coverage/coverage-summary.json` + `coverage/lcov.info` + `coverage/lcov-report/index.html` |
| **Bazel** | Use `--test_output=all` (and usually `--cache_test_results=no`) on `multianchor_comment_frontend_tests` so the **`=== multianchor_comment Jest coverage (totals) ===`** block appears in the console |

### Java (JUnit) — `src/main/java` / `src/test/java`

| Command | Notes |
|---------|--------|
| `bazel test //plugins/multianchor_comment:multianchor_comment_tests` | Runs tests; **no** JaCoCo coverage report. |
| `bazel coverage …` (see below) | Produces LCOV / per-test `coverage.dat` when JaCoCo can instrument the bytecode (see JDK note). |

**Java coverage (recommended on this tree):** Gerrit’s default **JDK 25** bytecode often breaks Bazel’s JaCoCo step (`Unsupported class file major version 69`). Pin the **Java 21** toolchain for the coverage build and emit a combined LCOV file:

```bash
bazelisk coverage //plugins/multianchor_comment:multianchor_comment_tests \
  --combined_report=lcov \
  --test_output=errors \
  --java_language_version=21 \
  --java_runtime_version=remotejdk_21 \
  --tool_java_language_version=21 \
  --tool_java_runtime_version=remotejdk_21
```

After a successful run, Bazel prints where the merged report was written (typically under `bazel-out/_coverage/_coverage_report.dat` from the execution root, plus a per-target `coverage.dat` under `bazel-testlogs/.../multianchor_comment_tests/`). Convert to HTML with `genhtml` from the **lcov** package, for example:

```bash
genhtml "$(bazel info execution_root)/bazel-out/_coverage/_coverage_report.dat" -o /tmp/multianchor-java-coverage-html
```

(`bazel coverage` without the JDK 21 flags may still work once JaCoCo supports your default JDK; until then, use the block above or **IntelliJ → Run with Coverage** on the test classes.)

# Tips

When you make an edit, you can rebuild, copy the jar to the development directory (use sudo), and then run the jar.

Instead of looking up the URL each time, you can do ctrl/cmd + shift + R to hard reload the page.

When done with Gerrit, do ctrl + C to properly shut Gerrit down (avoids lingering processes).

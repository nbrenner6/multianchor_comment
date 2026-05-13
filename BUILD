load("//tools/bzl:junit.bzl", "junit_tests")
load("//tools/bzl:plugin.bzl", "PLUGIN_DEPS", "PLUGIN_TEST_DEPS", "gerrit_plugin")

gerrit_plugin(
    name = "multianchor_comment",
    srcs = glob(["src/main/java/**/*.java"]),
    manifest_entries = [
        "Gerrit-PluginName: multianchor_comment",
        "Gerrit-Module: com.googlesource.gerrit.plugins.multianchorcomment.PluginModule",
    ],
    resources = glob(["src/main/resources/static/**/*"]),
)

junit_tests(
    name = "multianchor_comment_tests",
    srcs = glob(["src/test/java/**/*.java"]),
    tags = ["multianchor_comment"],
    visibility = ["//visibility:public"],
    runtime_deps = [":multianchor_comment__plugin"],
    deps = [
        ":multianchor_comment__plugin",
    ] + PLUGIN_TEST_DEPS + PLUGIN_DEPS,
)

sh_test(
    name = "multianchor_comment_frontend_tests",
    srcs = ["run_jest.sh"],
    data = glob([
        "src/main/resources/static/**/*.js",
        "src/test/frontend/**/*.js",
        "jest.config.cjs",
        "package.json",
        "package-lock.json",
    ]),
    tags = ["multianchor_comment", "frontend"],
)

# Run Java (JUnit) and frontend (Jest) tests in one invocation:
#   bazel test //plugins/multianchor_comment:multianchor_comment_all_tests
test_suite(
    name = "multianchor_comment_all_tests",
    tests = [
        ":multianchor_comment_tests",
        ":multianchor_comment_frontend_tests",
    ],
    tags = ["multianchor_comment"],
)

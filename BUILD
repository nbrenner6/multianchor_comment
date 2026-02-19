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
    deps = PLUGIN_TEST_DEPS + PLUGIN_DEPS,
)

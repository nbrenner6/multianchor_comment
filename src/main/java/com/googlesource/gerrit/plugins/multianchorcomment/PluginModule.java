package com.googlesource.gerrit.plugins.multianchorcomment;

import com.google.gerrit.extensions.webui.JavaScriptPlugin;
import com.google.gerrit.extensions.webui.WebUiPlugin;
import com.google.gerrit.extensions.registration.DynamicSet;
import com.google.inject.AbstractModule;

public class PluginModule extends AbstractModule {
  @Override
  protected void configure() {
    DynamicSet.bind(binder(), WebUiPlugin.class)
        .toInstance(new JavaScriptPlugin("multianchor_comment.js"));
  }
}

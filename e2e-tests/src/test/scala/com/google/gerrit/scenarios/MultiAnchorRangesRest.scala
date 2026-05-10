// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package com.google.gerrit.scenarios

import io.gatling.core.Predef.{atOnceUsers, _}
import io.gatling.core.feeder.FeederBuilder
import io.gatling.core.structure.ScenarioBuilder
import io.gatling.http.Predef._

import scala.collection.mutable
import scala.concurrent.duration.DurationInt

/**
 * End-to-end exercise of the multianchor_comment plugin REST surface.
 *
 * The target Gerrit must have plugin multianchor_comment installed and loaded. The workflow
 * creates a disposable project and change, persists additional anchor ranges via
 * `PUT /changes/{changeId}/multianchor-ranges/{patchSet}~{commentUuid}`, reads them back with GET
 * (collection and singleton), deletes them with DELETE, then removes the project.
 */
class MultiAnchorRangesRest extends GerritSimulation {

  /** Draft-comment UUID segment used only for this scenario (no core draft comment required). */
  private val compositeIdSuffix: String = "e2e-multi-anchor-draft"

  private val data: FeederBuilder = jsonFile(resource).convert(keys).circular
  private val numbersCopy: mutable.Queue[Int] = mutable.Queue[Int]()

  private val createProject = new CreateProject(projectName)
  private val createChange = new CreateChange(projectName)

  override def relativeRuntimeWeight: Int = 10

  private val multianchorApi: ScenarioBuilder = scenario(uniqueName)
      .feed(data)
      .exec(session => {
        if (numbersCopy.isEmpty) {
          numbersCopy ++= createChange.numbers.clone()
        }
        session
            .set(numberKey, numbersCopy.dequeue())
            .set("compositeSuffix", compositeIdSuffix)
      })
      .exec(
        http(uniqueName + "-put-multianchor")
            .put("${url}${" + numberKey + "}/multianchor-ranges/1~${compositeSuffix}")
            .body(ElFileBody(body))
            .asJson
            .check(status.is(200))
      )
      .exec(
        http(uniqueName + "-list-multianchor")
            .get("${url}${" + numberKey + "}/multianchor-ranges")
            .check(status.is(200))
      )
      .exec(
        http(uniqueName + "-get-multianchor")
            .get("${url}${" + numberKey + "}/multianchor-ranges/1~${compositeSuffix}")
            .check(status.is(200))
      )
      .exec(
        http(uniqueName + "-delete-multianchor")
            .delete("${url}${" + numberKey + "}/multianchor-ranges/1~${compositeSuffix}")
            .check(status.is(204))
      )

  private val deleteProject = new DeleteProject(projectName)

  setUp(
    createProject.test.inject(
      nothingFor(stepWaitTime(createProject) seconds),
      atOnceUsers(single)
    ),
    createChange.test.inject(
      nothingFor(stepWaitTime(createChange) seconds),
      atOnceUsers(numberOfUsers)
    ),
    multianchorApi.inject(
      nothingFor(stepWaitTime(this) seconds),
      atOnceUsers(numberOfUsers)
    ),
    deleteProject.test.inject(
      nothingFor(stepWaitTime(deleteProject) seconds),
      atOnceUsers(single)
    ),
  ).protocols(httpProtocol)
}

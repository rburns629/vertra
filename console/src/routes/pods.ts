// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { listTaskPods } from "../k8s.js";
import { findSubmittedExecutions } from "../db/queries.js";
import { replyIfNotTeamMember } from "../auth/access.js";

/** The task list in a DAG payload, as far as a label needs: ids in order. */
function taskIds(payload: unknown): string[] {
  const tasks = (payload as { tasks?: { id?: unknown }[] } | null)?.tasks;
  return Array.isArray(tasks) ? tasks.map((t) => (typeof t.id === "string" ? t.id : "")) : [];
}

/**
 * What's running in a team's namespace, as tasks: each Pod the kernel
 * dispatched carries its execution id and task key (see the kernel's
 * KubernetesExecutor), so the Team page can say "task 2 of 3 of
 * gcp-hello-world-demo" instead of a pod name. Same membership-or-admin gate
 * as every team-scoped route, and only this team's namespace. An execution
 * is only named if it's one this team is part of.
 */
const podsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/teams/:teamName/pods",
    {
      schema: { params: Type.Object({ teamName: Type.String() }) },
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const { teamName } = request.params;
      if (replyIfNotTeamMember(request.authUser, teamName, reply)) return;
      const pods = await listTaskPods(teamName);
      const ids = [...new Set(pods.map((p) => p.executionId).filter((id): id is string => id !== null))];
      const executions = new Map(
        (await findSubmittedExecutions(ids))
          .filter((e) => e.teams.includes(teamName))
          .map((e) => [e.executionId, e]),
      );
      reply.send(
        pods.map((pod) => {
          const execution = pod.executionId ? executions.get(pod.executionId) : undefined;
          const tasks = execution ? taskIds(execution.payload) : [];
          const position = pod.taskKey ? tasks.indexOf(pod.taskKey) : -1;
          return {
            ...pod,
            execution: execution
              ? {
                  name: execution.name,
                  taskNumber: position >= 0 ? position + 1 : null,
                  taskCount: tasks.length || null,
                }
              : null,
          };
        }),
      );
    },
  );
};

export default podsRoutes;

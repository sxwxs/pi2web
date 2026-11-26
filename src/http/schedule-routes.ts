import type http from 'node:http';
import type {ScheduleManager} from '../schedules.js';
import type {OrchestratorHub} from '../orchestrator/hub.js';
import {json} from './utils.js';

export type ScheduleRouteContext = {
  schedules: ScheduleManager;
  orchestratorHub: OrchestratorHub;
  body(): Promise<any>;
};

/**
 * REST routes for scheduled Agent tasks and orchestrator completion watches:
 * - `GET/POST /api/v1/schedules`
 * - `GET/PUT/DELETE /api/v1/schedules/:id`
 * - `POST /api/v1/schedules/:id/run`
 * - `GET /api/v1/schedules/:id/runs` & `GET /api/v1/schedule-runs`
 * - `POST /api/v1/schedule-runs/:runId/open`
 * - `GET/DELETE /api/v1/agents/:id/watches[/:watchId]`
 */
export async function handleScheduleAndOrchestratorRoutes(
  ctx: ScheduleRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL,
  parts: string[]
): Promise<boolean> {
  const send = (status: number, data: unknown) => {
    json(res, status, data);
    return true;
  };
  if (parts[2] === 'schedules') {
    if (parts.length === 3) {
      if (req.method === 'GET') return send(200, {data: {tasks: ctx.schedules.listTasks()}});
      if (req.method === 'POST') return send(201, {data: ctx.schedules.createTask(await ctx.body())});
    }
    if (parts.length === 4) {
      const id = decodeURIComponent(parts[3]);
      if (req.method === 'GET') return send(200, {data: ctx.schedules.getTask(id)});
      if (req.method === 'PUT') return send(200, {data: ctx.schedules.updateTask(id, await ctx.body())});
      if (req.method === 'DELETE') {
        ctx.schedules.deleteTask(id);
        return send(200, {data: {deleted: true}});
      }
    }
    if (parts.length === 5) {
      const id = decodeURIComponent(parts[3]);
      if (req.method === 'POST' && parts[4] === 'run')
        return send(200, {data: await ctx.schedules.runNow(id)});
      if (req.method === 'GET' && parts[4] === 'runs') {
        ctx.schedules.getTask(id);
        const limit = Number(u.searchParams.get('limit') ?? 30);
        return send(200, {data: {runs: ctx.schedules.listRuns(id, limit)}});
      }
    }
  }
  if (parts[2] === 'schedule-runs') {
    if (parts.length === 3 && req.method === 'GET') {
      const taskId = u.searchParams.get('taskId') || undefined;
      const limit = Number(u.searchParams.get('limit') ?? 30);
      return send(200, {data: {runs: ctx.schedules.listRuns(taskId, limit)}});
    }
    if (parts.length === 5 && req.method === 'POST' && parts[4] === 'open') {
      const runId = decodeURIComponent(parts[3]);
      return send(200, {data: {agent: await ctx.schedules.openRunAgent(runId)}});
    }
  }
  if (parts[2] === 'agents' && parts[4] === 'watches') {
    const id = decodeURIComponent(parts[3]);
    if (parts.length === 5 && req.method === 'GET')
      return send(200, {data: {watches: ctx.orchestratorHub.listFor(id)}});
    if (parts.length === 5 && req.method === 'DELETE') {
      const removed = ctx.orchestratorHub.unwatch(id);
      return send(200, {data: {removed, watches: ctx.orchestratorHub.listFor(id)}});
    }
    if (parts.length === 6 && req.method === 'DELETE') {
      const watchId = decodeURIComponent(parts[5]);
      const removed = ctx.orchestratorHub.unwatch(id, watchId);
      return send(200, {data: {removed, watches: ctx.orchestratorHub.listFor(id)}});
    }
  }
  return false;
}

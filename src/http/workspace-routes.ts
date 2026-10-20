import type http from 'node:http';
import type {MetadataStore} from '../metadata-store.js';
import type {TerminalManager} from '../terminals.js';
import type {Workspace, WorkspaceStore} from '../workspaces.js';
import {json, readJsonBody} from './utils.js';

export type WorkspaceRouteContext = {
  workspaces: WorkspaceStore;
  terminals: TerminalManager;
  metadata: MetadataStore;
  ensureSessionIndex(workspace: Workspace, cwd: string, force?: boolean): Promise<void>;
};

/** Handles Workspace files, the Session index and Terminal REST routes. Returns false for any other route. */
export async function handleWorkspaceRoutes(
  ctx: WorkspaceRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL,
  parts: string[],
  requestId: string
): Promise<boolean> {
  const send = (status: number, data: unknown) => {
    json(res, status, data);
    return true;
  };
  if (req.method === 'GET' && u.pathname === '/api/v1/workspaces')
    return send(200, {data: ctx.workspaces.list()});
  if (req.method === 'POST' && u.pathname === '/api/v1/workspaces') {
    const b = await readJsonBody(req);
    if (typeof b.label !== 'string' || typeof b.rootPath !== 'string')
      return send(400, {
        error: {code: 'INVALID_REQUEST', message: 'label and rootPath required', requestId}
      });
    const workspace = ctx.workspaces.add(b.label, b.rootPath);
    ctx.metadata.saveWorkspace(workspace);
    return send(201, {data: workspace});
  }
  if (parts[2] === 'workspaces' && parts[4] === 'tree' && req.method === 'GET')
    return send(200, {
      data: await ctx.workspaces.tree(parts[3], u.searchParams.get('path') ?? '.')
    });
  if (parts[2] === 'workspaces' && parts[4] === 'file' && req.method === 'GET')
    return send(200, {
      data: await ctx.workspaces.file(
        parts[3],
        u.searchParams.get('path') ?? '',
        Number(u.searchParams.get('offset') ?? 0),
        Number(u.searchParams.get('limit') ?? 1048576)
      )
    });
  if (parts[2] === 'workspaces' && parts[4] === 'stat' && req.method === 'GET')
    return send(200, {
      data: await ctx.workspaces.stat(parts[3], u.searchParams.get('path') ?? '.')
    });
  if (req.method === 'GET' && u.pathname === '/api/v1/sessions') {
    const workspace = ctx.workspaces.get(u.searchParams.get('workspaceId') ?? '');
    if (!workspace) throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
    const cwd = await ctx.workspaces.resolve(workspace, u.searchParams.get('path') ?? '.');
    await ctx.ensureSessionIndex(workspace, cwd, u.searchParams.get('refresh') === 'true');
    const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : undefined,
      offset = Number(u.searchParams.get('offset') ?? 0);
    return send(200, {data: ctx.metadata.listSessions(cwd, limit, offset)});
  }
  if (req.method === 'GET' && u.pathname === '/api/v1/terminals')
    return send(200, {data: ctx.terminals.list()});
  if (req.method === 'POST' && u.pathname === '/api/v1/terminals') {
    const b = await readJsonBody(req);
    const terminal = await ctx.terminals.create(
      String(b.workspaceId ?? ''),
      String(b.relativeCwd ?? '.'),
      Number(b.cols ?? 80),
      Number(b.rows ?? 24)
    );
    return send(201, {data: terminal});
  }
  if (parts[2] === 'terminals') {
    const id = parts[3];
    if (req.method === 'GET' && parts.length === 4) return send(200, {data: ctx.terminals.get(id).record});
    if (req.method === 'DELETE' && parts.length === 4) {
      ctx.terminals.close(id);
      return send(200, {data: {closed: true}});
    }
  }
  return false;
}

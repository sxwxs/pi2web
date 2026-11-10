import type http from 'node:http';
import type {MetadataStore} from '../metadata-store.js';
import type {PromptTemplateStore} from '../prompt-templates.js';
import type {FollowUpAdvisor} from '../follow-up-advisor.js';
import type {AgentManager} from '../agents.js';
import {json} from './utils.js';

export type PromptLibraryRouteContext = {
  metadata: MetadataStore;
  promptTemplates: PromptTemplateStore;
  followUp: FollowUpAdvisor;
  agents: AgentManager;
  body(): Promise<any>;
};

/**
 * What a person reuses in the composer:
 * - `/api/v1/prompt-history`: inputs sent from any browser of this backend, newest first.
 * - `/api/v1/prompt-templates[/:name]`: Pi's global prompt templates (`~/.pi/agent/prompts/*.md`).
 * - `/api/v1/follow-up-advisor`: settings of the reply suggestions made after a run settles, and
 *   `DELETE /api/v1/agents/:id/follow-up-advice` to dismiss one.
 * Returns false when the request is not a prompt library route.
 */
export async function handlePromptLibraryRoutes(
  ctx: PromptLibraryRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL,
  parts: string[]
): Promise<boolean> {
  const send = (status: number, data: unknown) => {
    json(res, status, data);
    return true;
  };
  if (req.method === 'GET' && u.pathname === '/api/v1/prompt-history')
    return send(200, {
      data: {items: ctx.metadata.listPromptHistory(Number(u.searchParams.get('limit') ?? 0))}
    });
  if (u.pathname === '/api/v1/follow-up-advisor') {
    if (req.method === 'GET')
      return send(200, {
        data: {settings: ctx.followUp.getSettings(), apiKeyConfigured: ctx.followUp.apiKeyConfigured}
      });
    if (req.method === 'PUT') {
      const settings = ctx.followUp.updateSettings(await ctx.body());
      ctx.metadata.setSetting('followUpAdvisor', settings);
      return send(200, {data: {settings, apiKeyConfigured: ctx.followUp.apiKeyConfigured}});
    }
  }
  if (
    req.method === 'DELETE' &&
    parts[2] === 'agents' &&
    parts[4] === 'follow-up-advice' &&
    parts.length === 5
  ) {
    const agentId = decodeURIComponent(parts[3]);
    ctx.agents.get(agentId);
    ctx.followUp.clear(agentId);
    return send(200, {data: {dismissed: true}});
  }
  if (parts[2] !== 'prompt-templates') return false;
  const store = ctx.promptTemplates;
  if (parts.length === 3 && req.method === 'GET') return send(200, {data: {dir: store.dir, ...store.list()}});
  if (parts.length !== 4) return false;
  const name = decodeURIComponent(parts[3]);
  if (req.method === 'GET') return send(200, {data: store.get(name)});
  if (req.method === 'PUT') {
    const b = await ctx.body();
    if (b.editing !== undefined && b.editing !== null && typeof b.editing !== 'string')
      throw Object.assign(new Error('editing must be a string'), {code: 'INVALID_REQUEST'});
    return send(200, {
      data: store.save(name, b, {editing: b.editing || undefined, overwrite: b.overwrite === true})
    });
  }
  if (req.method === 'DELETE') {
    store.remove(name);
    return send(200, {data: {deleted: true}});
  }
  return false;
}

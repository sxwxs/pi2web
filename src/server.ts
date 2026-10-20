import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';
import {AuthStore} from './auth.js';
import {WorkspaceStore, type Workspace} from './workspaces.js';
import {AgentManager} from './agents.js';
import {createSdkBackend} from './sdk-backend.js';
import {TerminalManager} from './terminals.js';
import {MetadataStore} from './metadata-store.js';
import {VoiceManager} from './voice.js';
import {SessionNamer} from './session-namer.js';
import {MailNotifier, type MailNotificationSettings} from './mail-notifier.js';
import {CollabHub} from './collab/hub.js';
import {CollabStore} from './collab/store.js';
import {CollabRouter} from './collab/routes.js';
import {CollabDispatcher} from './collab/dispatcher.js';
import {DraftHub} from './drafts.js';
import {AGENT_TEMPLATES_DIR, defaultDataDir} from './paths.js';
import {AgentTemplateStore} from './agent-templates.js';
import type {CollabAction, CollabToolBridge} from './collab/pi-extension.js';
import {SessionManager, VERSION as PI_VERSION} from '@earendil-works/pi-coding-agent';
import pkg from '../package.json' with {type: 'json'};
import {
  LOOPBACK_HOSTS,
  errorStatus,
  isLoopbackHost,
  json,
  readBinaryBody,
  readJsonBody
} from './http/utils.js';
import {serveWebAsset} from './http/web-assets.js';
import {LoginLimiter} from './http/login-limiter.js';
import {handleAgentSocket} from './ws/agent-socket.js';
import {handleTerminalSocket} from './ws/terminal-socket.js';
import {handleAgentRoutes} from './http/agent-routes.js';
import {handleMailSettingsRoutes} from './http/mail-settings-routes.js';
import {handleWorkspaceRoutes} from './http/workspace-routes.js';
import {handleSystemPromptRoutes} from './http/system-prompt-routes.js';
export type ServerOptions = {
  host?: string;
  port?: number;
  noAuth?: boolean;
  allowInsecureNoAuth?: boolean;
  dataDir?: string;
  workspaces?: WorkspaceStore;
  agents?: AgentManager;
  terminals?: TerminalManager;
  voice?: VoiceManager;
  sessionNamer?: SessionNamer;
  mailNotifier?: MailNotifier;
};
export {LOOPBACK_HOSTS};
export class RemotePiServer {
  server: http.Server;
  wss: WebSocketServer;
  auth: AuthStore;
  workspaces: WorkspaceStore;
  agents: AgentManager;
  terminals: TerminalManager;
  metadata: MetadataStore;
  templates: AgentTemplateStore;
  collab!: CollabHub;
  private collabRouter!: CollabRouter;
  private collabDispatcher!: CollabDispatcher;
  private unsubscribeCollab?: () => void;
  private collabStallTimer?: ReturnType<typeof setInterval>;
  private collabMailAt = new Map<string, number>();
  private readonly collabMailCooldownMs = 5 * 60_000;
  private opts: Required<Pick<ServerOptions, 'host' | 'port'>>;
  private readonly noAuth: boolean;
  private readonly allowInsecureNoAuth: boolean;
  private dataDir: string;
  private clients = new Set<WebSocket>();
  drafts = new DraftHub();
  private unsubscribeMetadata?: () => void;
  private sessionIndexTimes = new Map<string, number>();
  private sessionIndexJobs = new Map<string, Promise<void>>();
  private agentIndexJobs = new Map<string, Promise<void>>();
  private voice?: VoiceManager;
  private sessionNamer?: SessionNamer;
  private mailNotifier?: MailNotifier;
  private loginLimiter = new LoginLimiter();
  constructor(options: ServerOptions = {}) {
    this.opts = {host: options.host ?? '127.0.0.1', port: options.port ?? 11318};
    this.noAuth = options.noAuth ?? false;
    this.allowInsecureNoAuth = options.allowInsecureNoAuth ?? false;
    this.dataDir = options.dataDir ?? defaultDataDir();
    this.auth = new AuthStore(this.dataDir);
    this.metadata = new MetadataStore(this.dataDir);
    this.templates = new AgentTemplateStore(path.join(this.dataDir, AGENT_TEMPLATES_DIR));
    this.workspaces = options.workspaces ?? new WorkspaceStore();
    this.voice = options.voice;
    this.sessionNamer = options.sessionNamer;
    this.mailNotifier = options.mailNotifier;
    this.collab = new CollabHub(new CollabStore(() => this.metadata.connection), {
      agentStatus: agentId => this.agentStatus(agentId)
    });
    this.agents =
      options.agents ??
      new AgentManager(this.workspaces, (agentId, cwd, sessionFile, profile, backendOptions) =>
        createSdkBackend(
          agentId,
          cwd,
          sessionFile,
          profile,
          profile === 'collab' ? this.collabToolBridge() : undefined,
          backendOptions
        )
      );
    this.terminals = options.terminals ?? new TerminalManager(this.workspaces);
    this.collabRouter = new CollabRouter(this.collab, {
      resolveCwd: (workspaceId, relativeCwd) => this.resolveWorkspaceCwd(workspaceId, relativeCwd),
      verifyHuman: token => this.auth.verify(token),
      noAuth: this.noAuth,
      isCollabAgent: agentId => this.isCollabAgent(agentId)
    });
    this.collabDispatcher = new CollabDispatcher(this.collab, {
      command: (agentId, kind, message) => this.agents.command(agentId, kind, message),
      agentStatus: agentId => this.agentStatus(agentId),
      isCollabAgent: agentId => this.isCollabAgent(agentId),
      log: message => console.error(message)
    });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({noServer: true, maxPayload: 2 * 1024 * 1024});
    this.server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket, head));
    this.wss.on('connection', (ws, req) => {
      const match = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname.match(
        /^\/api\/v1\/terminals\/([^/]+)\/ws$/
      );
      if (match)
        handleTerminalSocket(
          {terminals: this.terminals, clients: this.clients},
          ws,
          decodeURIComponent(match[1])
        );
      else
        handleAgentSocket(
          {
            agents: this.agents,
            drafts: this.drafts,
            collab: this.collab,
            voice: this.voice,
            sessionNamer: this.sessionNamer,
            clients: this.clients
          },
          ws
        );
    });
  }
  async start() {
    if (this.allowInsecureNoAuth && !this.noAuth)
      throw Object.assign(
        new Error('allowInsecureNoAuth requires noAuth (--allow-insecure-no-auth requires --no-auth)'),
        {code: 'INVALID_OPTIONS'}
      );
    if (this.noAuth && !this.allowInsecureNoAuth && !LOOPBACK_HOSTS.includes(this.opts.host))
      throw Object.assign(
        new Error(
          'noAuth requires a loopback host (127.0.0.1, ::1 or localhost); use --allow-insecure-no-auth (allowInsecureNoAuth: true) to explicitly allow remote access without authentication'
        ),
        {code: 'INVALID_BIND_ADDRESS'}
      );
    if (this.allowInsecureNoAuth)
      console.warn(
        'WARNING: --allow-insecure-no-auth disables loopback bind and Host/Origin restrictions. Anyone who can reach this server, including through a web page, can access workspaces and control agents and terminals without a pairing code. Use only on a trusted, access-controlled network.'
      );
    const first: {token?: string} = this.noAuth ? {} : await this.auth.init();
    this.metadata.init();
    this.collab.init();
    this.unsubscribeCollab = this.collab.subscribe(event => this.collabNotification(event));
    this.collabStallTimer = setInterval(() => {
      try {
        this.collab.checkStalls();
      } catch (error) {
        console.error(`Collaboration stall check failed: ${(error as Error).message}`);
      }
    }, 60_000);
    this.collabStallTimer.unref?.();
    if (this.mailNotifier) {
      const settings = this.metadata.getSetting<Partial<MailNotificationSettings>>('mailNotifications');
      if (settings)
        try {
          this.mailNotifier.updateSettings(settings);
        } catch (error) {
          console.error(`Ignoring invalid stored mail notification settings: ${(error as Error).message}`);
        }
    }
    await this.loadMetadata();
    // Only now: resuming a queued wake-up calls agents.command(), which fails with "unknown agent" until the
    // persisted agents have been restored, and a failed dispatch is logged, not retried.
    this.collabDispatcher.start();
    this.unsubscribeMetadata = this.agents.subscribeAll((agentId, event) => {
      const record = this.agents.get(agentId).record;
      const applyName = async (name: string) => {
        if (this.agents.get(agentId).record.sessionName?.trim()) return;
        await this.agents.setSessionName(agentId, name);
        this.metadata.saveAgent(this.agents.get(agentId).record);
      };
      // The namer owns naming whenever it is enabled, so the voice summary never races it for the same name.
      this.sessionNamer?.handleAgentEvent(agentId, event.event, {
        sessionName: record.sessionName,
        setSessionName: applyName
      });
      this.voice?.handleAgentEvent(agentId, event.event, {
        sessionName: record.sessionName,
        ...(this.sessionNamer ? {} : {setSessionName: applyName})
      });
      this.mailNotifier?.handleAgentEvent(agentId, event.event, {
        sessionName: record.sessionName,
        workspaceLabel: this.workspaces.get(record.workspaceId)?.label,
        cwd: record.cwd
      });
      if (
        ['message_end', 'agent_end', 'agent_settled', 'session_info_changed'].includes(
          String(event.event.type)
        )
      ) {
        const record = this.agents.get(agentId).record;
        this.metadata.scheduleAgent(record);
        if (['agent_end', 'agent_settled', 'session_info_changed'].includes(String(event.event.type)))
          void this.indexAgentSession(agentId);
      }
    });
    if (first.token) console.log(`Remote Pi pairing code (shown once; save it securely): ${first.token}`);
    await new Promise<void>(r => this.server.listen(this.opts.port, this.opts.host, r));
    return this.address();
  }
  address() {
    const a = this.server.address();
    return typeof a === 'object' && a ? {host: this.opts.host, port: a.port} : undefined;
  }
  /** URL an agent running on this machine can use to reach the hub. Wildcard binds are rewritten to loopback. */
  private publicBaseUrl() {
    const port = this.address()?.port ?? this.opts.port,
      host = ['0.0.0.0', '::', '::1', ''].includes(this.opts.host) ? '127.0.0.1' : this.opts.host;
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }
  /** Lifecycle of a local Agent; undefined once it no longer exists. The hub uses it to tell "still working" from "never answered". */
  private agentStatus(agentId: string) {
    try {
      return this.agents.get(agentId).record.status;
    } catch {
      return undefined;
    }
  }
  /** A collaboration seat is only ever bound to an existing `profile=collab` Agent: anything else can never be woken. */
  private isCollabAgent(agentId: string) {
    try {
      return this.agents.get(agentId).record.profile === 'collab';
    } catch {
      return false;
    }
  }
  /** Pi extension bridge. It intentionally calls the hub in-process, so model context never contains tokens or URLs. */
  private collabToolBridge(): CollabToolBridge {
    return {
      getTask: async agentId => this.collab.claimTaskForAgent(agentId),
      submit: async (agentId, action, payload) => this.submitCollabTool(agentId, action, payload)
    };
  }
  private async submitCollabTool(agentId: string, action: CollabAction, payload: Record<string, unknown>) {
    const participant = this.collab.participantForAgent(agentId);
    switch (action) {
      case 'ready':
        return this.collab.markImplementationReady(participant, payload);
      case 'findings':
        return this.collab.submitFindings(participant, payload);
      case 'issue_votes':
        return this.collab.submitIssueVotes(participant, payload);
      case 'merge_votes':
        return this.collab.submitMergeVotes(participant, payload);
      case 'issue_discussions':
        return this.collab.submitIssueDiscussions(participant, payload);
      case 'nominations':
        return this.collab.submitNominations(participant, payload);
      case 'votes':
        return this.collab.submitVotes(participant, payload);
      case 'scores':
        return this.collab.submitScores(participant, payload);
      case 'escalate':
        return this.collab.raiseEscalation(participant, payload);
      case 'withdraw': {
        const issueId = String(payload.issueId ?? '');
        delete payload.issueId;
        return this.collab.withdrawIssue(participant, issueId);
      }
      case 'debate_argument': {
        const debateId = String(payload.debateId ?? '');
        delete payload.debateId;
        return this.collab.submitDebateArgument(participant, debateId, payload);
      }
      case 'debate_arguments':
        return this.collab.submitDebateArguments(participant, payload);
    }
  }
  /** Escalations and stalls block the whole session, so a human is mailed the moment one appears. */
  private collabNotification(event: import('./collab/types.js').CollabEvent) {
    if (!this.mailNotifier) return;
    try {
      if (event.type === 'escalation_raised') {
        // Agents can raise escalations on their own, so one runaway session must not be able to flood the mailbox.
        if (!this.allowCollabMail(event.sessionId)) return;
        const escalation = this.collab.getEscalation(String(event.payload.escalationId ?? '')),
          session = this.collab.getSession(event.sessionId);
        const lines = [
          `协作会话：${session.title}（${session.kind}，phase=${session.phase}，round=${session.round}）`,
          `类型：${escalation.kind}｜紧急度：${escalation.urgency}`,
          `发起者：${escalation.raisedBy}`,
          '',
          `摘要：${escalation.summary}`,
          `待裁定问题：${escalation.question}`
        ];
        if (escalation.options.length) lines.push(`候选方案：${escalation.options.join(' / ')}`);
        if (escalation.positions.length)
          lines.push(
            '',
            '各方立场：',
            ...escalation.positions.map(
              position => `- ${position.participantId}（${position.stance}）：${position.rationale}`
            )
          );
        lines.push(
          '',
          `处理入口：${this.publicBaseUrl()}/collab.html?session=${session.sessionId}`,
          `API：POST /api/v1/collab/escalations/${escalation.escalationId}/resolve`
        );
        this.mailNotifier.notifyCollab({
          subject: `[Remote Pi] 协作会话需要人工裁定：${session.title}`,
          text: lines.join('\n')
        });
        return;
      }
      if (event.type === 'participant_overdue') {
        if (!this.allowCollabMail(event.sessionId)) return;
        const session = this.collab.getSession(event.sessionId),
          waiting = (event.payload.waitingOn as string[] | undefined) ?? [];
        const neverCollected = event.payload.reason === 'task_never_collected';
        this.mailNotifier.notifyCollab({
          subject: `[Remote Pi] 协作会话停滞：${session.title}`,
          text: [
            `协作会话：${session.title}（${session.kind}，phase=${session.phase}，round=${session.round}）`,
            neverCollected
              ? '任务已派发但从未送达：绑定的本机 Agent 可能已被删除或卡住，请在看板上把这个座位改绑到另一个 Agent。'
              : `已等待：${Math.round(Number(event.payload.overdueBySec ?? 0))} 秒`,
            `未提交的参与者：${waiting.join(', ') || '（未知）'}`,
            '',
            '中枢不会自动跳过任何人；如需推进请强制推进并说明理由。',
            `处理入口：${this.publicBaseUrl()}/collab.html?session=${session.sessionId}`
          ].join('\n')
        });
      }
    } catch (error) {
      console.error(`Collaboration mail notification failed: ${(error as Error).message}`);
    }
  }
  /** One collaboration mail per session per cooldown window; anything suppressed is still visible on the board. */
  private allowCollabMail(sessionId: string) {
    const last = this.collabMailAt.get(sessionId) ?? 0,
      now = Date.now();
    if (now - last < this.collabMailCooldownMs) {
      console.error(
        `Collaboration mail for session ${sessionId} suppressed by the cooldown window; see /collab.html?session=${sessionId}`
      );
      return false;
    }
    this.collabMailAt.set(sessionId, now);
    if (this.collabMailAt.size > 500)
      for (const [key, at] of this.collabMailAt)
        if (now - at > this.collabMailCooldownMs) this.collabMailAt.delete(key);
    return true;
  }
  async stop() {
    if (this.collabStallTimer) clearInterval(this.collabStallTimer);
    this.collabStallTimer = undefined;
    this.unsubscribeCollab?.();
    this.unsubscribeCollab = undefined;
    await this.collabDispatcher.stop();
    this.collab.shutdown();
    this.unsubscribeMetadata?.();
    this.unsubscribeMetadata = undefined;
    this.voice?.close();
    this.sessionNamer?.close();
    await this.mailNotifier?.close();
    await Promise.allSettled([...this.sessionIndexJobs.values(), ...this.agentIndexJobs.values()]);
    this.metadata.flush();
    for (const c of this.clients) c.close();
    for (const a of this.agents.list()) await this.agents.dispose(a.agentId).catch(() => {});
    this.terminals.closeAll();
    this.wss.close();
    await new Promise<void>(r => this.server.close(() => r()));
    this.metadata.close();
  }
  private async upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const protocol = req.headers['sec-websocket-protocol'];
    const wsToken = Array.isArray(protocol)
      ? protocol.find(x => x.startsWith('access-token.'))?.slice(13)
      : protocol
          ?.split(',')
          .map(x => x.trim())
          .find(x => x.startsWith('access-token.'))
          ?.slice(13);
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname,
      isSocket = pathname === '/api/v1/ws' || /^\/api\/v1\/terminals\/[^/]+\/ws$/.test(pathname);
    if (!isSocket) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.noAuth && !this.allowInsecureNoAuth && !this.localRequest(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = this.clientKey(req),
      retryAfter = this.loginLimiter.retryAfterMs(key);
    if (retryAfter > 0) {
      socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${Math.ceil(retryAfter / 1000)}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const role =
      (await this.authRole(req.headers.authorization)) ??
      (wsToken ? await this.auth.role(wsToken) : undefined);
    if (!role) {
      this.loginLimiter.recordFailure(key);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (role === 'voice') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.loginLimiter.clear(key);
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
  }
  private clientKey(req: http.IncomingMessage) {
    return req.socket.remoteAddress ?? 'unknown';
  }
  private async loadMetadata() {
    let workspaces = this.metadata.listWorkspaces();
    if (!workspaces.length) {
      for (const workspace of this.workspaces.list()) this.metadata.saveWorkspace(workspace);
      workspaces = this.metadata.listWorkspaces();
    }
    this.workspaces.replace(workspaces);
    let agents = this.metadata.listAgents();
    if (!agents.length) {
      for (const agent of this.agents.list()) this.metadata.saveAgent(agent);
      agents = this.metadata.listAgents();
    }
    await this.agents.restore(agents);
  }
  private async ensureSessionIndex(workspace: Workspace, cwd: string, force = false) {
    const key = `${workspace.id}:${cwd}`,
      last = this.sessionIndexTimes.get(key) ?? 0;
    if (!force && Date.now() - last < 30000) return;
    const existing = this.sessionIndexJobs.get(key);
    if (existing) return existing;
    const job = (async () => {
      const sessions = await SessionManager.list(cwd);
      this.metadata.syncSessions(workspace.id, cwd, sessions);
      this.sessionIndexTimes.set(key, Date.now());
    })().finally(() => this.sessionIndexJobs.delete(key));
    this.sessionIndexJobs.set(key, job);
    return job;
  }
  private async indexAgentSession(agentId: string) {
    const existing = this.agentIndexJobs.get(agentId);
    if (existing) return existing;
    const job = (async () => {
      try {
        const record = this.agents.get(agentId).record,
          summary = await this.agents.sessionInfo(agentId);
        this.metadata.upsertSessionFromAgent(record, summary);
        this.metadata.scheduleAgent(record);
      } catch {
        /* Session files may not exist until the first assistant response is persisted. */
      }
    })().finally(() => this.agentIndexJobs.delete(agentId));
    this.agentIndexJobs.set(agentId, job);
    return job;
  }
  private async resolveWorkspaceCwd(workspaceId: string, relativeCwd: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
    return this.workspaces.resolve(workspace, relativeCwd || '.');
  }
  /** Without a pairing code the only boundary left is the browser's: loopback Host and, if sent, a loopback Origin. */
  private localRequest(req: http.IncomingMessage) {
    if (!isLoopbackHost(String(req.headers.host ?? ''))) return false;
    const origin = String(req.headers.origin ?? '');
    if (!origin) return true;
    try {
      return isLoopbackHost(new URL(origin).host);
    } catch {
      return false;
    }
  }
  private async authRole(value?: string) {
    if (this.noAuth) return 'full' as const;
    return value?.startsWith('Bearer ') ? this.auth.role(value.slice(7)) : undefined;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    if (this.noAuth) {
      if (!this.allowInsecureNoAuth && !this.localRequest(req))
        return json(res, 403, {
          error: {
            code: 'FORBIDDEN',
            message: 'Without authentication only loopback requests are served',
            requestId
          }
        });
      if (req.headers.origin) res.setHeader('access-control-allow-origin', String(req.headers.origin));
    } else res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'Authorization,Content-Type,X-Audio-Filename');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }
      const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && (await serveWebAsset(u.pathname, req, res, {noAuth: this.noAuth}))) return;
      if (req.method === 'GET' && u.pathname === '/health')
        return json(res, 200, {data: {status: 'ok', authRequired: !this.noAuth}});
      const parts = u.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && u.pathname === '/api/v1/auth/login') {
        const key = this.clientKey(req),
          retryAfter = this.loginLimiter.retryAfterMs(key);
        if (retryAfter > 0) {
          res.setHeader('retry-after', String(Math.ceil(retryAfter / 1000)));
          return json(res, 429, {
            error: {
              code: 'TOO_MANY_ATTEMPTS',
              message: `Too many failed pairing attempts. Retry in ${Math.ceil(retryAfter / 1000)} seconds`,
              requestId
            }
          });
        }
        const b = await readJsonBody(req);
        if (await this.auth.verify(String(b.token ?? ''))) {
          this.loginLimiter.clear(key);
          return json(res, 200, {data: {authenticated: true}});
        }
        const lockedFor = this.loginLimiter.recordFailure(key);
        if (lockedFor > 0) res.setHeader('retry-after', String(Math.ceil(lockedFor / 1000)));
        return json(res, 401, {error: {code: 'UNAUTHORIZED', message: 'Invalid token', requestId}});
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'collab') {
        const key = this.clientKey(req),
          retryAfter = this.loginLimiter.retryAfterMs(key);
        if (retryAfter > 0) {
          res.setHeader('retry-after', String(Math.ceil(retryAfter / 1000)));
          return json(res, 429, {
            error: {
              code: 'TOO_MANY_ATTEMPTS',
              message: `Too many failed attempts. Retry in ${Math.ceil(retryAfter / 1000)} seconds`,
              requestId
            }
          });
        }
        const header = String(req.headers.authorization ?? ''),
          token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const result = await this.collabRouter.handle({
          method: req.method ?? 'GET',
          url: u,
          parts,
          token,
          body: () => readJsonBody(req)
        });
        if (!result) return json(res, 404, {error: {code: 'NOT_FOUND', message: 'Not found', requestId}});
        if (result.authFailed) this.loginLimiter.recordFailure(key);
        else this.loginLimiter.clear(key);
        return json(res, result.status, result.payload);
      }
      const role = await this.authRole(req.headers.authorization);
      if (!role)
        return json(res, 401, {error: {code: 'UNAUTHORIZED', message: 'Authentication required', requestId}});
      if (
        role === 'voice' &&
        !(
          (req.method === 'POST' && u.pathname === '/api/v1/draft') ||
          (req.method === 'GET' && u.pathname === '/api/v1/system/status')
        )
      )
        return json(res, 403, {
          error: {code: 'FORBIDDEN', message: 'This token cannot access this endpoint', requestId}
        });
      if (req.method === 'POST' && u.pathname === '/api/v1/draft') {
        const b = await readJsonBody(req),
          text = typeof b?.text === 'string' ? b.text : '';
        if (!text.trim())
          return json(res, 400, {error: {code: 'INVALID_REQUEST', message: 'text is required', requestId}});
        if (text.length > 20000)
          return json(res, 413, {error: {code: 'REQUEST_TOO_LARGE', message: 'text is too long', requestId}});
        if (b.agentId !== undefined || b.target !== undefined)
          return json(res, 400, {
            error: {code: 'INVALID_REQUEST', message: 'draft targets are not supported', requestId}
          });
        if (b.mode !== undefined && b.mode !== 'append' && b.mode !== 'replace')
          return json(res, 400, {
            error: {code: 'INVALID_REQUEST', message: 'mode must be append or replace', requestId}
          });
        const {draft, delivered} = this.drafts.add({
          text,
          mode: b.mode ?? 'append',
          source: typeof b.source === 'string' ? b.source.slice(0, 32) : undefined
        });
        return json(res, 200, {data: {id: draft.id, mode: draft.mode, delivered, queued: true}});
      }
      if (req.method === 'GET' && u.pathname === '/api/v1/system/status')
        return json(res, 200, {
          data: {
            version: pkg.version,
            protocolVersion: 1,
            authRequired: !this.noAuth,
            piVersion: PI_VERSION,
            nodeVersion: process.version,
            uptimeSeconds: Math.floor(process.uptime()),
            agentCount: this.agents.list().length,
            terminalCount: this.terminals.list().length,
            webSocketConnections: this.clients.size,
            voiceEnabled: !!this.voice,
            voiceCapabilities: this.voice?.capabilities() ?? {tts: false, stt: false},
            sessionNamingEnabled: !!this.sessionNamer,
            mailNotificationsConfigured: !!this.mailNotifier,
            mailNotificationsEnabled: this.mailNotifier?.getSettings().enabled ?? false
          }
        });
      if (
        await handleMailSettingsRoutes(
          {mailNotifier: this.mailNotifier, metadata: this.metadata},
          req,
          res,
          u
        )
      )
        return;
      const workspaceContext = {
        workspaces: this.workspaces,
        terminals: this.terminals,
        metadata: this.metadata,
        ensureSessionIndex: (workspace: Workspace, cwd: string, force?: boolean) =>
          this.ensureSessionIndex(workspace, cwd, force)
      };
      if (await handleWorkspaceRoutes(workspaceContext, req, res, u, parts, requestId)) return;
      if (
        await handleSystemPromptRoutes(
          {agents: this.agents, templates: this.templates, body: () => readJsonBody(req)},
          req,
          res,
          u,
          parts
        )
      )
        return;
      const agentContext = {
        agents: this.agents,
        templates: this.templates,
        metadata: this.metadata,
        workspaces: this.workspaces,
        voice: this.voice,
        sessionNamer: this.sessionNamer,
        ensureSessionIndex: (workspace: Workspace, cwd: string, force?: boolean) =>
          this.ensureSessionIndex(workspace, cwd, force),
        indexAgentSession: (agentId: string) => this.indexAgentSession(agentId),
        body: () => readJsonBody(req),
        binaryBody: () => readBinaryBody(req)
      };
      if (await handleAgentRoutes(agentContext, req, res, u, parts)) return;
      return json(res, 404, {error: {code: 'NOT_FOUND', message: 'Not found', requestId}});
    } catch (e) {
      const x = e as any;
      return json(res, errorStatus(x.code), {
        error: {code: x.code ?? 'BAD_REQUEST', message: x.message ?? 'Request failed', requestId}
      });
    }
  }
}

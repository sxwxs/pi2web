import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {StringEnum} from '@earendil-works/pi-ai';
import {Type} from 'typebox';
import type {
  ControlWorkerAction,
  ControlWorkerInput,
  CreateWorkerInput,
  ReadSessionInput,
  SearchSessionsInput,
  SendWorkerInput
} from './service.js';
import type {ScheduleTaskInput} from '../schedules.js';

/**
 * In-process bridge owned by the pi2web server for `profile=orchestrator` Agents.
 * No pairing code or HTTP endpoint enters model context.
 */
export type OrchestratorToolBridge = {
  listWorkspaces: () => unknown;
  listModels: (input: {workspaceId?: string; relativeCwd?: string; cwd?: string}) => Promise<unknown>;
  listTemplates: () => unknown;
  listAgents: (
    callerId: string,
    filter: {status?: string; workspaceId?: string; cwd?: string; profile?: string; includeSelf?: boolean}
  ) => unknown;
  searchSessions: (callerId: string, input: SearchSessionsInput) => Promise<unknown>;
  readSession: (input: ReadSessionInput) => Promise<unknown>;
  createWorker: (callerId: string, input: CreateWorkerInput) => Promise<unknown>;
  sendMessage: (callerId: string, input: SendWorkerInput) => Promise<unknown>;
  watchAgents: (
    callerId: string,
    input: {
      action: 'list' | 'watch' | 'unwatch';
      agentId?: string;
      group?: string;
      label?: string;
      watchId?: string;
    }
  ) => unknown;
  controlAgent: (callerId: string, input: ControlWorkerInput) => Promise<unknown>;
  listSchedules: () => unknown;
  listScheduleRuns: (taskId?: string, limit?: number) => unknown;
  createSchedule: (callerId: string, input: ScheduleTaskInput & {cwd?: string}) => Promise<unknown>;
  updateSchedule: (
    callerId: string,
    id: string,
    patch: Partial<ScheduleTaskInput> & {cwd?: string}
  ) => Promise<unknown>;
  deleteSchedule: (id: string) => unknown;
  runScheduleNow: (id: string) => Promise<unknown>;
};

export const ORCHESTRATOR_SYSTEM_GUIDANCE = `## Pi2Web Orchestrator Role
You are a top-level Pi2Web orchestrator agent. You are not bound to a single project directory: your job is to inspect workspaces and sessions, create and coordinate project-level coding agents, synthesize multi-agent work (such as multi-model code reviews), and manage scheduled tasks.

Guidelines:
- Use your built-in read/bash tools freely for quick discovery (listing directories, checking git status/diff, inspecting files) when locating projects or verifying worker outputs.
- Delegate substantive project edits, tests, builds, and long coding tasks to dedicated code agents created via \`pi2web_create_agent\` in the appropriate workspace directory.
- Start with \`pi2web_list_workspaces\` / \`pi2web_list_agents\` when you do not yet know which workspaces or sessions exist.
- Asynchronous completion notifications:
  - Set \`notifyOnComplete: true\` on \`pi2web_create_agent\` or \`pi2web_send_message\` (or call \`pi2web_watch_agents\`) whenever you need to follow up after a worker finishes.
  - When dispatching parallel workers for the same stage (for example multiple independent reviewers), pass the same \`notifyGroup\` string so pi2web waits until every worker in that group finishes and wakes you once with all results.
  - After dispatching async workers, briefly tell the user what you launched and end your turn — do not sleep, busy-wait, or poll in bash. Pi2Web will push a \`[pi2web completion notification]\` into this conversation automatically.
- Keep session reads lightweight: \`pi2web_read_session\` returns compact summaries by default; fetch specific \`itemId\` bodies only when needed.
- For recurring automation (e.g., periodic inbox checks or daily repo reports), use the \`pi2web_*_schedule\` tools. Each scheduled run starts in a fresh empty context and archives results under its own history directory (\`runs/\`, \`latest.md\`, optional \`memory.md\`).`;

const asJsonResult = (data: unknown) => ({
  content: [{type: 'text' as const, text: JSON.stringify(data, null, 2)}],
  details: {data}
});

/** Inline-only Pi extension loaded exclusively for `profile=orchestrator` sessions. */
export function createOrchestratorExtension(agentId: string, bridge: OrchestratorToolBridge) {
  return function orchestratorExtension(pi: ExtensionAPI) {
    pi.on('before_agent_start', event => ({
      systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_SYSTEM_GUIDANCE}`
    }));

    pi.registerTool({
      name: 'pi2web_list_workspaces',
      label: 'List Workspaces',
      description: 'List all configured Pi2Web workspaces (workspaceId, label, and rootPath).',
      promptSnippet: 'List configured Pi2Web workspaces and their root directories',
      parameters: Type.Object({}, {additionalProperties: false}),
      async execute() {
        return asJsonResult({workspaces: bridge.listWorkspaces()});
      }
    });

    pi.registerTool({
      name: 'pi2web_list_models',
      label: 'List Available Models',
      description:
        'List models available in Pi (provider, id, name, reasoning) plus the current default model and Agent templates. Useful before launching multi-model workers or reviews.',
      promptSnippet: 'List available LLM models and Agent templates for creating code agents',
      parameters: Type.Object(
        {
          workspaceId: Type.Optional(
            Type.String({description: 'Optional workspaceId to scope model discovery'})
          ),
          relativeCwd: Type.Optional(Type.String({description: 'Relative path inside workspaceId'})),
          cwd: Type.Optional(Type.String({description: 'Optional absolute directory inside a workspace'}))
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        const [capabilities, templates] = await Promise.all([
          bridge.listModels(input ?? {}),
          Promise.resolve(bridge.listTemplates())
        ]);
        return asJsonResult({capabilities, templates});
      }
    });

    pi.registerTool({
      name: 'pi2web_list_agents',
      label: 'List Agents',
      description:
        'List Pi2Web agents with their current status, activity phase, cwd, sessionName, queue, follow-up outcome, and active completion watches.',
      promptSnippet: 'List current Pi2Web agents and their live status',
      parameters: Type.Object(
        {
          status: Type.Optional(
            StringEnum([
              'unloaded',
              'starting',
              'idle',
              'streaming',
              'waiting_for_user',
              'error',
              'stopping',
              'stopped'
            ] as const)
          ),
          workspaceId: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String({description: 'Filter by cwd prefix'})),
          profile: Type.Optional(StringEnum(['default', 'collab', 'orchestrator'] as const)),
          includeSelf: Type.Optional(
            Type.Boolean({description: 'Include this orchestrator agent (default false)'})
          )
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult({agents: bridge.listAgents(agentId, input ?? {})});
      }
    });

    pi.registerTool({
      name: 'pi2web_search_sessions',
      label: 'Search Sessions',
      description:
        'Search active agents and historical Pi sessions by name, cwd, first message, or (when includeContent=true) recent conversation text.',
      promptSnippet: 'Search active agents and historical Pi sessions',
      parameters: Type.Object(
        {
          query: Type.Optional(Type.String({description: 'Substring to match'})),
          workspaceId: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String({description: 'Directory path or prefix'})),
          includeContent: Type.Optional(
            Type.Boolean({description: 'Also scan recent session message text for matches (slower, bounded)'})
          ),
          limit: Type.Optional(Type.Integer({minimum: 1, maximum: 50}))
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult(await bridge.searchSessions(agentId, input ?? {}));
      }
    });

    pi.registerTool({
      name: 'pi2web_read_session',
      label: 'Read Session',
      description:
        'Read a paginated transcript summary of an active agent (by agentId) or historical Pi session (by sessionFile). Pass itemId to fetch the full body of one collapsed item (such as a tool result).',
      promptSnippet: 'Read messages and summaries from a Pi2Web agent or session file',
      parameters: Type.Object(
        {
          agentId: Type.Optional(Type.String({description: 'Active agent ID'})),
          sessionFile: Type.Optional(Type.String({description: 'Historical Pi JSONL session file path'})),
          limit: Type.Optional(
            Type.Integer({minimum: 1, maximum: 80, description: 'Items per page (default 30)'})
          ),
          before: Type.Optional(
            Type.String({description: 'Item ID for loading an older page (from nextBefore)'})
          ),
          itemId: Type.Optional(Type.String({description: 'Fetch raw body slice of a single timeline item'})),
          offset: Type.Optional(
            Type.Integer({minimum: 0, description: 'Character offset when reading a long itemId body'})
          ),
          maxChars: Type.Optional(
            Type.Integer({
              minimum: 100,
              maximum: 64000,
              description: 'Max characters to return for itemId (default 16000)'
            })
          ),
          includeToolArgs: Type.Optional(Type.Boolean({description: 'Include tool call argument JSON'})),
          includeThinking: Type.Optional(
            Type.Boolean({description: 'Include thinking blocks (default false)'})
          )
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult(await bridge.readSession(input ?? {}));
      }
    });

    pi.registerTool({
      name: 'pi2web_create_agent',
      label: 'Create Code Agent',
      description:
        'Create a new project-level code agent inside a configured workspace (by cwd or workspaceId+relativeCwd). Optionally specify model, thinkingLevel, templateId, sessionName, resume a sessionFile, and immediately launch initialPrompt with optional completion notification.',
      promptSnippet: 'Create (and optionally prompt + watch) a new project code agent',
      parameters: Type.Object(
        {
          workspaceId: Type.Optional(Type.String({description: 'Target workspace ID'})),
          relativeCwd: Type.Optional(
            Type.String({description: 'Relative path inside workspaceId (default ".")'})
          ),
          cwd: Type.Optional(
            Type.String({
              description: 'Absolute directory inside a configured workspace (auto-matches workspace)'
            })
          ),
          sessionFile: Type.Optional(Type.String({description: 'Optional existing sessionFile to resume'})),
          model: Type.Optional(
            Type.Object(
              {provider: Type.String({minLength: 1}), modelId: Type.String({minLength: 1})},
              {additionalProperties: false}
            )
          ),
          thinkingLevel: Type.Optional(Type.String()),
          templateId: Type.Optional(Type.String({description: 'Optional system prompt template ID'})),
          sessionName: Type.Optional(Type.String({description: 'Display title for the new agent'})),
          initialPrompt: Type.Optional(
            Type.String({description: 'If set, immediately send this prompt to start work'})
          ),
          notifyOnComplete: Type.Optional(
            Type.Boolean({
              description: 'Push a completion notification back here when initialPrompt finishes'
            })
          ),
          notifyGroup: Type.Optional(
            Type.String({
              description:
                'Optional barrier group name: wait until all workers in this group finish, then notify once'
            })
          ),
          notifyLabel: Type.Optional(
            Type.String({description: 'Short role/label shown in completion notifications'})
          )
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult(await bridge.createWorker(agentId, input ?? {}));
      }
    });

    pi.registerTool({
      name: 'pi2web_send_message',
      label: 'Send Message to Agent',
      description:
        'Send a prompt, follow-up, or steer message to an existing code agent. Set notifyOnComplete=true (optionally with notifyGroup) to receive an automatic completion notification when the agent finishes.',
      promptSnippet: 'Send a prompt, follow-up, or steer message to an existing code agent',
      parameters: Type.Object(
        {
          agentId: Type.String({minLength: 1}),
          message: Type.String({minLength: 1}),
          mode: Type.Optional(StringEnum(['prompt', 'follow-up', 'steer'] as const)),
          notifyOnComplete: Type.Optional(Type.Boolean()),
          notifyGroup: Type.Optional(Type.String()),
          notifyLabel: Type.Optional(Type.String())
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult(await bridge.sendMessage(agentId, input));
      }
    });

    pi.registerTool({
      name: 'pi2web_watch_agents',
      label: 'Watch Agents',
      description:
        'List, add, or cancel completion notification watches on running agents without sending a new prompt.',
      promptSnippet: 'List, subscribe, or cancel completion watches on agents',
      parameters: Type.Object(
        {
          action: StringEnum(['list', 'watch', 'unwatch'] as const),
          agentId: Type.Optional(Type.String({description: 'Target agentId (for watch or unwatch)'})),
          watchId: Type.Optional(Type.String({description: 'Specific watchId to cancel (for unwatch)'})),
          group: Type.Optional(Type.String({description: 'Optional barrier group name (for watch)'})),
          label: Type.Optional(Type.String({description: 'Optional short label (for watch)'}))
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult(bridge.watchAgents(agentId, input));
      }
    });

    pi.registerTool({
      name: 'pi2web_control_agent',
      label: 'Control Agent',
      description:
        'Control a code agent: rename, set_model, set_thinking, pause (safe pause before next LLM call), cancel_pause, abort, stop (unload from memory), or archive (only when idle/unloaded).',
      promptSnippet: 'Rename, change model/thinking, pause, abort, stop, or archive a code agent',
      parameters: Type.Object(
        {
          agentId: Type.String({minLength: 1}),
          action: StringEnum([
            'rename',
            'set_model',
            'set_thinking',
            'pause',
            'cancel_pause',
            'abort',
            'stop',
            'archive'
          ] as const),
          sessionName: Type.Optional(Type.String()),
          provider: Type.Optional(Type.String()),
          modelId: Type.Optional(Type.String()),
          thinkingLevel: Type.Optional(Type.String())
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult(
          await bridge.controlAgent(agentId, {
            ...input,
            action: input.action as ControlWorkerAction
          })
        );
      }
    });

    // ---- Scheduled task management tools ----

    pi.registerTool({
      name: 'pi2web_list_schedules',
      label: 'List Scheduled Tasks',
      description:
        'List configured scheduled Agent tasks and optionally recent run records (with archived output file paths).',
      promptSnippet: 'List scheduled Agent tasks and recent run history',
      parameters: Type.Object(
        {
          taskId: Type.Optional(Type.String({description: 'Filter run history to one taskId'})),
          includeRuns: Type.Optional(
            Type.Boolean({description: 'Include recent run history (default true)'})
          ),
          runLimit: Type.Optional(Type.Integer({minimum: 1, maximum: 100}))
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        const tasks = bridge.listSchedules();
        const includeRuns = input?.includeRuns !== false;
        const runs = includeRuns ? bridge.listScheduleRuns(input?.taskId, input?.runLimit ?? 20) : undefined;
        return asJsonResult({tasks, ...(runs ? {runs} : {})});
      }
    });

    pi.registerTool({
      name: 'pi2web_create_schedule',
      label: 'Create Scheduled Task',
      description:
        'Create a scheduled task that periodically spawns a fresh, empty-context Agent with a fixed prompt and archives every run under its own history directory (runs/, latest.md, optional memory.md).',
      promptSnippet: 'Create a recurring or one-shot scheduled Agent task',
      parameters: Type.Object(
        {
          name: Type.String({minLength: 1, maxLength: 120}),
          scheduleKind: StringEnum(['cron', 'interval', 'once'] as const),
          scheduleExpr: Type.String({
            minLength: 1,
            description: '5-field local cron ("0 9 * * 1-5"), interval ("30m", "6h", "1d"), or ISO timestamp'
          }),
          prompt: Type.String({minLength: 1, description: 'Task instructions executed on each fresh run'}),
          enabled: Type.Optional(Type.Boolean({description: 'Default true'})),
          workspaceId: Type.Optional(Type.String()),
          relativeCwd: Type.Optional(Type.String()),
          cwd: Type.Optional(
            Type.String({description: 'Optional workspace directory; omit for standalone task dir'})
          ),
          model: Type.Optional(
            Type.Object(
              {provider: Type.String({minLength: 1}), modelId: Type.String({minLength: 1})},
              {additionalProperties: false}
            )
          ),
          thinkingLevel: Type.Optional(Type.String()),
          templateId: Type.Optional(Type.String()),
          timeoutSeconds: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: 86400,
              description: 'Per-run timeout in seconds (default 1800; 0 disables timeout protection)'
            })
          ),
          notifyMode: Type.Optional(StringEnum(['none', 'mail', 'orchestrator'] as const)),
          notifyOrchestratorId: Type.Optional(
            Type.String({
              description:
                'Orchestrator agentId to notify (defaults to this orchestrator when notifyMode="orchestrator")'
            })
          )
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        return asJsonResult({task: await bridge.createSchedule(agentId, input)});
      }
    });

    pi.registerTool({
      name: 'pi2web_update_schedule',
      label: 'Update Scheduled Task',
      description:
        'Update an existing scheduled task (enable/disable, edit cron/interval, prompt, model, or notification).',
      promptSnippet: 'Modify, pause, or resume an existing scheduled Agent task',
      parameters: Type.Object(
        {
          id: Type.String({minLength: 1}),
          name: Type.Optional(Type.String({minLength: 1, maxLength: 120})),
          enabled: Type.Optional(Type.Boolean()),
          scheduleKind: Type.Optional(StringEnum(['cron', 'interval', 'once'] as const)),
          scheduleExpr: Type.Optional(Type.String({minLength: 1})),
          prompt: Type.Optional(Type.String({minLength: 1})),
          workspaceId: Type.Optional(Type.String()),
          relativeCwd: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          model: Type.Optional(
            Type.Union([
              Type.Null(),
              Type.Object(
                {provider: Type.String({minLength: 1}), modelId: Type.String({minLength: 1})},
                {additionalProperties: false}
              )
            ])
          ),
          thinkingLevel: Type.Optional(Type.Union([Type.Null(), Type.String()])),
          templateId: Type.Optional(Type.Union([Type.Null(), Type.String()])),
          timeoutSeconds: Type.Optional(Type.Integer({minimum: 0, maximum: 86400})),
          notifyMode: Type.Optional(StringEnum(['none', 'mail', 'orchestrator'] as const)),
          notifyOrchestratorId: Type.Optional(Type.Union([Type.Null(), Type.String()]))
        },
        {additionalProperties: false}
      ),
      async execute(_id, input: any) {
        const {id, ...patch} = input;
        return asJsonResult({task: await bridge.updateSchedule(agentId, id, patch)});
      }
    });

    pi.registerTool({
      name: 'pi2web_delete_schedule',
      label: 'Delete Scheduled Task',
      description: 'Delete a scheduled task definition (past archived output files on disk are kept).',
      promptSnippet: 'Delete a scheduled Agent task',
      parameters: Type.Object({id: Type.String({minLength: 1})}, {additionalProperties: false}),
      async execute(_id, input: any) {
        return asJsonResult(bridge.deleteSchedule(input.id));
      }
    });

    pi.registerTool({
      name: 'pi2web_run_schedule',
      label: 'Run Scheduled Task Now',
      description: 'Trigger an immediate fresh run of a scheduled task.',
      promptSnippet: 'Run a scheduled Agent task immediately',
      parameters: Type.Object({id: Type.String({minLength: 1})}, {additionalProperties: false}),
      async execute(_id, input: any) {
        return asJsonResult({run: await bridge.runScheduleNow(input.id)});
      }
    });
  };
}

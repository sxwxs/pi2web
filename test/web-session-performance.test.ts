import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const factory = source.slice(
  source.indexOf('  const el = (tag, props'),
  source.indexOf('  function modal(', source.indexOf('  const el = (tag, props'))
);
const view = source.slice(
  source.indexOf('  const performanceTime ='),
  source.indexOf('  async function showSessionTree()')
);

function render(data: object) {
  const node = (tag: string) => ({
    tag,
    children: [] as any[],
    style: {} as Record<string, string>,
    append(...children: any[]) {
      this.children.push(...children);
    }
  });
  const root = node('root');
  const modal = vi.fn(async (_title, build) => build(root));
  const showSessionPerformance = runInNewContext(`${factory}\n${view}\nshowSessionPerformance`, {
    state: {agent: {agentId: 'bk:agent'}},
    requestAgent: vi.fn(async () => data),
    document: {createElement: node},
    modal,
    toast: vi.fn()
  }) as () => Promise<void>;
  return {root, modal, showSessionPerformance};
}

describe('session performance dialog', () => {
  it('renders empty history without an out-of-scope element factory', async () => {
    const ui = render({runs: [], legacyTools: []});
    await ui.showSessionPerformance();
    expect(ui.modal).toHaveBeenCalledWith('会话耗时分析', expect.any(Function), '关闭');
    expect(ui.root.children.some(child => child.textContent?.includes('没有可分析'))).toBe(true);
  });

  it('renders model and parallel tool bars in a completed run', async () => {
    const ui = render({
      runs: [
        {
          start: 1000,
          end: 2000,
          spans: [
            {kind: 'model', start: 1000, firstResponse: 1200, end: 1500, outputTokens: 30},
            {kind: 'tool', name: 'read', start: 1500, end: 1900},
            {kind: 'tool', name: 'bash', start: 1600, end: 1800}
          ]
        }
      ],
      legacyTools: []
    });
    await ui.showSessionPerformance();
    const list = ui.root.children.find(child => child.className === 'performance-list');
    const run = list.children.find(child => child.tag === 'details');
    expect(run.children.filter(child => child.className === 'performance-row')).toHaveLength(3);
    expect(run.children[1].children[0].textContent).toContain('首响应');
    expect(run.children[1].children[0].textContent).toContain('输出 30 token · 均速 100.0 token/s');
    expect(run.children[2].children[1].children[0].style.left).toBe('50%');
    expect(run.children[3].children[1].children[0].style.left).toBe('60%');
  });
});

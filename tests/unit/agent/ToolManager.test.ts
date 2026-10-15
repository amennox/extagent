import { ToolManager } from '../../../src/agent/ToolManager';

describe('ToolManager', () => {
  const tools = [
    { name: 'a', description: 'A', func: jest.fn(async () => 'ok-a') },
    { name: 'b', description: 'B', func: jest.fn(async () => 'ok-b') },
  ];

  it('finds tools by name without wrapping them', async () => {
    const page: any = { evaluate: jest.fn() };
    const tm = new ToolManager(page, tools as any);
    expect(tm.getTools()).toHaveLength(2);
    expect(tm.findTool('b')).toBe(tools[1]);
    expect(tm.findTool('zzz')).toBeUndefined();
    expect(await tm.findTool('a')!.func('x')).toBe('ok-a');
    // No health-check round-trip before each tool
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(tm.getPage()).toBe(page);
  });

  it('reports connection health', async () => {
    const ok = new ToolManager({ evaluate: jest.fn().mockResolvedValue(true) } as any, []);
    const ko = new ToolManager({ evaluate: jest.fn().mockRejectedValue(new Error('Target closed')) } as any, []);
    expect(await ok.isConnectionHealthy()).toBe(true);
    expect(await ko.isConnectionHealthy()).toBe(false);
  });
});

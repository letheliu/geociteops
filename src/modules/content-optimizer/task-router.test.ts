import { describe, it, expect, vi, beforeEach } from 'vitest'
import { taskRouter } from './task-router.js'

function createCaller(ctx: any) {
  return taskRouter.createCaller(ctx)
}

describe('task router', () => {
  const mockTaskService = {
    list: vi.fn().mockResolvedValue([{ id: 'task-1', status: 'PENDING' }]),
    getById: vi.fn().mockResolvedValue({ id: 'task-1', status: 'PENDING' }),
    review: vi.fn().mockResolvedValue({ id: 'task-1', status: 'REVIEWED' }),
    publish: vi.fn().mockResolvedValue({ id: 'task-1', status: 'PUBLISHED' }),
  }

  const ctx = {
    workspace: { id: 'w1', status: 'ACTIVE' },
    // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
    actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'w1' } },
    requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
    services: { taskService: mockTaskService },
  } as any

  beforeEach(() => vi.clearAllMocks())

  it('list 按 workspace 查询任务', async () => {
    const caller = createCaller(ctx)
    const result = await caller.list()
    expect(mockTaskService.list).toHaveBeenCalledWith('w1', undefined)
    expect(result).toHaveLength(1)
  })

  it('list 按状态过滤', async () => {
    const caller = createCaller(ctx)
    await caller.list({ status: 'pending' })
    expect(mockTaskService.list).toHaveBeenCalledWith('w1', 'PENDING')
  })

  it('get 查询单个任务', async () => {
    const caller = createCaller(ctx)
    const result = await caller.get({ id: 'task-1' })
    expect(mockTaskService.getById).toHaveBeenCalledWith('task-1')
    expect(result.id).toBe('task-1')
  })

  it('review approve', async () => {
    const caller = createCaller(ctx)
    const result = await caller.review({ id: 'task-1', approved: true })
    expect(mockTaskService.review).toHaveBeenCalledWith('task-1', true, undefined)
    expect(result.status).toBe('REVIEWED')
  })

  it('review reject with note', async () => {
    const caller = createCaller(ctx)
    await caller.review({ id: 'task-1', approved: false, note: '需要修改' })
    expect(mockTaskService.review).toHaveBeenCalledWith('task-1', false, '需要修改')
  })

  it('publish 发布已审核任务', async () => {
    const caller = createCaller(ctx)
    const result = await caller.publish({ id: 'task-1' })
    expect(mockTaskService.publish).toHaveBeenCalledWith('task-1')
    expect(result.status).toBe('PUBLISHED')
  })

  // M2 §3.3：闭环两态进入任务筛选器（看板之外的任务列表也要能筛出闭环任务）
  it('list 接受 awaiting_verification 状态过滤', async () => {
    const caller = createCaller(ctx)
    await caller.list({ status: 'awaiting_verification' })
    expect(mockTaskService.list).toHaveBeenCalledWith('w1', 'AWAITING_VERIFICATION')
  })

  it('list 接受 verified 状态过滤', async () => {
    const caller = createCaller(ctx)
    await caller.list({ status: 'verified' })
    expect(mockTaskService.list).toHaveBeenCalledWith('w1', 'VERIFIED')
  })

  it('list 拒绝未知状态值', async () => {
    const caller = createCaller(ctx)
    await expect(caller.list({ status: 'archived' as any })).rejects.toThrow()
  })
})

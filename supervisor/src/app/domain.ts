import { z } from 'zod'

export const TaskStatusSchema = z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'done'])
export const AttemptStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'interrupted', 'killed'])
export const WorkerStateSchema = z.enum(['starting', 'running', 'exited', 'killed', 'lost'])
export const OutboxStatusSchema = z.enum(['pending', 'done', 'failed'])
export const CommandOutcomeSchema = z.enum(['applied', 'rejected'])

export type TaskStatus = z.infer<typeof TaskStatusSchema>
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>
export type WorkerState = z.infer<typeof WorkerStateSchema>
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>

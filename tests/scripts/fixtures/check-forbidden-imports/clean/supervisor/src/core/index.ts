// @ts-nocheck
import { engine } from './engine.ts'
import { createHash } from 'node:crypto'
export const version = 1
export const digest = (input: string) => createHash('sha256').update(input).digest('hex')

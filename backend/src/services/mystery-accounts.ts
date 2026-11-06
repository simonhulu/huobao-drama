import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HuashengAccountsService, type HuashengAccountDriver, type HuashengAccountsOptions } from './huasheng-accounts.js'
import { SocialUploadAccountsService } from './social-upload-accounts.js'

const root = fileURLToPath(new URL('../../../data/mystery-stories/accounts/', import.meta.url))
export type MysteryHuashengAccountDriver = HuashengAccountDriver
export type MysteryHuashengAccountsOptions = Omit<HuashengAccountsOptions, 'scope' | 'legacyConfig'>

/** Each account owns its Chrome profile and port. No process-global account switch. */
export class MysteryHuashengAccountsService extends HuashengAccountsService {
  constructor(options: MysteryHuashengAccountsOptions = {}) { super({ ...options, scope: 'mystery' }) }
}

let huasheng: MysteryHuashengAccountsService | undefined
let baijiahao: SocialUploadAccountsService | undefined
export function getMysteryHuashengAccountsService() { return huasheng ??= new MysteryHuashengAccountsService() }
export function getMysteryBaijiahaoAccountsService() {
  return baijiahao ??= new SocialUploadAccountsService({ stateRoot: path.join(root, 'baijiahao'), accountPrefix: 'mystery' })
}

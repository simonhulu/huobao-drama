import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HuashengAccountsService, type HuashengAccountDriver, type HuashengAccountsOptions } from './huasheng-accounts.js'
import { SocialUploadAccountsService } from './social-upload-accounts.js'

const root = fileURLToPath(new URL('../../../data/science-pop/accounts/', import.meta.url))
export type ScienceHuashengAccountDriver = HuashengAccountDriver
export type ScienceHuashengAccountsOptions = Omit<HuashengAccountsOptions, 'scope' | 'legacyConfig'>

/** Each account owns its Chrome profile and port. No process-global account switch. */
export class ScienceHuashengAccountsService extends HuashengAccountsService {
  constructor(options: ScienceHuashengAccountsOptions = {}) { super({ ...options, scope: 'science' }) }
}

let huasheng: ScienceHuashengAccountsService | undefined
let baijiahao: SocialUploadAccountsService | undefined
export function getScienceHuashengAccountsService() { return huasheng ??= new ScienceHuashengAccountsService() }
export function getScienceBaijiahaoAccountsService() {
  return baijiahao ??= new SocialUploadAccountsService({ stateRoot: path.join(root, 'baijiahao'), accountPrefix: 'science' })
}

/** Only a definite refusal before acceptance may select another paid provider. */
export class ASRProviderUnavailableError extends Error {}

export function asrProviderError(provider:string,status:number,detail:string,apiKey:string,canFallback:boolean) {
  const safe=apiKey?detail.replaceAll(apiKey,'[redacted]'):detail
  const refused=[401,402,403,429].includes(status)
    || /insufficient|balance|quota|credit|rate.?limit|throttl|unauthor|invalid.?api.?key|authentication|余额|额度|配额|限流|认证/i.test(detail)
  const ErrorType=canFallback&&refused?ASRProviderUnavailableError:Error
  return new ErrorType(`${provider} ASR ${status}: ${safe}`)
}

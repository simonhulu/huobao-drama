type ImageBatch = {
  work: (()=>Promise<unknown>)[]
  next: number
  active: number
  failed: boolean
  error?: unknown
  results: unknown[]
  finish: (results:unknown[],failed:boolean,error?:unknown)=>void
}

/** Two provider slots shared by every job in one runner. A failed batch drains
 * already submitted work before rejecting; its unstarted requests are skipped. */
export function createMotionImageQueue() {
  const ready:ImageBatch[]=[]
  let active=0
  function finish(batch:ImageBatch) {
    if(!batch.active && (batch.failed || batch.next===batch.work.length))batch.finish(batch.results,batch.failed,batch.error)
  }
  function pump() {
    while(active<2 && ready.length) {
      const batch=ready.shift()!
      if(batch.failed){finish(batch);continue}
      const index=batch.next++
      active++;batch.active++
      // Rotate batches, so a long job cannot monopolize all later slots.
      if(batch.next<batch.work.length)ready.push(batch)
      void Promise.resolve().then(batch.work[index]).then(value=>{batch.results[index]=value},error=>{
        if(!batch.failed){batch.failed=true;batch.error=error}
      }).finally(()=>{active--;batch.active--;finish(batch);pump()})
    }
  }
  return {
    run<T>(work:(()=>Promise<T>)[]):Promise<T[]> {
      if(!work.length)return Promise.resolve([])
      return new Promise<T[]>((resolve,reject)=>{
        ready.push({work,next:0,active:0,failed:false,results:[],finish:(results,failed,error)=>failed?reject(error):resolve(results as T[])})
        pump()
      })
    },
  }
}

/** Node-only host adapter. Real DO concurrency is tested with local workerd. */
export class DurableObject<Env = unknown> {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
}

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  accountId?: string;
  sourceId?: string;
  jobId?: string;
  evidenceBudgetOverride?: boolean;
  taskId?: string;
  batchId?: string;
  componentId?: string;
  operationId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(
  context: RequestContext,
  action: () => T,
): T {
  return requestContext.run(context, action);
}

export function currentRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

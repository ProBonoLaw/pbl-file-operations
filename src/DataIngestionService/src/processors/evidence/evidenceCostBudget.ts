import {createHash, randomUUID} from "node:crypto";
import {BlobServiceClient} from "@azure/storage-blob";
import {createBlobServiceClient, storageAccountName} from "../../storage.js";
import {z} from "zod";
import {currentRequestContext, type RequestContext} from "../../requestContext.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.union([z.string(), z.number()]).transform(String)
  .refine(value => /^\d+(?:\.\d{1,6})?$/.test(value), "Expected nonnegative USD with at most six decimal places");
export function usdMicros(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  const result = Number(BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")));
  if (!Number.isSafeInteger(result)) throw new Error("USD amount is too large");
  return result;
}
const priceSchema = z.object({
  origin:z.string().url(), deployment:z.string().min(1),
  kind:z.enum(["responses", "router", "messages", "embeddings"]),
  inputUsdPerMillion:decimal, outputUsdPerMillion:decimal,
  uncachedInputUsdPerMillion:decimal.optional(),
  cacheReadUsdPerMillion:decimal.optional(),
  cacheWriteUsdPerMillion:decimal.optional(),
  routerFeeUsdPerMillion:decimal.optional(),
  allowedModels:z.array(z.string().min(1)).min(1).optional(),
  maxInputTokens:integer.refine(value => value > 0),
  maxOutputTokens:integer,
}).strict();
const preflightSchema=z.object({estimatedThoroughUsdPerPage:decimal,
  referenceCharactersPerPage:integer.refine(value=>value>0)}).strict();
const configSchema = z.object({
  version:z.literal(1), currency:z.literal("USD"),
  validUntil:z.string().datetime(), pricingSource:z.string().url(),
  reservationMaxAgeMs:integer.refine(value => value > 0).default(3_600_000),
  limits:z.array(z.object({accountId:z.string().min(1), sourceId:z.string().min(1),
    budgetId:z.string().min(1), limitUsd:decimal}).strict()).min(1),
  prices:z.array(priceSchema).min(1),
}).strict();
export type EvidenceBudgetConfig = z.infer<typeof configSchema>;
export type EvidenceBudgetPrice = z.infer<typeof priceSchema>;
export function evidenceBudgetPreflightConfig(raw=process.env.EVIDENCE_BUDGET_PREFLIGHT_CONFIG) {
  if(!raw?.trim())return null;
  try {
    const config=preflightSchema.parse(JSON.parse(raw));
    if(usdMicros(config.estimatedThoroughUsdPerPage)<=0)throw new Error("Estimate must be positive");
    return config;
  } catch {
    throw new EvidenceBudgetError("evidence_budget_configuration","Invalid evidence budget preflight configuration");
  }
}
export interface BudgetScope {accountId:string; sourceId:string; budgetId:string; sessionId:string}
export class EvidenceBudgetError extends Error {
  constructor(readonly code:"evidence_budget_exhausted"|"evidence_budget_busy"|"evidence_budget_unavailable"|"evidence_budget_configuration", message: string) {
    super(message); this.name = "EvidenceBudgetError";
  }
}
export function budgetErrorCode(error: unknown): EvidenceBudgetError["code"] | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown): EvidenceBudgetError["code"] | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const row = value as {code?:unknown;cause?:unknown;error?:unknown};
    if (typeof row.code === "string" && ["evidence_budget_exhausted", "evidence_budget_busy", "evidence_budget_unavailable", "evidence_budget_configuration"].includes(row.code))
      return row.code as EvidenceBudgetError["code"];
    return visit(row.cause) ?? visit(row.error);
  };
  return visit(error);
}
export function evidenceBudgetConfig(raw = process.env.EVIDENCE_COST_BUDGET_CONFIG): EvidenceBudgetConfig | null {
  if (!raw?.trim()) return null;
  try {
    const config = configSchema.parse(JSON.parse(raw));
    if (config.limits.some(row => usdMicros(row.limitUsd) <= 0)) throw new Error("Budget must be positive");
    if (new Set(config.limits.map(row => hash([row.accountId,row.sourceId]))).size !== config.limits.length)
      throw new Error("Duplicate budget scope");
    for (const price of config.prices) {
      if (new URL(price.origin).origin !== price.origin || !price.origin.startsWith("https://")) throw new Error("Expected HTTPS origin");
      if (!usdMicros(price.inputUsdPerMillion) || (price.kind !== "embeddings" && (!price.maxOutputTokens || !usdMicros(price.outputUsdPerMillion))))
        throw new Error("Incomplete model price");
      for (const rate of [price.uncachedInputUsdPerMillion,price.cacheReadUsdPerMillion,price.cacheWriteUsdPerMillion])
        if (rate !== undefined && usdMicros(rate) > usdMicros(price.inputUsdPerMillion))
          throw new Error("Input category rate exceeds reservation ceiling");
      if (price.kind === "embeddings" && (price.uncachedInputUsdPerMillion || price.cacheReadUsdPerMillion || price.cacheWriteUsdPerMillion))
        throw new Error("Embeddings do not report cache categories");
      if (price.kind === "embeddings" && (price.maxOutputTokens || usdMicros(price.outputUsdPerMillion))) throw new Error("Embeddings cannot generate output tokens");
      if (price.kind === "router" && (!price.allowedModels?.length || !price.routerFeeUsdPerMillion || !usdMicros(price.routerFeeUsdPerMillion)))
        throw new Error("Router needs a pinned model set and a router fee");
      if (price.kind !== "router" && (price.allowedModels || price.routerFeeUsdPerMillion))
        throw new Error("Router fields require a router deployment");
    }
    if (new Set(config.prices.map(row => hash([row.origin,row.deployment,row.kind]))).size !== config.prices.length)
      throw new Error("Duplicate deployment price");
    return config;
  } catch {
    throw new EvidenceBudgetError("evidence_budget_configuration", "Invalid evidence cost budget configuration");
  }
}
export function selectedEvidenceBudget(context = currentRequestContext(), config?: EvidenceBudgetConfig | null) {
  let stopped:unknown;
  try {stopped=JSON.parse(process.env.EVIDENCE_STOPPED_SESSION_IDS ?? "[]");}
  catch {throw new EvidenceBudgetError("evidence_budget_configuration","Invalid stopped evidence session configuration");}
  if (!Array.isArray(stopped) || stopped.some(id=>typeof id!=="string" || !id))
    throw new EvidenceBudgetError("evidence_budget_configuration","Invalid stopped evidence session configuration");
  if (context?.jobId && stopped.includes(context.jobId))
    throw new EvidenceBudgetError("evidence_budget_exhausted","Evidence session was stopped by an operator");
  if (context?.evidenceBudgetOverride === true) return null;
  config ??= evidenceBudgetConfig();
  if (!config) return null;
  if (!context?.accountId || !context.sourceId)
    throw new EvidenceBudgetError("evidence_budget_configuration", "Budgeted requests require account/source identity");
  const limit = config.limits.find(row => row.accountId === context.accountId && row.sourceId === context.sourceId);
  if (!limit) return null;
  if (!context.jobId)
    throw new EvidenceBudgetError("evidence_budget_configuration", "Budgeted requests require an evidence session ID");
  if (Date.parse(config.validUntil) <= Date.now()) throw new EvidenceBudgetError("evidence_budget_configuration", "Evidence price configuration has expired");
  // Ingestion, queued tasks, and retries of this job share one spending window.
  // A new ingestion event gets a new session even for the same account/source.
  const scope:BudgetScope = {accountId:context.accountId,sourceId:context.sourceId,
    budgetId:limit.budgetId,sessionId:context.jobId};
  // A rollout cannot reset spending or silently change the prices of an active run.
  return {scope, limitMicros:usdMicros(limit.limitUsd), fingerprint:hash({version:config.version,limit,prices:config.prices}), config};
}
export function tokenCostMicros(tokens: number, usdPerMillion: string): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid token count");
  const value = Number((BigInt(tokens) * BigInt(usdMicros(usdPerMillion)) + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(value)) throw new Error("Token cost is too large");
  return value;
}
const entrySchema = z.object({reservedMicros:integer, chargedMicros:integer.optional(),
  settlementKind:z.enum(["usage", "maximum", "rejected-input"]).optional(),
  createdAt:integer, abandoned:z.boolean().optional()}).strict();
const ledgerSchema = z.object({
  version:z.literal(1), scope:z.object({accountId:z.string(),sourceId:z.string(),budgetId:z.string(),
    sessionId:z.string()}).strict(),
  limitMicros:integer, fingerprint:z.string(), blocked:z.boolean(),
  entries:z.record(entrySchema),
}).strict();
export type BudgetLedger = z.infer<typeof ledgerSchema>;
export interface BudgetLedgerStore {
  read(key:string):Promise<{ledger:BudgetLedger;etag:string}|null>;
  write(key:string, ledger:BudgetLedger, etag:string|null):Promise<boolean>;
}
export class BlobBudgetLedgerStore implements BudgetLedgerStore {
  private readonly container;
  private initialized?:Promise<void>;
  constructor(blobs:BlobServiceClient = createBlobServiceClient()) {
    this.container=blobs
      .getContainerClient(process.env.EVIDENCE_BUDGET_CONTAINER || "file-operations-evidence-budgets");
  }
  private ready() {
    return this.initialized ??= this.container.createIfNotExists().then(()=>undefined).catch(error=>{this.initialized=undefined;throw error;});
  }
  async read(key:string) {
    await this.ready();
    try {
      const download=await this.container.getBlobClient(key+".json").download();
      const chunks:Buffer[]=[];
      for await(const chunk of download.readableStreamBody!) chunks.push(Buffer.from(chunk));
      if (!download.etag) throw new Error("Budget ledger has no ETag");
      return {ledger:ledgerSchema.parse(JSON.parse(Buffer.concat(chunks).toString())),etag:download.etag};
    } catch(error) {if ((error as {statusCode?:number})?.statusCode===404)return null;throw error;}
  }
  async write(key:string, ledger:BudgetLedger, etag:string|null) {
    await this.ready();
    try {
      await this.container.getBlockBlobClient(key+".json").uploadData(Buffer.from(JSON.stringify(ledger)), {
        conditions:etag ? {ifMatch:etag} : {ifNoneMatch:"*"},blobHTTPHeaders:{blobContentType:"application/json"},
      });
      return true;
    } catch(error) {if ([409,412].includes((error as {statusCode:number})?.statusCode))return false;throw error;}
  }
}
type Selection = NonNullable<ReturnType<typeof selectedEvidenceBudget>>;
export class EvidenceCostBudget {
  constructor(private readonly store:BudgetLedgerStore, private readonly now:()=>number = Date.now) {}
  private async update<T>(selection:Selection, apply:(ledger:BudgetLedger)=>T):Promise<T> {
    const key=hash(selection.scope);
    try {
      for(let attempt=0;attempt<32;attempt++) {
        const stored=await this.store.read(key);
        const ledger=stored ? ledgerSchema.parse(stored.ledger) : {version:1 as const,scope:selection.scope,
          limitMicros:selection.limitMicros,fingerprint:selection.fingerprint,blocked:false,entries:{}};
        if(hash(ledger.scope)!==key || ledger.fingerprint!==selection.fingerprint || ledger.limitMicros!==selection.limitMicros)
          throw new EvidenceBudgetError("evidence_budget_configuration","Budget identity/configuration changed for an existing run");
        let held = 0;
        for (const entry of Object.values(ledger.entries)) {
          if ((entry.chargedMicros ?? 0) > entry.reservedMicros)
            throw new EvidenceBudgetError("evidence_budget_configuration", "Invalid stored budget settlement");
          // A crashed worker must not hold other workers in a busy loop forever.
          // Expiration charges the entire bound; it never returns money to the run.
          if (entry.chargedMicros === undefined && this.now() - entry.createdAt >= selection.config.reservationMaxAgeMs) {
            entry.chargedMicros = entry.reservedMicros;
            entry.settlementKind = "maximum";
            entry.abandoned = true;
          }
          held += entry.chargedMicros ?? entry.reservedMicros;
        }
        if (!Number.isSafeInteger(held) || held > ledger.limitMicros)
          throw new EvidenceBudgetError("evidence_budget_configuration", "Invalid stored budget balance");
        const result=apply(ledger);
        if(await this.store.write(key,ledger,stored?.etag??null))return result;
      }
      throw new Error("Budget ledger contention");
    } catch(error) {
      if(error instanceof EvidenceBudgetError)throw error;
      throw new EvidenceBudgetError("evidence_budget_unavailable","Cannot acknowledge durable evidence budget ownership");
    }
  }
  async reserve(selection:Selection, amount:number):Promise<string> {
    if(!Number.isSafeInteger(amount)||amount<=0)throw new EvidenceBudgetError("evidence_budget_configuration","Invalid request cost bound");
    const id=randomUUID();
    const result=await this.update(selection,ledger=>{
      if(ledger.blocked)return "exhausted";
      const entries=Object.values(ledger.entries);
      const committed=entries.reduce((n,e)=>n+(e.chargedMicros??0),0);
      const outstanding=entries.reduce((n,e)=>n+(e.chargedMicros===undefined?e.reservedMicros:0),0);
      if(committed+amount>ledger.limitMicros){ledger.blocked=true;return "exhausted";}
      if(committed+outstanding+amount>ledger.limitMicros)return "busy";
      ledger.entries[id]={reservedMicros:amount,createdAt:this.now()};
      return "reserved";
    });
    if(result!=="reserved")throw new EvidenceBudgetError(result==="busy"?"evidence_budget_busy":"evidence_budget_exhausted",
      result==="busy"?"Outstanding model requests hold the remaining evidence budget":"Evidence run cannot fund another bounded request");
    return id;
  }
  async settle(selection:Selection,id:string,cost:number,kind:"usage"|"maximum"|"rejected-input"="usage"):Promise<void> {
    const exceeded = await this.update(selection,ledger=>{
      const entry=ledger.entries[id];
      if(!entry||!Number.isSafeInteger(cost)||cost<0)throw new EvidenceBudgetError("evidence_budget_configuration","Invalid budget settlement");
      if(cost>entry.reservedMicros){ledger.blocked=true;return true;}
      if(entry.abandoned)return false; // Retain the full charge even if usage arrives late.
      if(entry.chargedMicros!==undefined) {
        if(entry.chargedMicros!==cost || entry.settlementKind!==undefined && entry.settlementKind!==kind)
          throw new EvidenceBudgetError("evidence_budget_configuration","Conflicting budget settlement");
        return;
      }
      entry.chargedMicros=cost;
      entry.settlementKind=kind;
    });
    if (exceeded) throw new EvidenceBudgetError("evidence_budget_configuration","Provider usage exceeded its configured request bound");
  }
  async block(selection:Selection):Promise<void> {
    await this.update(selection,ledger=>{ledger.blocked=true;});
  }
  async availableMicros(selection:Selection):Promise<number> {
    return this.update(selection,ledger=>{
      if(ledger.blocked)throw new EvidenceBudgetError("evidence_budget_exhausted","Evidence session budget is exhausted");
      const held=Object.values(ledger.entries).reduce((total,entry)=>total+(entry.chargedMicros??entry.reservedMicros),0);
      return ledger.limitMicros-held;
    });
  }
  async assertOpen(context:RequestContext):Promise<void> {
    const selected=selectedEvidenceBudget(context);
    if(!selected)return;
    await this.update(selected,ledger=>{
      if(ledger.blocked)throw new EvidenceBudgetError("evidence_budget_exhausted","Evidence run budget is exhausted");
    });
  }
}
let shared:{account:string;container:string|undefined;budget:EvidenceCostBudget}|undefined;
export function evidenceCostBudget():EvidenceCostBudget {
  let account:string;
  try { account=storageAccountName(); }
  catch { throw new EvidenceBudgetError("evidence_budget_configuration","Evidence budget storage account is required"); }
  const container=process.env.EVIDENCE_BUDGET_CONTAINER;
  if(!shared||shared.account!==account||shared.container!==container)
    shared={account,container,budget:new EvidenceCostBudget(new BlobBudgetLedgerStore())};
  return shared.budget;
}
